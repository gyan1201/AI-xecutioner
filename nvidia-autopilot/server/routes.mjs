import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { ROOT } from "./config.mjs";
import { maskKey, parseCredentialText, pickDefaultModel, verifyCredential } from "./keyintake.mjs";

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
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".pdf": "application/pdf",
};

function normalizeEndpoint(value, fallback) {
  const raw = String(value ?? "").trim();
  if (!raw) return fallback;
  return raw
    .replace(/\/+$/, "")
    .replace(/\/(chat\/completions|completions|embeddings|ranking|models)$/i, "")
    .replace(/\/+$/, "");
}

function uniqueValues(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
}

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
  const { nim, store, retrieval, autopilot, company, paperclip, metrics, loadModels, config } = runtime;

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
      companies: (() => {
        const list = company.list();
        return {
          total: list.length,
          active: list.filter((entry) => entry.status === "active").length,
          agents: list.reduce((sum, entry) => sum + entry.counts.agents, 0),
          openIssues: list.reduce((sum, entry) => sum + entry.counts.open, 0),
          autoMode: list.filter((entry) => entry.autoMode?.enabled).length,
          spentCents: list.reduce((sum, entry) => sum + entry.counts.spentCents, 0),
        };
      })(),
      node: process.version,
      defaultModel: runtime.defaultChatModel?.() ?? null,
    };
  });

  route("GET", "/api/settings", async () => {
    const runtimeSettings = config.read();
    return {
      ...config.public(),
      roleOverrides: runtimeSettings.roleOverrides ?? {},
      defaults: runtimeSettings.defaults ?? {},
      pastedModels: runtimeSettings.pastedModels ?? [],
      keyMeta: runtimeSettings.keyMeta ?? {},
      defaultModel: runtime.defaultChatModel?.() ?? null,
    };
  });

  /**
   * Credential intake: accepts a bare key, an `NVIDIA_API_KEY=` line, or a whole
   * SDK/curl snippet, extracts the key + endpoints + models + request params,
   * verifies the key against NVIDIA, then configures the app.
   *
   * Live inference is only switched on when verification succeeds (or when the
   * caller asks for it explicitly), so a bad paste or an offline host can never
   * brick the app.
   */
  route("POST", "/api/settings/key", async ({ body }) => {
    const text =
      typeof body.text === "string"
        ? body.text
        : typeof body.snippet === "string"
          ? body.snippet
          : typeof body.apiKey === "string"
            ? body.apiKey
            : "";
    if (!text.trim()) {
      throw Object.assign(new Error("Paste your NVIDIA key or the request snippet that contains it."), {
        status: 422,
        hint: "Anything works: `nvapi-…`, `NVIDIA_API_KEY=nvapi-…`, or the whole python/curl example.",
      });
    }

    const parsed = parseCredentialText(text);
    const explicitKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const apiKey = explicitKey || parsed.apiKey;
    if (!apiKey) {
      throw Object.assign(new Error("No NVIDIA API key found in that text."), {
        status: 422,
        hint: parsed.warnings[0] ?? "Look for an `nvapi-…` token in the snippet.",
        body: { warnings: parsed.warnings },
      });
    }

    const current = config.load();
    const nimBaseUrl = normalizeEndpoint(body.nimBaseUrl || parsed.nimBaseUrl || current.nimBaseUrl, current.nimBaseUrl);
    const genaiBaseUrl = normalizeEndpoint(body.genaiBaseUrl || parsed.genaiBaseUrl || current.genaiBaseUrl, current.genaiBaseUrl);

    const verification =
      body.verify === false
        ? { attempted: false, ok: false, status: 0, reason: "skipped", hint: "Verification skipped at the caller's request.", latencyMs: 0 }
        : await verifyCredential({ apiKey, baseUrl: nimBaseUrl, timeoutMs: Number(body.timeoutMs) || 12_000 });

    const requestedMode = ["auto", "live", "simulation"].includes(body.mode) ? body.mode : "auto";
    const simulation =
      requestedMode === "simulation" ? true : requestedMode === "live" ? false : verification.ok ? false : current.simulation;

    const existing = config.read();
    const defaults = { ...(existing.defaults ?? {}) };
    if (parsed.models.length) defaults.chatModel = pickDefaultModel(parsed, parsed.models);
    if (Object.keys(parsed.params).length) defaults.params = { ...(existing.defaults?.params ?? {}), ...parsed.params };
    if (parsed.flags?.vision) defaults.vision = true;
    if (parsed.flags?.reasoningEffortUnsupported) delete defaults.reasoningEffort;

    const pastedModels = uniqueValues([...(existing.pastedModels ?? []), ...parsed.models]).slice(-24);
    const keyMeta = {
      ...(existing.keyMeta ?? {}),
      source: parsed.source === "key" ? "pasted" : "pasted-snippet",
      addedAt: new Date().toISOString(),
      verified: Boolean(verification.ok),
      verifyReason: verification.reason ?? null,
      keyHint: maskKey(apiKey),
      modelCount: verification.modelCount ?? 0,
      baseUrl: nimBaseUrl,
    };

    config.write({
      apiKey,
      nimBaseUrl,
      genaiBaseUrl,
      simulation,
      defaults,
      pastedModels,
      keyMeta,
    });

    const models = await runtime.refreshModels();
    const notes = [];
    if (verification.ok) notes.push(`Key verified — ${verification.modelCount} models available on this account.`);
    else if (verification.reason === "unreachable") {
      notes.push("Key saved, but this host cannot reach NVIDIA yet, so simulation stays on. Switch to live once the network allows it.");
    } else if (verification.reason === "skipped") notes.push("Key saved without verification.");
    else notes.push(`Key saved, but NVIDIA did not accept it (${verification.reason}). Simulation stays on.`);
    if (defaults.chatModel) notes.push(`Default chat model set to ${defaults.chatModel}.`);
    if (parsed.params && Object.keys(parsed.params).length) {
      notes.push(`Request defaults applied: ${Object.keys(parsed.params).join(", ")}.`);
    }
    if (parsed.flags?.vision) notes.push("Snippet uses vision — image attachments will be offered in Chat lab.");

    return {
      applied: true,
      live: !config.load().simulation,
      parsed: {
        source: parsed.source,
        keyHint: parsed.keyHint,
        nimBaseUrl,
        genaiBaseUrl,
        models: parsed.models,
        params: parsed.params,
        flags: parsed.flags,
        warnings: parsed.warnings,
      },
      verification,
      notes,
      modelCount: models.models.length,
      config: config.public(),
    };
  });

  /** Re-test the stored (or supplied) credential without changing anything. */
  route("POST", "/api/settings/key/verify", async ({ body }) => {
    const current = config.load();
    const apiKey = String(body.apiKey ?? "").trim() || current.apiKey;
    const baseUrl = normalizeEndpoint(body.nimBaseUrl || current.nimBaseUrl, current.nimBaseUrl);
    const verification = await verifyCredential({ apiKey, baseUrl, timeoutMs: Number(body.timeoutMs) || 12_000 });
    if (verification.ok && body.apply === true) {
      config.write({ simulation: false });
      await runtime.refreshModels();
    }
    return { verification, live: !config.load().simulation, config: config.public() };
  });

  route("PUT", "/api/settings", async ({ body }) => {
    const patch = {};
    if (typeof body.apiKey === "string") {
      patch.apiKey = body.apiKey.trim();
      const previous = config.read().keyMeta ?? {};
      patch.keyMeta = patch.apiKey
        ? { ...previous, source: "manual", addedAt: new Date().toISOString(), verified: false, keyHint: maskKey(patch.apiKey), verifyReason: "unverified" }
        : {};
      if (!patch.apiKey) {
        // The pasted models and request defaults came in with that credential.
        patch.pastedModels = [];
        patch.defaults = {};
      }
    }
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
    if (body.paperclip && typeof body.paperclip === "object") {
      const current = config.read().paperclip ?? {};
      const next = { ...current };
      if (typeof body.paperclip.baseUrl === "string") next.baseUrl = body.paperclip.baseUrl.trim();
      if (typeof body.paperclip.token === "string") next.token = body.paperclip.token.trim();
      if (body.paperclip.runId !== undefined) next.runId = String(body.paperclip.runId ?? "").trim();
      patch.paperclip = next;
    }
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
      defaultModel: runtime.defaultChatModel?.() ?? models.defaultModel ?? null,
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
    const model = String(body.model || runtime.defaultChatModel?.() || runtime.activeRoles().operator.model);
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
    const model = String(body.model || runtime.defaultChatModel?.() || runtime.activeRoles().operator.model);
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

  /* --------------------------------- company -------------------------------- */

  route("GET", "/api/companies", async () => ({ companies: company.list() }));

  route("POST", "/api/companies", async ({ body }) => {
    const created = await company.createCompany({
      name: body.name,
      goal: body.goal,
      constraints: body.constraints,
      size: Number(body.size) || undefined,
      budgetMonthlyCents: Number(body.budgetMonthlyCents) || 0,
      settings: body.settings ?? {},
    });
    return { company: created, summary: runtime.company.get(created.id).summary };
  });

  route("GET", "/api/companies/:id", async ({ params }) => company.get(params.id));

  route("PATCH", "/api/companies/:id", async ({ params, body }) => ({
    company: company.updateCompany(params.id, body),
  }));

  route("DELETE", "/api/companies/:id", async ({ params }) => ({ deleted: company.deleteCompany(params.id) }));

  route("POST", "/api/companies/:id/agents", async ({ params, body }) => ({
    company: company.hire(params.id, body),
  }));

  route("PATCH", "/api/companies/:id/agents/:agentId", async ({ params, body }) => ({
    company: company.updateAgent(params.id, params.agentId, body),
  }));

  route("DELETE", "/api/companies/:id/agents/:agentId", async ({ params }) => ({
    company: company.fire(params.id, params.agentId),
  }));

  route("POST", "/api/companies/:id/issues", async ({ params, body }) => company.createIssue(params.id, body));

  route("PATCH", "/api/companies/:id/issues/:issueId", async ({ params, body }) =>
    company.updateIssue(params.id, params.issueId, body),
  );

  route("POST", "/api/companies/:id/issues/:issueId/comments", async ({ params, body }) => {
    const text = String(body.body ?? "").trim();
    if (!text) throw Object.assign(new Error("body is required"), { status: 422 });
    return company.commentOnIssue(params.id, params.issueId, text, "board");
  });

  route("POST", "/api/companies/:id/cycles", async ({ params, body }) => {
    if (body?.async) {
      const pending = company.runCycle(params.id, { trigger: "manual" }).catch(() => {});
      void pending;
      return { started: true, company: company.get(params.id).company };
    }
    const result = await company.runCycle(params.id, { trigger: "manual" });
    return { cycle: result.cycle, company: result.company, summary: runtime.company.get(params.id).summary };
  });

  route("POST", "/api/companies/:id/auto", async ({ params, body }) => {
    if (body.enabled === false) {
      company.stopAutoMode(params.id, body.reason ?? "Turned off by the operator");
      return { company: company.get(params.id).company };
    }
    const updated = company.startAutoMode(params.id, {
      everyMinutes: body.everyMinutes,
      maxCycles: body.maxCycles,
    });
    return { company: updated };
  });

  route("POST", "/api/companies/:id/approvals/:approvalId", async ({ params, body }) => {
    if (typeof body.approved !== "boolean") {
      throw Object.assign(new Error("approved must be true or false"), { status: 422 });
    }
    return company.decideApproval(params.id, params.approvalId, { approved: body.approved, note: body.note });
  });

  route("GET", "/api/companies/:id/events", async ({ params, query }) => {
    const detail = company.get(params.id);
    const since = query.get("since");
    if (!since) return { events: detail.events, company: detail.company };
    const threshold = new Date(since).getTime();
    return { events: detail.events.filter((event) => new Date(event.at).getTime() > threshold), company: detail.company };
  });

  route("GET", "/api/companies/:id/stream", async ({ params, req, res }) => {
    const detail = company.get(params.id);
    const sse = openSse(res);
    sse.send("state", detail.company);
    for (const event of detail.events.slice(-80)) sse.send("event", event);
    const unsubscribe = company.companies.subscribe(params.id, (message) => {
      if (message.type === "event") sse.send("event", message.event);
      else sse.send("state", message.company);
    });
    req.on("close", unsubscribe);
    res.on("close", unsubscribe);
    return undefined;
  });

  route("GET", "/api/companies/:id/export", async ({ params, res }) => {
    const detail = company.get(params.id);
    const bundle = {
      schemaVersion: 1,
      source: "nvidia-autopilot",
      exportedAt: new Date().toISOString(),
      company: detail.company,
      artifacts: detail.artifacts,
      summary: detail.summary,
    };
    const payload = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, "utf8");
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": payload.length,
      "Content-Disposition": `attachment; filename="${detail.company.name.replace(/[^\w.-]+/g, "-")}-bundle.json"`,
    });
    res.end(payload);
    return undefined;
  });

  route("GET", "/api/companies/:id/artifacts/:name", async ({ params, res }) => {
    const content = company.artifacts.read(params.id, params.name);
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

  /* -------------------------------- paperclip ------------------------------- */

  route("POST", "/api/paperclip/probe", async ({ body }) => paperclip.probe({ baseUrl: body.baseUrl, token: body.token }));

  route("POST", "/api/paperclip/mirror", async ({ body }) => {
    const detail = company.get(body.companyId);
    const result = await paperclip.mirror(detail.company, {
      dryRun: body.dryRun !== false,
      existingCompanyId: body.existingCompanyId ?? null,
      baseUrl: body.baseUrl,
      token: body.token,
    });
    if (!result.dryRun) {
      const updated = company.companies.get(body.companyId);
      updated.paperclip = {
        baseUrl: body.baseUrl ?? paperclip.settings().baseUrl,
        companyId: result.created.companyId,
        mirroredAt: new Date().toISOString(),
        agents: result.created.agents.length,
        goals: result.created.goals.length,
        issues: result.created.issues.length,
      };
      company.companies.save(updated);
      company.companies.log(updated, {
        type: "paperclip.mirrored",
        actor: "board",
        message: `Mirrored to Paperclip company ${result.created.companyId}`,
      });
      return { ...result, company: updated };
    }
    return result;
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
        // Never hand Node an invalid status code: a thrown error without a
        // status (or with a bogus one) must still produce a response.
        const raw = Number(error?.status ?? (error?.name === "AbortError" ? 499 : 500));
        const status = Number.isInteger(raw) && raw >= 200 && raw <= 599 ? raw : 500;
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
