import { createNim } from "./nim.mjs";
import { createStore } from "./store.mjs";
import { createRetrieval } from "./retrieval.mjs";
import { createAutopilot } from "./autopilot.mjs";
import { createCompanyService } from "./company/service.mjs";
import { createPaperclipClient } from "./paperclip.mjs";
import { loadConfig, migrateLegacyKey, writeRuntimeSettings, readRuntimeSettings, publicConfig } from "./config.mjs";
import { MODEL_CATALOG, MODEL_PRESETS, ROLE_DEFINITIONS, describeModel, resolveRoles } from "./catalog.mjs";
import { pickDefaultModel } from "./keyintake.mjs";

/**
 * Wires the services together and owns the short-lived model cache, role
 * overrides and call counters that the HTTP layer reads.
 */
export function createRuntime({ onEvent } = {}) {
  // Keys pasted before the vault existed are moved into it once, on boot.
  try {
    migrateLegacyKey();
  } catch {
    /* never block startup on key bookkeeping */
  }
  const store = createStore();
  const metrics = {
    startedAt: new Date().toISOString(),
    requests: 0,
    errors: 0,
    calls: 0,
    lastError: null,
    lastCallAt: null,
  };

  const nim = createNim({
    getConfig: loadConfig,
    onEvent: (event) => {
      if (event.kind === "usage" || event.kind === "request" || event.kind === "image") {
        metrics.calls += 1;
        metrics.lastCallAt = new Date().toISOString();
      }
      if (event.kind === "error") {
        metrics.errors += 1;
        metrics.lastError = { status: event.status ?? null, at: new Date().toISOString() };
      }
      onEvent?.(event);
    },
  });

  const retrieval = createRetrieval({ nim, store });
  let modelCache = { at: 0, models: [], roles: null, error: null };

  async function loadModels({ force = false } = {}) {
    const config = loadConfig();
    const fresh = force || Date.now() - modelCache.at < 60_000;
    if (modelCache.models.length && fresh) {
      return { ...modelCache, cached: true };
    }
    try {
      const response = await nim.listModels();
      const models = (response.data ?? []).map((entry) => describeModel(entry.id, { ownedBy: entry.owned_by }));
      // Models named in a pasted snippet are usable even when discovery cannot
      // see them (offline host, preview key, brand-new release).
      const runtime = readRuntimeSettings();
      for (const id of runtime.pastedModels ?? []) {
        if (typeof id !== "string" || !id.includes("/")) continue;
        if (models.some((model) => model.id === id)) continue;
        models.push(describeModel(id, { ownedBy: String(id).split("/")[0], pasted: true }));
      }
      const ids = models.map((model) => model.id);
      const roles = resolveRoles(ids);
      const overrides = runtime.roleOverrides ?? {};
      for (const [role, model] of Object.entries(overrides)) {
        if (roles[role] && model) {
          roles[role] = { ...roles[role], model: String(model), resolvedFrom: "operator" };
        }
      }
      modelCache = {
        at: Date.now(),
        models,
        roles,
        error: null,
        simulated: Boolean(response.simulated),
        defaultModel: pickDefaultModel({ models: runtime.pastedModels ?? [] }, ids),
      };
      return { ...modelCache, cached: false };
    } catch (error) {
      if (modelCache.models.length) return { ...modelCache, error: error.message, cached: true };
      // Discovery failed and nothing cached: fall back to curated presets so the
      // UI still renders and roles still resolve.
      const models = MODEL_CATALOG.map((preset) => describeModel(preset.id));
      const roles = resolveRoles(models.map((model) => model.id));
      modelCache = { at: 0, models, roles, error: error.message, degraded: true };
      return { ...modelCache, cached: false };
    }
  }

  /** Model the operator configured by pasting a key/snippet, if any. */
  function defaultChatModel() {
    const runtime = readRuntimeSettings();
    return runtime.defaults?.chatModel ?? runtime.pastedModels?.[0] ?? null;
  }

  function activeRoles() {
    const roles = modelCache.roles ?? resolveRoles([]);
    const overrides = readRuntimeSettings().roleOverrides ?? {};
    return Object.fromEntries(
      Object.entries(roles).map(([role, entry]) => [
        role,
        overrides[role] ? { ...entry, model: String(overrides[role]), resolvedFrom: "operator" } : entry,
      ]),
    );
  }

  const autopilot = createAutopilot({
    nim,
    store,
    retrieval,
    resolveActiveRoles: activeRoles,
    getConfig: loadConfig,
  });

  // Company agents resolve role -> model at call time, so operator overrides in
  // Models & routing apply to running companies without a restart.
  const liveRoles = new Proxy(
    {},
    {
      get: (_target, property) => activeRoles()[property],
      has: (_target, property) => Boolean(activeRoles()[property]),
      ownKeys: () => Object.keys(activeRoles()),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    },
  );

  const company = createCompanyService({
    nim,
    store,
    retrieval,
    roles: liveRoles,
    getConfig: loadConfig,
    onEvent,
  });
  company.resumeAutoModes();

  const paperclip = createPaperclipClient({ config: { load: loadConfig, read: readRuntimeSettings } });

  return {
    nim,
    store,
    retrieval,
    autopilot,
    company,
    paperclip,
    defaultChatModel,
    refreshModels: (options = {}) => loadModels({ force: true, ...options }),
    metrics,
    loadModels,
    activeRoles,
    rolesCatalog: ROLE_DEFINITIONS,
    config: { load: loadConfig, public: publicConfig, write: writeRuntimeSettings, read: readRuntimeSettings },
  };
}
