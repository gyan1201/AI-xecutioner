import { createServer } from "node:http";
import { createRuntime } from "./runtime.mjs";
import { createApp } from "./routes.mjs";
import { ensureDataDirs, loadConfig, paths } from "./config.mjs";

/**
 * NVIDIA Autopilot server.
 *
 * One process, zero runtime dependencies: JSON API, SSE streams, static UI and
 * the autopilot engine. Self-hosted by design — see README for deployment notes.
 */

const subscribers = new Set();
const broadcast = {
  subscribe(listener) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  },
  publish(event) {
    for (const listener of subscribers) {
      try {
        listener(event);
      } catch {
        /* a dead SSE client must never break the engine */
      }
    }
  },
};

ensureDataDirs();
const config = loadConfig();
const runtime = createRuntime({
  onEvent: (event) => {
    if (event.kind === "usage" || event.kind === "error") broadcast.publish({ ...event, at: new Date().toISOString() });
  },
});
const handler = createApp(runtime, { broadcast });

const server = createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error?.message ?? "Internal error" }));
    } else {
      res.end();
    }
  });
});

server.listen(config.port, "0.0.0.0", () => {
  const mode = config.simulation ? "SIMULATION (no API key)" : `LIVE · key ${config.apiKey.slice(0, 3)}…${config.apiKey.slice(-4)}`;
  console.log("");
  console.log("  NVIDIA ▲ Autopilot");
  console.log(`  ├─ listening      http://0.0.0.0:${config.port}`);
  console.log(`  ├─ mode           ${mode}`);
  console.log(`  ├─ NIM endpoint   ${config.nimBaseUrl}`);
  console.log(`  └─ data           ${paths.data}`);
  console.log("");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
