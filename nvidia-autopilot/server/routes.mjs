import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { ROOT } from "./config.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readJson(req, limit = 6 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error("Request body too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
}

function openSse(res, { onClose } = {}) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 15_000);
  heartbeat.unref?.();
  const close = () => {
    clearInterval(heartbeat);
    onClose?.();
    if (!res.writableEnded) res.end();
  };
  res.on("close", close);
  return {
    send(event, data) {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close,
  };
}

function serveStatic(req, res, pathname) {
  const webRoot = join(ROOT, "web");
  const relative = pathname === "/" ? "index.html" : normalize(pathname).replace(/^([/\\])+/, "");
  const file = join(webRoot, relative);
  if (!file.startsWith(webRoot) || !existsSync(file) || !statSync(file).isFile()) {
    return false;
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": type,
    "Cache-Control": extname(file) === ".html" ? "no-store" : "public, max-age=60",
  });
  createReadStream(file).pipe(res);
  return true;
}

export function createApp(runtime, { broadcast = () => {} } = {}) {
  const { nim, store, retrieval, autopilot, metrics, loadModels, config } = runtime;

  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const regex = new RegExp(
      `^${pattern.replace(/:[a-zA-Z]+/g, (match) => {
        keys.push(match.slice(1));
        return "([^/]+)";
      })}$`,
    );
    routes.push({ method, regex, keys, handler });
  };

  /* --------------------------------- status --------------------------------- */

  route("GET", "/api/health", async () => ({ status: "ok", uptimeSeconds: Math.round(process.uptime()) }));

  route("GET", "/api/status", async () => {
    const models = await loadModels();
    const knowledge = await retrieval.stats();
    const runs = store.listRuns();
    return {
      config: config.public(),
      metrics,
      modelCount: models.models.length,
      modelsDegraded: Boolean(models.degraded),
      modelError: models.error ?? null,
      roles: runtime.activeRoles(),
      knowledge,
      runs: {
        total: runs.length,
        active: runs.filter((run) => ["queued", "planning", "executing", "awaiting_approval", "paused", "reporting"].includes(run.status)).length,
      },
      node: process.version,
    };
  });

  route("GET", "/api/settings", async () => ({
    ...config.public(),
    roleOverrides: config.read().roleOverrides ?? {},
  }));

  route("PUT", "/api/settings", async ({ body }) => {
    const patch = {};
    if (typeof body.apiKey === "string") patch.apiKey = body.apiKey.trim();
    if (typeof body.simulation === "boolean") patch.simulation = body.simulation;
    if (typeof body.nimBaseUrl === "string" && body.nimBaseUrl.trim()) patch.nimBaseUrl = body.nimBaseUrl.trim();
    if (typeof body.genaiBaseUrl === "string" && body.genaiBaseUrl.trim()) patch.genaiBaseUrl = body.genaiBaseUrl.trim();
    if (body.pricing && typeof body.pricing === "object") {
      patch.pricing = {
        inputPerMTok: Number(body.pricing.inputPerMTok) || null,
        outputPerMTok: Number(body.pricing.outputPerMTok) || null,
      };
    }
    if (body.roleOverrides && typeof body.roleOverrides === "object") patch.roleOverrides = body.roleOverrides;
    config.write(patch);
    return { ...config.public(), roleOverrides: config.read().roleOverrides ?? {} };
  });

  route("POST", "/api/settings/test", async () => {
    const startedAt = Date.now();
    const response = await nim.listModels();
    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      modelCount: response.data?.length ?? 0,
      simulated: Boolean(response.simulated),
    };
  });

  /* --------------------------------- models --------------------------------- */

  route("GET", "/api/models", async ({ query }) => {
    const models = await loadModels({ force: query.get("refresh") === "1" });
    return {
      models: models.models,
      roles: runtime.activeRoles(),
      roleDefinitions: Object.fromEntries(
        Object.entries(runtime.rolesCatalog).map(([role, definition]) => [
          role,
          {
            label: definition.label,
            title: definition.title,
            description: definition.description,
            capability: definition.capability,
          },
        ]),
      ),
      simulated: models.simulated ?? config.load().simulation,
      degraded: Boolean(models.degraded),
      error: models.error ?? null,
      cached: Boolean(models.cached),
    };
  });

  /* ------------------------------- inference -------------------------------- */

  route("POST", "/api/chat", async ({ body }) => {
    const signal = AbortSignal.timeout(config.load().requestTimeoutMs);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) throw Object.assign(new Error("messages[] is required"), { status: 422 });
    const model = String(body.model || runtime.activeRoles().operator.model);
    const response = await nim.chat({
      model,
      messages,
      temperature: body.temperature,
      topP: body.topP,
      maxTokens: body.maxTokens,
      tools: body.tools === false ? undefined : body.tools,
      responseFormat: body.json ? { type: "json_object" } : undefined,
      extra: body.extra,
      intent: body.intent ?? "chat",
      signal,
    });
    return response;
  });

  route("POST", "/api/chat/stream", async ({ body, req, res }) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) throw Object.assign(new Error("messages[] is required"), { status: 422 });
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    const sse = openSse(res, { onClose: () => controller.abort() });
    const model = String(body.model || runtime.activeRoles().operator.model);
    try {
      sse.send("start", { model, simulated: config.load().simulation });
      for await (const event of nim.chatStream({
        model,
        messages,
        temperature: body.temperature,
        topP: body.topP,
        maxTokens: body.maxTokens,
        tools: body.tools === false ? undefined : body.tools,
        extra: body.extra,
        intent: body.intent ?? "chat",
        signal: controller.signal,
      })) {
        sse.send(event.type, event);
      }
      sse.send("end", { ok: true });
    } catch (error) {
      sse.send("error", { message: error?.message ?? String(error), hint: error?.hint ?? "" });
    } finally {
      sse.close();
    }
    return undefined;
  });

  route("POST", "/api/complete", async ({ body }) => {
    if (!body.prompt) throw Object.assign(new Error("prompt is required"), { status: 422 });
    return nim.complete({
      model: String(body.model || runtime.activeRoles().analyst.model),
      prompt: String(body.prompt),
      maxTokens: body.maxTokens,
      temperature: body.temperature,
    });
  });

  route("POST", "/api/embeddings", async ({ body }) => {
    if (!body.input) throw Object.assign(new Error("input is required"), { status: 422 });
    return nim.embed({
      model: String(body.model || runtime.activeRoles().embedder.model),
      input: body.input,
      inputType: body.inputType === "passage" ? "passage" : "query",
    });
  });

  route("POST", "/api/rerank", async ({ body }) => {
    const passages = Array.isArray(body.passages) ? body.passages : [];
    if (!body.query || !passages.length) {
      throw Object.assign(new Error("query and passages[] are required"), { status: 422 });
    }
    const response = await nim.rerank({
      model: String(body.model || runtime.activeRoles().reranker.model),
      query: String(body.query),
      passages: passages.map((passage) => (typeof passage === "string" ? { text: passage } : passage)),
    });
    const ranked = (response.rankings ?? [])
      .map((ranking) => ({ ...ranking, text: passages[ranking.index]?.text ?? passages[ranking.index] ?? "" }))
      .sort((a, b) => b.logit - a.logit);
    return { ...response, ranked };
  });

  route("POST", "/api/images", async ({ body }) => {
    const prompt = String(body.prompt ?? "").trim();
    if (!prompt) throw Object.assign(new Error("prompt is required"), { status: 422 });
    const [width, height] = String(body.size ?? "1024x1024").split("x").map((value) => Number(value) || 1024);
    return nim.image({
      model: String(body.model || runtime.activeRoles().artist.model),
      prompt,
      width,
      height,
      steps: Number(body.steps) || undefined,
      seed: Number(body.seed) || 0,
    });
  });

  route("POST", "/api/guardrails", async ({ body }) => {
    const text = String(body.text ?? "").trim();
    if (!text) throw Object.assign(new Error("text is required"), { status: 422 });
    return nim.safetyCheck({ text, model: body.model ? String(body.model) : undefined });
  });

  route("POST", "/api/raw", async ({ body }) => {
    if (!body.path) throw Object.assign(new Error("path is required (for example /v1/ranking)"), { status: 422 });
    return nim.raw({ path: String(body.path), method: body.method === "GET" ? "GET" : "POST", body: body.body });
  });

  /* -------------------------------- knowledge ------------------------------- */

  route("GET", "/api/knowledge", async () => retrieval.stats());

  route("POST", "/api/knowledge", async ({ body }) => {
    const text = String(body.text ?? "").trim();
    if (!text) throw Object.assign(new Error("text is required"), { status: 422 });
    const document = store.addKnowledgeDocument({
      title: String(body.title ?? "").trim() || undefined,
      text,
      source: body.source === "run" ? "run" : "upload",
    });
    return { document, ...(await retrieval.stats()) };
  });

  route("DELETE", "/api/knowledge/:id", async ({ params }) => {
    store.removeKnowledgeDocument(params.id);
    return retrieval.stats();
  });

  route("POST", "/api/knowledge/index", async () => {
    const result = await retrieval.indexPending({ embedModel: runtime.activeRoles().embedder.model });
    return { ...result, ...(await retrieval.stats()) };
  });

  route("POST", "/api/knowledge/search", async ({ body }) => {
    const query = String(body.query ?? "").trim();
    if (!query) throw Object.assign(new Error("query is required"), { status: 422 });
    return retrieval.search(query, {
      topK: Math.min(Math.max(Number(body.topK) || 5, 1), 20),
      embedModel: runtime.activeRoles().embedder.model,
      rerankModel: runtime.activeRoles().reranker.model,
      useRerank: body.rerank !== false,
    });
  });

  /* -------------------------------- autopilot ------------------------------- */

  route("GET", "/api/autopilot", async () => ({ runs: autopilot.list() }));

  route("POST", "/api/autopilot", async ({ body }) => {
    const run = await autopilot.start({
      goal: body.goal,
      company: body.company,
      options: { ...(body.options ?? {}), companyContext: body.companyContext ?? body.options?.companyContext },
    });
    return { run };
  });

  route("GET", "/api/autopilot/:id", async ({ params }) => {
    const run = autopilot.get(params.id);
    if (!run) throw Object.assign(new Error("Run not found"), { status: 404 });
    return {
      run,
      artifacts: store.listArtifacts(params.id),
      active: autopilot.isActive(params.id),
      events: store.readEvents(params.id, { since: 0, limit: 500 }),
    };
  });

  route("GET", "/api/autopilot/:id/events", async ({ params, query }) => {
    const run = autopilot.get(params.id);
    if (!run) throw Object.assign(new Error("Run not found"), { status: 404 });
    return {
      events: store.readEvents(params.id, { since: Number(query.get("since")) || 0 }),
      status: run.status,
      usage: run.usage,
    };
  });

  route("GET", "/api/autopilot/:id/stream", async ({ params, req, res }) => {
    const run = autopilot.get(params.id);
    if (!run) throw Object.assign(new Error("Run not found"), { status: 404 });
    const sse = openSse(res);
    const since = Number(new URL(req.url, "http://localhost").searchParams.get("since")) || 0;
    // Subscribe before replaying so nothing is lost between the read and the
    // attach; live frames are buffered until the replay has been written.
    let replayed = false;
    const pendingFrames = [];
    let seen = since;
    const emit = (kind, payload) => {
      if (kind === "event") {
        const seq = payload?.seq ?? 0;
        if (seq && seq <= since) return;
        if (seq) {
          if (seq <= seen) return;
          seen = seq;
        }
      }
      if (!replayed) {
        pendingFrames.push([kind, payload]);
        return;
      }
      sse.send(kind, payload);
    };
    const unsubscribe = store.subscribe(params.id, (message) => {
      if (message.type === "event") emit("event", message.event);
      else emit("state", message.run);
    });
    for (const event of store.readEvents(params.id, { since, limit: 1000 })) {
      if ((event.seq ?? 0) > seen) seen = event.seq;
      sse.send("event", event);
    }
    sse.send("state", autopilot.get(params.id));
    replayed = true;
    for (const [kind, payload] of pendingFrames) sse.send(kind, payload);
    pendingFrames.length = 0;
    req.on("close", unsubscribe);
    res.on("close", unsubscribe);
    return undefined;
  });

  route("POST", "/api/autopilot/:id/pause", async ({ params }) => {
    const run = autopilot.pause(params.id);
    if (!run) throw Object.assign(new Error("Run not found"), { status: 404 });
    return { run };
  });

  route("POST", "/api/autopilot/:id/resume", async ({ params }) => {
    const run = autopilot.resume(params.id);
    if (!run) throw Object.assign(new Error("Run not found"), { status: 404 });
    return { run };
  });

  route("POST", "/api/autopilot/:id/cancel", async ({ params }) => {
    const run = autopilot.cancel(params.id);
    if (!run) throw Object.assign(new Error("Run not found"), { status: 404 });
    return { run };
  });

  route("POST", "/api/autopilot/:id/approve", async ({ params, body }) => {
    const result = autopilot.approve(params.id, {
      approved: body.approved !== false,
      note: body.note,
    });
    if (!result) throw Object.assign(new Error("Run not found"), { status: 404 });
    return result;
  });

  route("DELETE", "/api/autopilot/:id", async ({ params }) => {
    const deleted = store.deleteRun(params.id);
    if (!deleted) throw Object.assign(new Error("Run not found"), { status: 404 });
    return { deleted: true };
  });

  route("GET", "/api/autopilot/:id/artifacts/:name", async ({ params, res }) => {
    const run = autopilot.get(params.id);
    if (!run) throw Object.assign(new Error("Run not found"), { status: 404 });
    const content = store.readArtifact(params.id, params.name);
    if (!content) throw Object.assign(new Error("Artifact not found"), { status: 404 });
    const type = MIME[extname(params.name).toLowerCase()] ?? "text/plain; charset=utf-8";
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": content.length,
      "Content-Disposition": `inline; filename="${params.name.replace(/"/g, "")}"`,
    });
    res.end(content);
    return undefined;
  });

  /* --------------------------------- served --------------------------------- */

  route("GET", "/api/stream", async ({ req, res }) => {
    const sse = openSse(res);
    sse.send("hello", { at: new Date().toISOString() });
    const unsubscribe = broadcast.subscribe((event) => sse.send("event", event));
    req.on("close", unsubscribe);
    return undefined;
  });

  return async function handle(req, res) {
    metrics.requests += 1;
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (!pathname.startsWith("/api/")) {
      if (req.method === "GET" && serveStatic(req, res, pathname)) return;
      if (req.method === "GET" && serveStatic(req, res, "/index.html")) return;
      sendJson(res, 404, { error: "Not found" });
      return;
    }

    for (const entry of routes) {
      if (entry.method !== req.method) continue;
      const match = entry.regex.exec(pathname);
      if (!match) continue;
      const params = Object.fromEntries(entry.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
      try {
        const body = ["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "") ? await readJson(req) : {};
        const result = await entry.handler({ req, res, params, query: url.searchParams, body });
        if (result !== undefined && !res.writableEnded) sendJson(res, 200, result);
      } catch (error) {
        const status = error?.status ?? (error?.name === "AbortError" ? 499 : 500);
        if (!res.writableEnded) {
          sendJson(res, status, {
            error: error?.message ?? "Unexpected error",
            code: error?.code ?? null,
            hint: error?.hint ?? null,
            body: error?.body ?? null,
          });
        }
      }
      return;
    }
    sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  };
}
