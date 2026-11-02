#!/usr/bin/env node
/**
 * Paperclip × NVIDIA NIM — server entrypoint.
 *
 * Zero runtime dependencies. One Node process serves the API, the SSE stream,
 * the static UI and runs the agent engine. Always binds 0.0.0.0 so preview
 * proxies and containers work without extra configuration.
 */

import { createServer } from "node:http";
import { ensureDirs, publicConfig, runMigrations } from "./config.mjs";
import { createApp } from "./routes.mjs";
import { createRuntime } from "./runtime.mjs";

ensureDirs();
runMigrations();

const runtime = createRuntime();
runtime.service.ensureSeed();
// Budgeting is opt-in: existing companies with caps are moved to unlimited once.
runtime.service.removeBudgetLimits();
runtime.startSchedulers();

const handler = createApp(runtime);

const server = createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    console.error("[server]", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error?.message ?? "Internal error" }));
    } else {
      res.end();
    }
  });
});

const config = publicConfig();
const port = Number(process.env.PORT ?? config.port ?? 8790);

server.listen(port, "0.0.0.0", async () => {
  const live = runtime.catalog.live ? "live" : "snapshot";
  console.log("");
  console.log("  ✂  Paperclip × NVIDIA NIM");
  console.log(`  ├─ listening   http://0.0.0.0:${port}`);
  console.log(`  ├─ mode        ${config.mode.toUpperCase()}${config.mode === "simulation" ? "  (no key — deterministic simulator)" : `  (key ${config.keyHint})`}`);
  console.log(`  ├─ NIM base    ${config.baseUrl}`);
  console.log(`  ├─ models      ${runtime.catalog.models.length} in catalog (${live})`);
  console.log(`  └─ data        ${config.paths.data}`);
  console.log("");
  await runtime.refreshCatalog({ force: true }).catch(() => null);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} — flushing state`);
  runtime.engine.stopAll();
  runtime.store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => shutdown(signal));

process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
