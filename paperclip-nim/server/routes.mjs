/**
 * HTTP surface: JSON API + SSE + static UI.
 *
 * No framework, no build step. Routes are declared as [method, pattern, handler]
 * with `:params`; anything not starting with /api is the single-page app.
 */

import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { addVaultKey, ensureDirs, loadSettings, loadVault, paths, publicConfig, removeVaultKey, resolveCredential, saveSettings, setActiveVaultKey, vaultView } from "./config.mjs";
import { CAPABILITIES, MODEL_CATALOG, catalogSummary, findModel, searchModels } from "./nim/catalog.mjs";
import { BLUEPRINTS, blueprintStats, getBlueprint, listBlueprints } from "./nim/blueprints.mjs";
import { loadSkills, searchSkills, skillStats, suggestSkills } from "./nim/skills.mjs";
import { imageContent } from "./nim/client.mjs";
import { parseCredentialText } from "./nim/intake.mjs";
import { addProviderModel, allProviderSummaries, customModels, detectSetup, getProvider, providersView, removeProvider, upsertProvider } from "./nim/providers.mjs";

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
};

const BODY_LIMIT = 12 * 1024 * 1024;

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
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

function openSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  let closed = false;
  const send = (event, data) => {
    if (closed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    res.end();
  };
  return { send, close, get closed() { return closed; } };
}

