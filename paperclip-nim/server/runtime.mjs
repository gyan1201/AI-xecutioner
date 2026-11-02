/**
 * Runtime composition root.
 *
 * One place where the store, the NIM client, the engine and the service are
 * constructed and given to each other. Also owns the live catalog cache and the
 * usage listener that turns model calls into ledger rows.
 */

import { MODEL_CATALOG, catalogSummary, mergeLive } from "./nim/catalog.mjs";
import { createNimClient } from "./nim/client.mjs";
import { currentUsageContext } from "./nim/usage.mjs";
import { runtimeConfig } from "./config.mjs";
import { createEngine } from "./domain/engine.mjs";
import { createService } from "./domain/service.mjs";
import { createEventBus, createStore } from "./store.mjs";

export function createRuntime({ logger = console } = {}) {
  const bus = createEventBus();
  const store = createStore({ bus });

  const nim = createNimClient({
    getConfig: runtimeConfig,
    logger,
    onUsage: (event) => {
      const context = currentUsageContext();
      try {
        context?.sink?.(event);
      } catch (error) {
        logger.warn?.("[usage] sink failed", error?.message);
      }
      bus.publish({
        type: "usage",
        companyId: context?.companyId ?? null,
        payload: {
          model: event.model,
          endpoint: event.endpoint,
          latencyMs: event.latencyMs,
          costCents: event.cost.cents,
          usage: event.usage,
          simulated: event.simulated,
          runId: context?.runId ?? null,
          agentId: context?.agentId ?? null,
        },
      });
    },
  });

  const engine = createEngine({ store, nim, bus });
  const service = createService({ store, nim, engine, bus });

  const catalog = {
    models: MODEL_CATALOG,
    syncedAt: null,
    live: false,
    error: null,
    summary: catalogSummary(MODEL_CATALOG),
  };

  async function refreshCatalog({ force = false } = {}) {
    if (catalog.live && !force) return catalog;
    try {
      const { models, latencyMs } = await nim.listModels();
      const merged = mergeLive(models.map((model) => ({ id: model.id, owned_by: model.ownedBy })));
      catalog.models = merged.models;
      catalog.syncedAt = merged.syncedAt;
      catalog.live = true;
      catalog.error = null;
      catalog.summary = catalogSummary(merged.models);
      catalog.latencyMs = latencyMs;
      bus.publish({ type: "catalog.synced", payload: { count: merged.models.length, liveCount: merged.liveCount } });
    } catch (error) {
      catalog.error = error?.message ?? "Could not reach /v1/models";
      catalog.errorCode = error?.code ?? "error";
      catalog.live = false;
      catalog.summary = catalogSummary(catalog.models);
    }
    return catalog;
  }

  function startSchedulers() {
    for (const summary of store.listCompanies()) {
      const company = store.getCompany(summary.id);
      if (company?.settings?.autoMode) engine.startAuto(company.id);
    }
    // Clear runs orphaned by a restart, then keep watching for them.
    engine.reapStaleRuns();
    const reaper = setInterval(() => {
      try {
        engine.reapStaleRuns();
      } catch (error) {
        logger.warn?.("[reaper]", error?.message);
      }
    }, 60_000);
    reaper.unref?.();
  }

  return {
    bus,
    store,
    nim,
    engine,
    service,
    catalog,
    refreshCatalog,
    startSchedulers,
  };
}
