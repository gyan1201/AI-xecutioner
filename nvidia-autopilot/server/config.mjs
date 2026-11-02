import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runtime configuration.
 *
 * Precedence: explicit runtime settings (data/settings.json, written by the UI)
 * > environment variables > defaults. Keys are never logged or returned to the
 * browser; /api/settings only reports whether one is present and its last 4
 * characters.
 */
const DEFAULTS = {
  nimBaseUrl: "https://integrate.api.nvidia.com/v1",
  genaiBaseUrl: "https://ai.api.nvidia.com/v1/genai",
  port: 8787,
  simulation: null, // null = auto (simulate only when no key is configured)
  requestTimeoutMs: 180_000,
  maxConcurrency: 4,
  pricing: { inputPerMTok: null, outputPerMTok: null },
};

function envBoolean(value) {
  if (value == null || value === "") return null;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function envNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function dataDir() {
  return resolve(process.env.NVIDIA_AUTOPILOT_DATA_DIR || join(ROOT, "data"));
}

export const paths = {
  data: dataDir(),
  runs: join(dataDir(), "runs"),
  companies: join(dataDir(), "companies"),
  settings: join(dataDir(), "settings.json"),
  keys: join(dataDir(), "keys.json"),
  knowledge: join(dataDir(), "knowledge"),
};

export function ensureDataDirs() {
  for (const dir of [paths.data, paths.runs, paths.companies, paths.knowledge]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function readRuntimeSettings() {
  try {
    if (!existsSync(paths.settings)) return {};
    const parsed = JSON.parse(readFileSync(paths.settings, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function secureWrite(file, payload) {
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
}

/* ------------------------------- key vault -------------------------------- */
/**
 * Keys are kept in `data/keys.json` (0600), separate from settings so the vault
 * can hold several credentials — one per account, region or rotation — while
 * only one is active. Nothing here is ever returned unmasked.
 */
export function readVault() {
  try {
    if (!existsSync(paths.keys)) return { keys: [], activeId: null };
    const parsed = JSON.parse(readFileSync(paths.keys, "utf8"));
    const keys = Array.isArray(parsed?.keys) ? parsed.keys.filter((entry) => entry && entry.apiKey) : [];
    return { keys, activeId: parsed?.activeId ?? keys[0]?.id ?? null };
  } catch {
    return { keys: [], activeId: null };
  }
}

export function writeVault(vault) {
  ensureDataDirs();
  secureWrite(paths.keys, { keys: vault.keys ?? [], activeId: vault.activeId ?? null });
  return readVault();
}

export function maskApiKey(value) {
  const key = String(value ?? "");
  if (!key) return null;
  return key.length <= 8 ? "••••" : `••••${key.slice(-4)}`;
}

function publicKeyRecord(entry) {
  return {
    id: entry.id,
    label: entry.label,
    keyHint: entry.keyHint ?? maskApiKey(entry.apiKey),
    source: entry.source ?? "pasted",
    baseUrl: entry.baseUrl ?? null,
    addedAt: entry.addedAt ?? null,
    verified: Boolean(entry.verified),
    verifyReason: entry.verifyReason ?? null,
    modelCount: entry.modelCount ?? 0,
    lastVerifiedAt: entry.lastVerifiedAt ?? null,
  };
}

/** Add or refresh a key. Returns the masked record. */
export function addVaultKey({ apiKey, label, baseUrl, source = "pasted", verified = false, verifyReason = null, modelCount = 0 }) {
  const value = String(apiKey ?? "").trim();
  if (!value) throw Object.assign(new Error("Cannot store an empty key."), { status: 422 });
  const vault = readVault();
  const existing = vault.keys.find((entry) => entry.apiKey === value);
  const now = new Date().toISOString();
  if (existing) {
    existing.baseUrl = baseUrl ?? existing.baseUrl;
    existing.verified = verified || existing.verified;
    existing.verifyReason = verifyReason ?? existing.verifyReason;
    existing.modelCount = modelCount || (existing.modelCount ?? 0);
    existing.lastVerifiedAt = now;
    if (label) existing.label = String(label).slice(0, 80);
    vault.activeId = vault.activeId ?? existing.id;
    writeVault(vault);
    return publicKeyRecord(existing);
  }
  const record = {
    id: randomUUID(),
    label: String(label || `key ${maskApiKey(value)}`).slice(0, 80),
    apiKey: value,
    keyHint: maskApiKey(value),
    source,
    baseUrl: baseUrl ?? null,
    addedAt: now,
    verified: Boolean(verified),
    verifyReason,
    modelCount,
    lastVerifiedAt: verified ? now : null,
  };
  vault.keys.push(record);
  vault.activeId = vault.activeId ?? record.id;
  writeVault(vault);
  return publicKeyRecord(record);
}

export function removeVaultKey(id) {
  const vault = readVault();
  const next = vault.keys.filter((entry) => entry.id !== id);
  if (next.length === vault.keys.length) return null;
  const activeId = vault.activeId === id ? next[0]?.id ?? null : vault.activeId;
  writeVault({ keys: next, activeId });
  return { removed: id, remaining: next.length };
}

export function activateVaultKey(id) {
  const vault = readVault();
  const record = vault.keys.find((entry) => entry.id === id);
  if (!record) return null;
  writeVault({ ...vault, activeId: id });
  return publicKeyRecord(record);
}

export function vaultSummary() {
  const vault = readVault();
  const active = vault.keys.find((entry) => entry.id === vault.activeId) ?? vault.keys[0] ?? null;
  return {
    count: vault.keys.length,
    verified: vault.keys.filter((entry) => entry.verified).length,
    activeId: active?.id ?? null,
    activeHint: active?.keyHint ?? maskApiKey(active?.apiKey) ?? null,
    keys: vault.keys.map(publicKeyRecord),
  };
}

/** settings key > active vault key > environment. */
export function resolvedCredential() {
  const runtime = readRuntimeSettings();
  const fromSettings = String(runtime.apiKey ?? "").trim();
  if (fromSettings) return { apiKey: fromSettings, source: "settings", keyId: null };
  const vault = readVault();
  const active = vault.keys.find((entry) => entry.id === vault.activeId) ?? vault.keys[0] ?? null;
  if (active?.apiKey) return { apiKey: active.apiKey, source: "vault", keyId: active.id };
  const fromEnv = String(process.env.NVIDIA_API_KEY ?? "").trim();
  if (fromEnv) return { apiKey: fromEnv, source: "env", keyId: null };
  return { apiKey: "", source: "none", keyId: null };
}

/**
 * Keys pasted before the vault existed live in settings.json. Copy them in once
 * so the database is complete and the UI can list/rotate them.
 */
export function migrateLegacyKey() {
  const runtime = readRuntimeSettings();
  const key = String(runtime.apiKey ?? "").trim();
  if (!key) return null;
  const vault = readVault();
  if (vault.keys.some((entry) => entry.apiKey === key)) return null;
  const meta = runtime.keyMeta ?? {};
  return addVaultKey({
    apiKey: key,
    label: meta.source ? `imported (${meta.source})` : "imported from settings",
    baseUrl: runtime.nimBaseUrl ?? null,
    source: "settings-migration",
    verified: Boolean(meta.verified),
    verifyReason: meta.verifyReason ?? null,
    modelCount: meta.modelCount ?? 0,
  });
}

export function writeRuntimeSettings(patch) {
  ensureDataDirs();
  const next = { ...readRuntimeSettings(), ...patch };
  writeFileSync(paths.settings, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(paths.settings, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return next;
}

/**
 * @returns {{
 *   apiKey: string,
 *   hasApiKey: boolean,
 *   simulation: boolean,
 *   nimBaseUrl: string,
 *   genaiBaseUrl: string,
 *   port: number,
 *   requestTimeoutMs: number,
 *   maxConcurrency: number,
 *   pricing: {inputPerMTok: number|null, outputPerMTok: number|null},
 * }}
 */
export function loadConfig() {
  const runtime = readRuntimeSettings();
  const credential = resolvedCredential();
  const apiKey = credential.apiKey;
  const envSimulation = envBoolean(process.env.NIM_SIMULATION);
  const runtimeSimulation = typeof runtime.simulation === "boolean" ? runtime.simulation : null;
  const explicit = runtimeSimulation ?? envSimulation;
  return {
    apiKey,
    keySource: credential.source,
    keyId: credential.keyId,
    hasApiKey: apiKey.length > 0,
    // Simulation is available on demand, and is the default when no key exists
    // so the whole product (including auto mode) can be explored offline.
    simulation: explicit ?? apiKey.length === 0,
    nimBaseUrl: String(runtime.nimBaseUrl || process.env.NVIDIA_BASE_URL || DEFAULTS.nimBaseUrl).replace(/\/+$/, ""),
    genaiBaseUrl: String(
      runtime.genaiBaseUrl || process.env.NVIDIA_GENAI_BASE_URL || DEFAULTS.genaiBaseUrl,
    ).replace(/\/+$/, ""),
    port: envNumber(runtime.port || process.env.PORT, DEFAULTS.port),
    requestTimeoutMs: envNumber(process.env.NVIDIA_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    maxConcurrency: envNumber(process.env.NVIDIA_MAX_CONCURRENCY, DEFAULTS.maxConcurrency),
    pricing: {
      inputPerMTok:
        envNumber(process.env.NVIDIA_PRICE_INPUT_PER_MTOK, null) ??
        envNumber(runtime.pricing?.inputPerMTok, null),
      outputPerMTok:
        envNumber(process.env.NVIDIA_PRICE_OUTPUT_PER_MTOK, null) ??
        envNumber(runtime.pricing?.outputPerMTok, null),
    },
  };
}

export function paperclipSettings() {
  const runtime = readRuntimeSettings();
  const paperclip = runtime.paperclip ?? {};
  return {
    baseUrl: String(paperclip.baseUrl || process.env.PAPERCLIP_API_BASE || "").replace(/\/+$/, ""),
    token: String(paperclip.token || process.env.PAPERCLIP_API_KEY || ""),
  };
}

export function publicConfig(config = loadConfig()) {
  return {
    nimBaseUrl: config.nimBaseUrl,
    genaiBaseUrl: config.genaiBaseUrl,
    simulation: config.simulation,
    hasApiKey: config.hasApiKey,
    keyHint: config.apiKey ? `••••${config.apiKey.slice(-4)}` : null,
    keySource: config.keySource ?? null,
    needsApiKey: !config.hasApiKey,
    keys: (() => {
      const vault = vaultSummary();
      return { count: vault.count, verified: vault.verified, activeId: vault.activeId, activeHint: vault.activeHint };
    })(),
    pricing: config.pricing,
    maxConcurrency: config.maxConcurrency,
    paperclip: (() => {
      const current = paperclipSettings();
      return {
        configured: Boolean(current.baseUrl && current.token),
        baseUrl: current.baseUrl || null,
        tokenHint: current.token ? `••••${current.token.slice(-4)}` : null,
      };
    })(),
  };
}