function matchRoute(routes, method, pathname) {
  const segments = pathname.split("/").filter(Boolean);
  for (const route of routes) {
    if (route.method !== method && route.method !== "*") continue;
    const pattern = route.pattern.split("/").filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let index = 0; index < pattern.length; index += 1) {
      const part = pattern[index];
      if (part.startsWith(":")) params[part.slice(1)] = decodeURIComponent(segments[index]);
      else if (part !== segments[index]) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/* ------------------------------------------------------------------ studio */

const STUDIO_ROUTES = {
  "/api/studio/chat": async ({ body, nim }) => {
    const messages = Array.isArray(body.messages)
      ? body.messages
      : [{ role: "system", content: body.system ?? "You are a helpful NVIDIA NIM assistant." }, { role: "user", content: String(body.prompt ?? body.message ?? "") }];
    const model = body.model ?? undefined;
    const result = await nim.chat({
      model,
      messages,
      temperature: body.temperature,
      maxTokens: body.maxTokens ?? 800,
      tools: Array.isArray(body.tools) ? body.tools : undefined,
      responseFormat: body.json ? { type: "json_object" } : undefined,
      simulateToolCall: false,
    });
    return {
      model: result.model,
      text: result.text,
      reasoning: result.reasoning,
      toolCalls: result.toolCalls,
      usage: result.usage,
      latencyMs: result.latencyMs,
      simulated: result.simulated,
    };
  },
  "/api/studio/embed": async ({ body, nim }) => {
    const input = Array.isArray(body.input) ? body.input : [String(body.input ?? body.text ?? "")];
    const result = await nim.embed({ model: body.model, input, inputType: body.inputType ?? "query" });
    return {
      model: result.model,
      dimensions: result.vectors[0]?.length ?? 0,
      count: result.vectors.length,
      preview: result.vectors.map((vector) => {
        const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
        const top = vector
          .map((value, index) => ({ index, value }))
          .filter((entry) => entry.value !== 0)
          .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
          .slice(0, 8)
          .map((entry) => [entry.index, Number(entry.value.toFixed(4))]);
        return { nonzero: vector.filter((value) => value !== 0).length, norm: Number(norm.toFixed(4)), top };
      }),
      usage: result.usage,
      latencyMs: result.latencyMs,
      simulated: result.simulated,
    };
  },
  "/api/studio/rerank": async ({ body, nim }) => {
    const passages = Array.isArray(body.passages) ? body.passages : String(body.passages ?? "").split("\n").filter(Boolean);
    const result = await nim.rerank({ model: body.model, query: String(body.query ?? ""), passages, topN: body.topN });
    return { ...result, rankings: result.rankings.map((row) => ({ index: row.index, score: row.score, rank: row.rank, passage: String(row.passage).slice(0, 240) })) };
  },
  "/api/studio/image": async ({ body, nim }) => {
    const result = await nim.generateImage({
      model: body.model,
      prompt: String(body.prompt ?? ""),
      negativePrompt: body.negativePrompt,
      width: Number(body.width) || 1024,
      height: Number(body.height) || 1024,
      steps: Number(body.steps) || 30,
      cfgScale: Number(body.cfgScale) || 7,
      seed: body.seed,
    });
    return {
      model: result.model,
      simulated: result.simulated,
      latencyMs: result.latencyMs,
      usage: result.usage,
      artifacts: result.artifacts.map((artifact) => ({
        mimeType: artifact.mimeType,
        dataUri: `data:${artifact.mimeType};base64,${artifact.base64}`,
        width: artifact.width,
        height: artifact.height,
        seed: artifact.seed,
      })),
    };
  },
  "/api/studio/parse": async ({ body, nim }) => {
    if (!body.image) {
      const error = new Error("Upload an image (base64) to parse.");
      error.status = 400;
      throw error;
    }
    const result = await nim.parse({ model: body.model, image: body.image, prompt: body.prompt });
    return { model: result.model, text: result.text, usage: result.usage, latencyMs: result.latencyMs, simulated: result.simulated };
  },
  "/api/studio/translate": async ({ body, nim }) => {
    const result = await nim.translate({ model: body.model, text: String(body.text ?? ""), target: body.target ?? "es", source: body.source ?? "en" });
    return { model: result.model, text: result.text, usage: result.usage, latencyMs: result.latencyMs, simulated: result.simulated, note: result.note };
  },
  "/api/studio/safety": async ({ body, nim }) => {
    const result = await nim.safety({ model: body.model, text: String(body.text ?? "") });
    return result;
  },
  "/api/studio/biology": async ({ body, nim }) => {
    return nim.biology({ model: body.model, task: body.task ?? "protein-structure", payload: body.payload ?? { sequence: body.sequence } });
  },
  "/api/studio/raw": async ({ body, nim }) => {
    return nim.raw({ method: body.method ?? "POST", path: body.path, body: body.body, query: body.query });
  },
};

/* ------------------------------------------------------------------ server */

export function createApp(runtime) {
  const { store, nim, engine, service, bus, catalog, refreshCatalog } = runtime;

  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, pattern, handler });

  const company = (id) => {
    const doc = store.getCompany(id);
    if (!doc) {
      const error = new Error("Company not found");
      error.status = 404;
      throw error;
    }
    return doc;
  };

  /* ---- health + bootstrap ---- */

  add("GET", "/api/health", async () => ({
    ok: true,
    uptimeSeconds: Math.round(process.uptime()),
    mode: publicConfig().mode,
    companies: store.listCompanies().length,
  }));

  add("GET", "/api/bootstrap", async () => {
    service.ensureSeed();
    const base = service.bootstrap();
    return {
      ...base,
      models: { count: catalog.models.length, live: catalog.live },
      config: publicConfig(),
      skills: skillStats(),
      blueprints: blueprintStats(),
      capabilities: CAPABILITIES,
    };
  });

  add("GET", "/api/status", async () => ({
    nim: nim.status(),
    config: publicConfig(),
    catalog: { count: catalog.models.length, live: catalog.live, syncedAt: catalog.syncedAt, error: catalog.error },
    skills: skillStats(),
    blueprints: blueprintStats(),
    companies: store.listCompanies(),
  }));

  /* ---- companies ---- */

  add("GET", "/api/companies", async () => ({ companies: store.listCompanies(), activeCompanyId: loadSettings().activeCompanyId }));

  add("POST", "/api/companies", async ({ body }) => {
    const { company: created, deployed } = await service.createCompany({
      name: body.name,
      mission: body.mission,
      blueprintId: body.blueprintId ?? null,
      budgetMonthlyCents: body.budgetMonthlyCents,
    });
    return { company: service.companyView(created.id), deployed };
  });

  add("GET", "/api/companies/:companyId", async ({ params }) => service.companyView(params.companyId));

  add("PATCH", "/api/companies/:companyId", async ({ params, body }) => service.updateCompany(params.companyId, body));

  add("DELETE", "/api/companies/:companyId", async ({ params }) => {
    store.deleteCompany(params.companyId);
    const next = store.listCompanies()[0];
    if (next) store.setActive(next.id);
    return { ok: true, nextCompanyId: next?.id ?? null };
  });

  add("POST", "/api/companies/:companyId/activate", async ({ params }) => {
    company(params.companyId);
    store.setActive(params.companyId);
    return { ok: true, activeCompanyId: params.companyId };
  });

  add("GET", "/api/companies/:companyId/dashboard", async ({ params }) => service.dashboard(params.companyId));
  add("GET", "/api/companies/:companyId/inbox", async ({ params }) => service.inbox(params.companyId));
  add("GET", "/api/companies/:companyId/ledger", async ({ params }) => service.ledgerView(params.companyId));
  add("GET", "/api/companies/:companyId/org", async ({ params }) => service.orgChart(params.companyId));
  add("GET", "/api/companies/:companyId/export", async ({ params }) => service.exportCompany(params.companyId));

  add("POST", "/api/companies/:companyId/cycle", async ({ params, body, res, req }) => {
    const stream = String(new URL(req.url, "http://localhost").searchParams.get("stream") ?? "") === "1";
    if (!stream) {
      const result = await engine.planCycle({ companyId: params.companyId, maxIssues: Number(body.maxIssues) || 3 });
      return { plan: result.plan, results: result.results, cycle: result.cycle, standup: result.standup, company: service.companyView(params.companyId) };
    }
    const sse = openSse(res);
    try {
      const result = await engine.planCycle({
        companyId: params.companyId,
        maxIssues: Number(body.maxIssues) || 3,
        onDelta: (chunk) => sse.send("delta", { chunk }),
      });
      sse.send("done", { plan: result.plan, results: result.results, cycle: result.cycle, standup: result.standup });
    } catch (error) {
      sse.send("error", { message: error.message, code: error.code ?? "error" });
    } finally {
      sse.close();
    }
    return null;
  });

  add("POST", "/api/companies/:companyId/plan", async ({ params, body }) => {
    const result = await engine.planOnly({ companyId: params.companyId });
    return { plan: result.plan, run: result.run, applied: result.applied };
  });

  add("POST", "/api/companies/:companyId/auto", async ({ params, body }) => {
    const doc = company(params.companyId);
    const enabled = body.enabled === undefined ? !doc.settings.autoMode : Boolean(body.enabled);
    doc.settings.autoMode = enabled;
    store.saveCompany(doc);
    const state = enabled ? engine.startAuto(doc.id) : engine.stopAuto(doc.id);
    bus.publish({ companyId: doc.id, type: "auto.changed", payload: { enabled } });
    return { enabled, ...state };
  });

  add("POST", "/api/companies/:companyId/blueprints/:blueprintId", async ({ params }) => {
    const deployed = await service.deployBlueprint(params.companyId, params.blueprintId);
    return { ...deployed, company: service.companyView(params.companyId) };
  });

  add("POST", "/api/companies/import", async ({ body }) => ({ company: service.importCompany(body) }));

  /* ---- agents ---- */

  add("GET", "/api/companies/:companyId/agents", async ({ params }) => {
    const doc = company(params.companyId);
    return {
      agents: doc.agents.map((agent) => ({
        ...agent,
        spend: service.companyView(doc.id).agents.find((entry) => entry.id === agent.id)?.spend,
        openIssues: doc.issues.filter((issue) => issue.assigneeId === agent.id && !["done", "cancelled"].includes(issue.status)).length,
      })),
    };
  });

  add("POST", "/api/companies/:companyId/agents", async ({ params, body }) => ({ agent: service.addAgent(params.companyId, body) }));
  add("GET", "/api/companies/:companyId/agents/:agentId", async ({ params }) => service.agentDetail(params.companyId, params.agentId));
  add("PATCH", "/api/companies/:companyId/agents/:agentId", async ({ params, body }) => ({ agent: service.updateAgent(params.companyId, params.agentId, body) }));
  add("DELETE", "/api/companies/:companyId/agents/:agentId", async ({ params }) => service.removeAgent(params.companyId, params.agentId));
  add("PUT", "/api/companies/:companyId/agents/:agentId/skills", async ({ params, body }) => ({
    agent: service.setAgentSkills(params.companyId, params.agentId, body.skills ?? []),
  }));

  add("POST", "/api/companies/:companyId/agents/:agentId/chat", async ({ params, body, res }) => {
    const sse = openSse(res);
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    try {
      const result = await engine.chat({
        companyId: params.companyId,
        agentId: params.agentId,
        message: String(body.message ?? ""),
        issueId: body.issueId ?? null,
        signal: controller.signal,
        onDelta: (chunk) => sse.send("delta", { chunk }),
      });
      sse.send("done", {
        text: result.text,
        agent: { id: result.agent.id, name: result.agent.name, title: result.agent.title, model: result.agent.model },
        citations: result.citations.map((passage) => ({ title: passage.title, score: Number(passage.score?.toFixed?.(3) ?? 0) })),
        tools: result.tools,
        run: { id: result.run.id, costCents: result.run.costCents, usage: result.run.usage, simulated: result.run.simulated },
      });
    } catch (error) {
      sse.send("error", { message: error.message, code: error.code ?? "error" });
    } finally {
      sse.close();
    }
    return null;
  });

  /* ---- issues ---- */

  add("GET", "/api/companies/:companyId/issues", async ({ params, query }) => service.listIssues(params.companyId, query));
  add("POST", "/api/companies/:companyId/issues", async ({ params, body }) => ({ issue: service.createIssue(params.companyId, body).issue }));
  add("GET", "/api/companies/:companyId/issues/:issueId", async ({ params }) => service.issueDetail(params.companyId, params.issueId));
  add("PATCH", "/api/companies/:companyId/issues/:issueId", async ({ params, body }) => service.updateIssue(params.companyId, params.issueId, body));
  add("DELETE", "/api/companies/:companyId/issues/:issueId", async ({ params }) => service.deleteIssue(params.companyId, params.issueId));
  add("POST", "/api/companies/:companyId/issues/:issueId/comments", async ({ params, body }) => ({
    comment: service.addComment(params.companyId, params.issueId, { body: body.body }),
  }));

  add("POST", "/api/companies/:companyId/issues/:issueId/run", async ({ params, body, res, req }) => {
    const stream = String(new URL(req.url, "http://localhost").searchParams.get("stream") ?? "") === "1";
    const controller = new AbortController();
    if (!stream) {
      const result = await engine.runIssue({ companyId: params.companyId, issueId: params.issueId, actorId: "human" });
      return {
        run: result.run,
        issue: result.issue,
        verdict: result.verdict,
        blocked: Boolean(result.blocked),
        reason: result.reason ?? null,
        company: service.companyView(params.companyId),
      };
    }
    res.on("close", () => controller.abort());
    const sse = openSse(res);
    try {
      const result = await engine.runIssue({
        companyId: params.companyId,
        issueId: params.issueId,
        actorId: "human",
        signal: controller.signal,
        onDelta: (chunk) => sse.send("delta", { chunk }),
      });
      sse.send("done", {
        run: result.run,
        issue: result.issue,
        verdict: result.verdict ?? null,
        blocked: Boolean(result.blocked),
        reason: result.reason ?? null,
      });
    } catch (error) {
      sse.send("error", { message: error.message, code: error.code ?? "error" });
    } finally {
      sse.close();
    }
    return null;
  });

  /* ---- approvals ---- */

  add("GET", "/api/companies/:companyId/approvals", async ({ params }) => {
    const doc = company(params.companyId);
    return {
      approvals: doc.approvals.map((approval) => ({
        ...approval,
        issue: doc.issues.find((issue) => issue.id === approval.issueId) ?? null,
      })),
    };
  });

  add("POST", "/api/companies/:companyId/approvals/:approvalId/decide", async ({ params, body }) => {
    if (!["approve", "deny"].includes(body.decision)) {
      const error = new Error("decision must be approve or deny");
      error.status = 400;
      throw error;
    }
    return engine.decideApproval({
      companyId: params.companyId,
      approvalId: params.approvalId,
      decision: body.decision,
      by: body.by ?? "you",
      note: body.note ?? "",
    });
  });

  /* ---- goals + projects ---- */

  add("GET", "/api/companies/:companyId/goals", async ({ params }) => {
    const doc = company(params.companyId);
    return {
      goals: doc.goals.map((goal) => ({
        ...goal,
        owner: doc.agents.find((agent) => agent.id === goal.ownerId)?.name ?? null,
        issues: doc.issues.filter((issue) => issue.goalId === goal.id).length,
        done: doc.issues.filter((issue) => issue.goalId === goal.id && issue.status === "done").length,
      })),
    };
  });
  add("POST", "/api/companies/:companyId/goals", async ({ params, body }) => ({ goal: service.upsertGoal(params.companyId, null, body) }));
  add("PATCH", "/api/companies/:companyId/goals/:goalId", async ({ params, body }) => ({ goal: service.upsertGoal(params.companyId, params.goalId, body) }));

  add("GET", "/api/companies/:companyId/projects", async ({ params }) => {
    const doc = company(params.companyId);
    return {
      projects: doc.projects.map((project) => ({
        ...project,
        issues: doc.issues.filter((issue) => issue.projectId === project.id).length,
        open: doc.issues.filter((issue) => issue.projectId === project.id && !["done", "cancelled"].includes(issue.status)).length,
      })),
    };
  });
  add("POST", "/api/companies/:companyId/projects", async ({ params, body }) => ({ project: service.upsertProject(params.companyId, null, body) }));
  add("PATCH", "/api/companies/:companyId/projects/:projectId", async ({ params, body }) => ({ project: service.upsertProject(params.companyId, params.projectId, body) }));

  /* ---- knowledge ---- */

  add("GET", "/api/companies/:companyId/knowledge", async ({ params }) => {
    const doc = company(params.companyId);
    return {
      documents: doc.knowledge.map(({ embedding, ...rest }) => ({ ...rest, chars: rest.body?.length ?? 0 })),
      embedModel: doc.settings.defaultModels?.embedding ?? null,
    };
  });
  add("POST", "/api/companies/:companyId/knowledge", async ({ params, body }) => ({ document: await service.addKnowledge(params.companyId, body) }));
  add("PATCH", "/api/companies/:companyId/knowledge/:docId", async ({ params, body }) => ({ document: service.updateKnowledge(params.companyId, params.docId, body) }));
  add("DELETE", "/api/companies/:companyId/knowledge/:docId", async ({ params }) => service.deleteKnowledge(params.companyId, params.docId));
  add("POST", "/api/companies/:companyId/knowledge/search", async ({ params, body }) => service.knowledgeSearch(params.companyId, body.query, Number(body.topK) || 5));

  /* ---- routines ---- */

  add("GET", "/api/companies/:companyId/routines", async ({ params }) => {
    const doc = company(params.companyId);
    return {
      routines: doc.routines.map((routine) => ({ ...routine, agent: doc.agents.find((agent) => agent.id === routine.agentId)?.name ?? null })),
    };
  });
  add("POST", "/api/companies/:companyId/routines", async ({ params, body }) => ({ routine: service.upsertRoutine(params.companyId, null, body) }));
  add("PATCH", "/api/companies/:companyId/routines/:routineId", async ({ params, body }) => ({ routine: service.upsertRoutine(params.companyId, params.routineId, body) }));
  add("POST", "/api/companies/:companyId/routines/:routineId/run", async ({ params }) => engine.runRoutine({ companyId: params.companyId, routineId: params.routineId }));

  /* ---- skills ---- */

  add("GET", "/api/skills/meta", async () => skillStats());
  add("GET", "/api/skills/suggest", async ({ query }) => ({ skills: suggestSkills({ text: query.q ?? "", limit: Number(query.limit) || 5 }) }));
  add("GET", "/api/skills", async ({ query }) => {
    const result = searchSkills({
      query: query.q ?? "",
      category: query.category ?? "",
      tag: query.tag ?? "",
      limit: Math.min(200, Number(query.limit) || 60),
      offset: Number(query.offset) || 0,
    });
    return { ...result, meta: skillStats() };
  });
  add("GET", "/api/skills/:skillId", async ({ params }) => {
    const skill = loadSkills().skills.find((entry) => entry.id === params.skillId);
    if (!skill) {
      const error = new Error("Skill not found");
      error.status = 404;
      throw error;
    }
    return { skill };
  });

  /* ---- blueprints ---- */

  add("GET", "/api/blueprints", async ({ query }) => ({
    blueprints: listBlueprints({ category: query.category ?? "", query: query.q ?? "" }),
    stats: blueprintStats(),
  }));
  add("GET", "/api/blueprints/:blueprintId", async ({ params }) => {
    const blueprint = getBlueprint(params.blueprintId);
    if (!blueprint) {
      const error = new Error("Blueprint not found");
      error.status = 404;
      throw error;
    }
    return { blueprint };
  });

  /* ---- models ---- */

  add("GET", "/api/models", async ({ query }) => {
    if (query.refresh === "1") await refreshCatalog({ force: true });
    const vault = loadVault();
    const connected = customModels({ vault });
    // Connected models (added from an OpenAI/Groq/NVIDIA snippet) sit beside the
    // NIM catalog so one picker covers everything this instance can call.
    const all = [...catalog.models, ...connected];
    const models = searchModels(all, query.q ?? "").filter((model) =>
      query.capability ? model.capabilities.includes(query.capability) : true,
    );
    const families = query.family ? models.filter((model) => model.family === query.family) : models;
    const providers = providersView({ vault });
    return {
      models: families,
      summary: catalogSummary(all),
      capabilities: CAPABILITIES,
      syncedAt: catalog.syncedAt,
      live: catalog.live,
      error: catalog.error,
      errorCode: catalog.errorCode ?? null,
      providers,
      connected: connected.length,
      catalogTotal: catalog.models.length,
      nvidiaUnlocked: providers.some((provider) => provider.providerId === "nvidia" && provider.keyPresent),
    };
  });

  add("POST", "/api/models/refresh", async () => {
    await refreshCatalog({ force: true });
    return {
      count: catalog.models.length,
      live: catalog.live,
      syncedAt: catalog.syncedAt,
      error: catalog.error,
      summary: catalog.summary,
    };
  });

  add("POST", "/api/models/probe", async ({ body }) => {
    if (!body.model) {
      const error = new Error("model is required");
      error.status = 400;
      throw error;
    }
    return nim.probeModel({ model: body.model });
  });

  /* ---- providers (one key, every model) ---- */

  add("GET", "/api/providers", async () => {
    const vault = loadVault();
    const providers = providersView({ vault });
    const connected = customModels({ vault });
    return {
      providers,
      available: allProviderSummaries(),
      connected,
      nvidia: {
        configured: providers.some((provider) => provider.providerId === "nvidia" && provider.keyPresent),
        models: catalog.models.length,
        url: "https://build.nvidia.com/models",
      },
      config: publicConfig(),
    };
  });

  add("POST", "/api/providers/detect", async ({ body }) => {
    const detection = detectSetup(body.text ?? body.snippet ?? "");
    return {
      detection: {
        ...detection,
        // never echo the raw secret back, even to the same origin
        key: undefined,
        hasKey: Boolean(detection.key),
        keyBytes: detection.key ? detection.key.length : 0,
      },
      available: allProviderSummaries(),
    };
  });

  add("POST", "/api/providers/apply", async ({ body }) => {
    const text = String(body.text ?? body.snippet ?? "");
    const detection = detectSetup(text);
    const providerId = String(body.providerId ?? detection.providerId ?? "nvidia");
    const known = getProvider(providerId);
    const key = String(body.key ?? detection.key ?? "").trim();
    if (!key) {
      const error = new Error(
        detection.warnings[0] ?? "No API key found in that snippet.",
      );
      error.status = 400;
      error.code = "missing_key";
      error.hint =
        "Paste the whole snippet (the key included), or type the key into the field. Snippets that read the key from the environment have nothing to extract.";
      throw error;
    }
    if (providerId !== "custom" && !known) {
      const error = new Error(`Unknown provider: ${providerId}`);
      error.status = 400;
      error.code = "unknown_provider";
      throw error;
    }

    const baseUrl = String(
      body.baseUrl ?? (detection.providerId === providerId ? detection.baseUrl : "") ?? "",
    ).replace(/\/+$/, "") || known?.baseUrl || detection.baseUrl;
    if (!baseUrl) {
      const error = new Error("That snippet has a key but no base URL, and the provider is unknown.");
      error.status = 400;
      error.code = "missing_base_url";
      error.hint = "Pick a provider, or paste a snippet that includes base_url (or a full endpoint URL).";
      throw error;
    }

    const name = known?.name ?? detection.detectedName ?? "Custom provider";

    // Verification is best effort: a locked-down sandbox cannot reach the
    // provider, and that must not block local configuration.
    let verified = false;
    let modelCount = null;
    let detail = "";
    try {
      const probe = await nimVerify(key, baseUrl);
      verified = true;
      modelCount = probe.count;
      detail = `Verified: ${probe.count} models visible at ${new URL(baseUrl).host}.`;
    } catch (error) {
      detail =
        providerId === "nvidia"
          ? `Saved, but not verified (${error.message}) — staying in simulation until the key can reach ${new URL(baseUrl).host}. Untick “Force simulation” in Settings to go live anyway.`
          : `Saved without verification — ${error.message}`;
    }

    const keyId = addVaultKey({
      key,
      label: body.label || `${name} key`,
      providerId: known ? providerId : null,
      baseUrl,
      verified,
      modelCount,
    });

    if (providerId === "nvidia") {
      saveSettings({ baseUrl });
      // An unverified NVIDIA key would flip the whole product into live mode and
      // fail every call (no egress, or a typo). Keep simulation until it proves
      // itself, or until the operator turns the override off in Settings.
      if (!verified) saveSettings({ simulationOverride: true });
    }

    const models = [...new Set([body.model, detection.model, ...(Array.isArray(body.models) ? body.models : [])].filter(Boolean))];
    const provider = upsertProvider({
      providerId,
      name,
      baseUrl,
      keyId,
      models,
      source: text ? "snippet" : "manual",
      verified,
      modelCount,
    });

    // The detection blob carries the raw key; strip it before it leaves the process.
    const safeDetection = { ...detection, key: undefined, hasKey: Boolean(detection.key), keyBytes: detection.key.length };
    const model = models[0] ?? known?.sampleModel ?? null;
    return {
      ok: true,
      provider: providersView({ vault: loadVault() }).find((entry) => entry.providerId === provider.providerId) ?? provider,
      model,
      models,
      verified,
      modelCount,
      detail,
      detection: safeDetection,
      message: `Success! Auto-configured ${name} provider${model ? ` with model ${model}` : ""}.`,
      keys: vaultView(),
      providers: providersView({ vault: loadVault() }),
      config: publicConfig(),
      nim: nim.status(),
    };
  });

  add("POST", "/api/providers/:providerId/models", async ({ params, body }) => {
    const model = String(body.model ?? "").trim();
    if (!model) {
      const error = new Error("model is required");
      error.status = 400;
      throw error;
    }
    const provider = addProviderModel(params.providerId, model);
    return { provider, providers: providersView({ vault: loadVault() }) };
  });

  add("DELETE", "/api/providers/:providerId", async ({ params }) => {
    const vault = loadVault();
    const connection = providersView({ vault }).find((entry) => entry.id === params.providerId);
    removeProvider(params.providerId);
    if (connection) {
      const orphan = vault.find((entry) => entry.providerId === params.providerId && entry.baseUrl === connection.baseUrl);
      if (orphan) removeVaultKey(orphan.id);
    }
    return { providers: providersView({ vault: loadVault() }), config: publicConfig() };
  });

  /* ---- studio (every NIM endpoint family) ---- */

  for (const [path, handler] of Object.entries(STUDIO_ROUTES)) {
    add("POST", path, async ({ body, res }) => {
      const result = await handler({ body, nim, res });
      return result;
    });
  }

  /* ---- settings + keys ---- */

  add("GET", "/api/settings", async () => ({
    config: publicConfig(),
    settings: { ...loadSettings(), apiKey: undefined },
    nim: nim.status(),
  }));

  add("PATCH", "/api/settings", async ({ body }) => {
    const patch = {};
    if (body.baseUrl !== undefined) patch.baseUrl = body.baseUrl;
    if (body.simulationOverride !== undefined) patch.simulationOverride = Boolean(body.simulationOverride);
    if (body.defaultRouting !== undefined) patch.defaultRouting = body.defaultRouting;
    saveSettings(patch);
    return { config: publicConfig(), nim: nim.status() };
  });

  add("GET", "/api/keys", async () => ({ keys: vaultView(), config: publicConfig() }));

  add("POST", "/api/keys", async ({ body }) => {
    const parsed = parseCredentialText(String(body.text ?? body.key ?? ""));
    if (!parsed.key) {
      const error = new Error("Could not find an NVIDIA API key in that text.");
      error.status = 400;
      throw error;
    }
    let verified = false;
    let modelCount = null;
    let detail = "";
    try {
      const probe = await nimVerify(parsed.key);
      verified = true;
      modelCount = probe.count;
      detail = `Verified against /v1/models (${probe.count} models).`;
    } catch (error) {
      detail = error.message;
    }
    const id = addVaultKey({ key: parsed.key, label: body.label || parsed.label || "API key", verified, modelCount });
    return { id, verified, modelCount, detail, keys: vaultView(), config: publicConfig() };
  });

  add("PATCH", "/api/keys/:keyId", async ({ params, body }) => {
    if (body.active) setActiveVaultKey(params.keyId);
    return { keys: vaultView(), config: publicConfig() };
  });

  add("DELETE", "/api/keys/:keyId", async ({ params }) => {
    removeVaultKey(params.keyId);
    return { keys: vaultView(), config: publicConfig() };
  });

  add("POST", "/api/keys/verify", async ({ body }) => {
    const { key } = resolveCredential();
    const candidate = body.key || key;
    if (!candidate) {
      const error = new Error("No API key to verify.");
      error.status = 400;
      throw error;
    }
    try {
      const probe = await nimVerify(candidate);
      return { ok: true, count: probe.count, latencyMs: probe.latencyMs, live: true };
    } catch (error) {
      return { ok: false, error: error.message, code: error.code ?? "error", hint: error.hint ?? "" };
    }
  });

  async function nimVerify(key, explicitBaseUrl) {
    const baseUrl = explicitBaseUrl || loadSettings().baseUrl;
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const error = new Error(response.status === 401 ? "NVIDIA rejected this key (401)." : `Verification failed: ${response.status}`);
      error.code = response.status === 401 ? "unauthorized" : `http_${response.status}`;
      throw error;
    }
    const data = await response.json();
    const count = Array.isArray(data?.data) ? data.data.length : 0;
    return { count, latencyMs: 0 };
  }

  /* ---- data ---- */

  add("POST", "/api/data/reset", async ({ body }) => {
    if (body.confirm !== "RESET") {
      const error = new Error('Send {"confirm":"RESET"} to wipe companies.');
      error.status = 400;
      throw error;
    }
    engine.stopAll();
    store.resetAll({ keepSettings: true });
    saveSettings({ activeCompanyId: null });
    const company = service.ensureSeed();
    return { ok: true, companyId: company.id };
  });

  add("POST", "/api/data/prune", async () => {
    if (!existsSync(paths.companies)) return { removed: [] };
    const valid = store.listCompanies().map((company) => company.id);
    const removed = [];
    for (const entry of readdirSync(paths.companies, { withFileTypes: true })) {
      if (!entry.isDirectory() || valid.includes(entry.name)) continue;
      rmSync(join(paths.companies, entry.name), { recursive: true, force: true });
      removed.push(entry.name);
    }
    return { removed };
  });

  /* ---- events (SSE) ---- */

  add("GET", "/api/events", async ({ req, res }) => {
    const sse = openSse(res);
    const url = new URL(req.url, "http://localhost");
    const companyId = url.searchParams.get("companyId");
    const unsubscribe = bus.subscribe((event) => {
      if (companyId && event.companyId && event.companyId !== companyId) return;
      sse.send("event", event);
    }, { replay: Number(url.searchParams.get("replay")) || 0 });
    const heartbeat = setInterval(() => sse.send("ping", { at: new Date().toISOString() }), 20_000);
    heartbeat.unref?.();
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      sse.close();
    });
    return null;
  });

  /* ---- static ---- */

  /**
   * Content address for the front end.
   *
   * `Cache-Control: no-cache` is a *request to revalidate*, and a proxy or a
   * browser that ignores it will happily serve yesterday's stylesheet forever —
   * which is exactly how a CSS bug survives a deploy and looks like a blank
   * page. So the HTML never links `/styles.css`: it links
   * `/styles.css?v=<hash of the files>`. Change a file, change the URL, and no
   * cache anywhere can hand you the old one.
   */
  const assetStamp = { version: "", at: 0 };

  /**
   * Hash every file the browser can reach, not just the entry points: a view
   * module that changes without its URL changing is a stale module behind a
   * fresh app.js, which is the blank-page class of bug all over again.
   */
  function assetVersion() {
    const webRoot = resolve(paths.web);
    const newest = newestMtime(webRoot);
    if (assetStamp.version && newest <= assetStamp.at) return assetStamp.version;
    const hash = createHash("sha256");
    for (const relative of webFiles(webRoot).sort()) {
      hash.update(relative);
      hash.update(readFileSync(join(webRoot, relative)));
    }
    assetStamp.version = hash.digest("hex").slice(0, 10);
    assetStamp.at = Date.now();
    return assetStamp.version;
  }

  function webFiles(root, prefix = "") {
    const out = [];
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) out.push(...webFiles(root, relative));
      else out.push(relative);
    }
    return out;
  }

  function newestMtime(directory) {
    let newest = 0;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) newest = Math.max(newest, newestMtime(full));
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
    return newest;
  }

  // Module specifiers served to the browser carry the same stamp, so editing a
  // view cannot leave a cached `./views/foo.js` behind a fresh `app.js`.
  const IMPORT_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(\.{1,2}\/[^"']+?\.js)\2/g;

  function stamped(source, version) {
    return source
      .replace(IMPORT_SPECIFIER, (_match, lead, quote, specifier) => `${lead}${quote}${specifier}?v=${version}${quote}`)
      .replaceAll("__ASSET_VERSION__", version);
  }

  function serveStatic(req, res, pathname) {
    const webRoot = resolve(paths.web);
    let target = pathname === "/" ? "/index.html" : pathname;
    let file = resolve(join(webRoot, normalize(target)));
    if (!file.startsWith(webRoot)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      // Single-page app fallback for client-side routes.
      file = join(webRoot, "index.html");
      if (!existsSync(file)) {
        sendJson(res, 404, { error: "UI not built" });
        return;
      }
    }
    const ext = extname(file).toLowerCase();
    const version = assetVersion();
    const headers = {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      // Versioned URLs are immutable; anything else must not be trusted.
      // The HTML is the only unversioned entry point: it must never be stored,
      // or a cached copy would keep pointing at the previous asset URLs.
      "Cache-Control": ext === ".html" ? "no-store, must-revalidate" : [".js", ".css", ".svg"].includes(ext) ? "no-cache, must-revalidate" : "public, max-age=600",
      ETag: `"${version}-${ext.slice(1)}"`,
    };

    if (ext === ".html" || ext === ".js") {
      // Tiny files, and they must be rewritten (version stamp) before they leave.
      const body = Buffer.from(stamped(readFileSync(file, "utf8"), version), "utf8");
      headers["Content-Length"] = String(body.length);
      res.writeHead(200, headers);
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(body);
      return;
    }

    const size = statSync(file).size;
    // Explicit length: chunked responses are the first thing a proxy lets you down on.
    headers["Content-Length"] = String(size);
    res.writeHead(200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  }

  return async function handler(req, res) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);

    // Request log: enough to tell "the browser never reached us" from "the app threw".
    const startedAt = Date.now();
    const host = String(req.headers.host ?? "");
    res.on("finish", () => {
      if (process.env.LOG_REQUESTS === "0") return;
      const origin = host.includes("e2b.app") ? "preview" : /^(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/.test(host) ? "local" : host || "unknown";
      console.log(`[req] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - startedAt}ms ${origin}`);
    });

    // CORS for programmatic use (self-hosted single origin by default).
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (!pathname.startsWith("/api/")) {
      serveStatic(req, res, pathname);
      return;
    }

    const match = matchRoute(routes, req.method, pathname);
    if (!match) {
      sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
      return;
    }
    try {
      const body = ["POST", "PATCH", "PUT", "DELETE"].includes(req.method ?? "") ? await readJson(req) : {};
      const result = await match.route.handler({ req, res, params: match.params, query: Object.fromEntries(url.searchParams), body });
      if (result !== null && !res.headersSent) sendJson(res, 200, result);
      else if (result !== null && !res.writableEnded) sendJson(res, 200, result);
    } catch (error) {
      if (res.headersSent) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
        return;
      }
      // NimError carries status 0 when NIM was never reached; never writeHead(0).
      const declared = Number(error?.status);
      const status = Number.isInteger(declared) && declared >= 400 && declared <= 599
        ? declared
        : error?.name === "NimError"
          ? (error.code === "simulation_only" || error.code === "bad_path" ? 400 : 502)
          : 500;
      sendJson(res, status, {
        error: error?.message ?? "Internal error",
        code: error?.code ?? (status === 500 ? "internal_error" : "error"),
        hint: error?.hint ?? "",
      });
      if (status >= 500 && process.env.NODE_ENV !== "test") console.error(`[api] ${req.method} ${pathname}`, error);
    }
  };
}
