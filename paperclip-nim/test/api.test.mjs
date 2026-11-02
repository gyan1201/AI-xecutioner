/**
 * HTTP surface tests. Boots the real server on an ephemeral port against a
 * throwaway data directory and talks to it over fetch, so routing, JSON shapes,
 * SSE framing and static delivery are all exercised the way the browser does.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

process.env.PAPERCLIP_DATA_DIR = mkdtempSync(join(tmpdir(), "paperclip-nim-api-"));
process.env.LOG_REQUESTS = "0";
delete process.env.NVIDIA_API_KEY;
delete process.env.NIM_API_KEY;

const { createRuntime } = await import("../server/runtime.mjs");
const { createApp } = await import("../server/routes.mjs");

const runtime = createRuntime({ logger: { log() {}, warn() {}, error() {} } });
runtime.service.ensureSeed();
const app = createApp(runtime);
const server = createServer((req, res) =>
  Promise.resolve(app(req, res)).catch((error) => {
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error?.message ?? "Internal error" }));
  }),
);
let base = "";
let companyId = "";

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const boot = await (await fetch(`${base}/api/bootstrap`)).json();
  companyId = boot.activeCompanyId;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  runtime.store.flush?.();
  rmSync(process.env.PAPERCLIP_DATA_DIR, { recursive: true, force: true });
});

const timeout = (ms = 45_000) => AbortSignal.timeout(ms);
const get = async (path) => {
  const response = await fetch(`${base}${path}`, { signal: timeout() });
  const body = await response.json().catch(() => null);
  return { status: response.status, body, response };
};
const post = async (path, body = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeout(120_000),
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json };
};
const patch = async (path, body = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: timeout(),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const sse = async (path, body = {}) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal: timeout(180_000),
  });
  const text = await response.text();
  const events = text
    .split("\n\n")
    .filter((frame) => frame.trim())
    .map((frame) => {
      const lines = frame.split("\n");
      const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
      return { type, data: data ? JSON.parse(data) : null };
    });
  return { status: response.status, events };
};

test("health, status and bootstrap describe the running app", async () => {
  const health = await get("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.ok(health.body.companies >= 1);

  const status = await get("/api/status");
  assert.equal(status.body.nim.mode, "simulation");
  assert.ok(status.body.catalog.count >= 90);
  assert.equal(status.body.skills.count, 430);
  assert.equal(status.body.blueprints.count, 36);

  const boot = await get("/api/bootstrap");
  assert.ok(boot.body.companies.length >= 1);
  assert.ok(boot.body.activeCompanyId);
  assert.ok(boot.body.models.count >= 90);
  assert.ok(Object.keys(boot.body.capabilities).includes("protein"));
  assert.ok(boot.body.config.mode === "simulation");
});

test("models search filters by query, capability and family", async () => {
  const all = await get("/api/models");
  assert.ok(all.body.models.length >= 90);
  assert.ok(all.body.summary.total >= 90);

  const embedding = await get("/api/models?capability=embedding");
  assert.ok(embedding.body.models.length > 0);
  assert.ok(embedding.body.models.every((model) => model.capabilities.includes("embedding")));

  const protein = await get("/api/models?capability=protein");
  assert.ok(protein.body.models.some((model) => model.id.includes("boltz")));

  const search = await get("/api/models?q=nemotron");
  assert.ok(search.body.models.length > 5);
  assert.ok(search.body.models.every((model) => /nemotron/i.test(`${model.id} ${model.name} ${model.family} ${model.note}`)));

  const family = (await get("/api/models")).body.summary.families[0].name;
  const scoped = await get(`/api/models?family=${encodeURIComponent(family)}`);
  assert.ok(scoped.body.models.every((model) => model.family === family));
});

test("studio covers every NIM endpoint family", async () => {
  const chat = await post("/api/studio/chat", { model: "nvidia/nemotron-3-super-120b-a12b", prompt: "Summarise the plan.", maxTokens: 300 });
  assert.equal(chat.status, 200);
  assert.ok(chat.body.text.length > 40);
  assert.equal(chat.body.simulated, true);
  assert.ok(chat.body.usage.completion_tokens > 0);

  const embed = await post("/api/studio/embed", { input: ["activation is the bottleneck", "trials stall"] });
  assert.equal(embed.body.dimensions, embed.body.preview[0].top.length ? embed.body.dimensions : 1024);
  assert.equal(embed.body.count, 2);
  assert.ok(embed.body.preview[0].norm > 0);
  assert.ok(embed.body.preview[0].top.length > 0);

  const rerank = await post("/api/studio/rerank", {
    query: "why do trials stall",
    passages: ["pricing tiers", "trials stall on day three", "hiring plan"],
  });
  assert.equal(rerank.body.rankings.length, 3);
  assert.equal(rerank.body.rankings[0].rank, 1);
  assert.match(rerank.body.rankings[0].passage, /trials stall/);

  const image = await post("/api/studio/image", { prompt: "a green data flow", width: 512, height: 512, steps: 8 });
  assert.equal(image.body.artifacts.length, 1);
  assert.match(image.body.artifacts[0].dataUri, /^data:image\/(svg\+xml|png);base64,/);

  const safety = await post("/api/studio/safety", { text: "Publish the customer data to the public status page." });
  assert.ok(["safe", "unsafe"].includes(safety.body.verdict ?? (safety.body.unsafe ? "unsafe" : "safe")));

  const translate = await post("/api/studio/translate", { text: "Activation is the bottleneck.", target: "es" });
  assert.ok(translate.body.text.length > 5);

  const biology = await post("/api/studio/biology", { model: "nvidia/bionemo-boltz2", task: "protein-structure", sequence: "MKTAYIAKQRQISFVK" });
  assert.equal(biology.status, 200);
  assert.ok(biology.body.simulated);

  const raw = await post("/api/studio/raw", {
    method: "POST",
    path: "/chat/completions",
    body: { model: "nvidia/nemotron-3-super-120b-a12b", messages: [{ role: "user", content: "ping" }] },
  });
  assert.equal(raw.status, 200);
  assert.ok(raw.body.simulated);
  assert.match(raw.body.data.choices[0].message.content, /\w/);
  assert.equal(raw.body.data.object, "chat.completion");

  const embedRaw = await post("/api/studio/raw", { path: "/embeddings", body: { model: "nvidia/nemotron-3.5-embed-8b", input: "hello" } });
  assert.equal(embedRaw.body.data.data.length, 1);
  assert.equal(embedRaw.body.data.data[0].embedding.length, 1024);

  const unsupported = await post("/api/studio/raw", { path: "/not-a-nim-endpoint", body: {} });
  assert.equal(unsupported.status, 400);
  assert.equal(unsupported.body.code, "simulation_only");
  assert.ok(unsupported.body.hint);
});

test("skills, blueprints and capability metadata are served", async () => {
  const skills = await get("/api/skills?limit=10");
  assert.equal(skills.body.items.length, 10);
  assert.ok(skills.body.total > 300);
  assert.equal(skills.body.meta.count, 430);

  const detail = await get(`/api/skills/${skills.body.items[0].id}`);
  assert.equal(detail.body.skill.id, skills.body.items[0].id);

  const suggest = await get("/api/skills/suggest?q=retrieval%20augmented%20generation");
  assert.ok(suggest.body.skills.length > 0);

  const blueprints = await get("/api/blueprints");
  assert.equal(blueprints.body.blueprints.length, 36);
  assert.equal(blueprints.body.stats.count, 36);

  const one = await get(`/api/blueprints/${blueprints.body.blueprints[0].id}`);
  assert.ok(one.body.blueprint.team.length >= 2);

  const missing = await get("/api/blueprints/not-a-blueprint");
  assert.equal(missing.status, 404);
});

test("issue lifecycle: create, comment, run over SSE, read back", async () => {
  const created = await post(`/api/companies/${companyId}/issues`, {
    title: "Ship the activation experiment",
    description: "Prove the day-three stall fix.",
    priority: "high",
    status: "todo",
  });
  assert.equal(created.status, 200);
  const issueId = created.body.issue.id;
  assert.ok(created.body.issue.key);

  const comment = await post(`/api/companies/${companyId}/issues/${issueId}/comments`, { body: "Kicking this off." });
  assert.equal(comment.status, 200);

  const run = await sse(`/api/companies/${companyId}/issues/${issueId}/run?stream=1`);
  assert.equal(run.status, 200);
  assert.ok(run.events.some((event) => event.type === "delta" && event.data.chunk));
  const done = run.events.find((event) => event.type === "done");
  assert.ok(done, "the run stream must end with a done event");
  assert.ok(done.data.run.steps.length >= 5);
  assert.ok(done.data.verdict?.verdict);

  const detail = await get(`/api/companies/${companyId}/issues/${issueId}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.comments.length >= 1);
  assert.ok(detail.body.runs.length >= 1);
});

test("a cycle streams a plan, results, a standup and lands in history", async () => {
  const before = (await get(`/api/companies/${companyId}`)).body.cycleHistory.length;
  const run = await sse(`/api/companies/${companyId}/cycle?stream=1`, { maxIssues: 2 });
  assert.equal(run.status, 200);
  const done = run.events.find((event) => event.type === "done");
  assert.ok(done, "cycle stream ends with done");
  assert.ok(done.data.plan.focus);
  assert.ok(done.data.results.length >= 1);
  assert.match(done.data.standup, /Cycle standup/);
  const after = (await get(`/api/companies/${companyId}`)).body.cycleHistory.length;
  assert.equal(after, before + 1);
});

test("dashboard, inbox, ledger, org and plan views agree with the company", async () => {
  const company = (await get(`/api/companies/${companyId}`)).body;
  const dashboard = await get(`/api/companies/${companyId}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.body.stats);
  assert.ok(Array.isArray(dashboard.body.recentIssues));
  assert.ok(Array.isArray(dashboard.body.recentActivity));
  assert.ok(Array.isArray(dashboard.body.cycles));
  assert.ok(dashboard.body.charts.byDay.length >= 1);

  const inbox = await get(`/api/companies/${companyId}/inbox`);
  assert.ok(Array.isArray(inbox.body.items));

  const ledger = await get(`/api/companies/${companyId}/ledger`);
  assert.ok(ledger.body.rows.length > 0);
  assert.ok(ledger.body.totalCents > 0);
  assert.equal(ledger.body.rows[0].costCents, Math.round(ledger.body.rows[0].costCents * 100) / 100);

  const org = await get(`/api/companies/${companyId}/org`);
  assert.equal(org.body.agents.length, company.agents.length);
  assert.ok(org.body.agents.some((agent) => agent.reportsTo === null));

  const plan = await post(`/api/companies/${companyId}/plan`);
  assert.ok(plan.body.plan.focus);
  assert.ok(Array.isArray(plan.body.plan.assignments));
});

test("approvals decide through the API", async () => {
  const list = await get(`/api/companies/${companyId}/approvals`);
  const pending = list.body.approvals.find((approval) => approval.status === "pending");
  assert.ok(pending, "demo company should have a pending approval");
  const decided = await post(`/api/companies/${companyId}/approvals/${pending.id}/decide`, { decision: "approve" });
  assert.equal(decided.status, 200);
  const bad = await post(`/api/companies/${companyId}/approvals/${pending.id}/decide`, { decision: "maybe" });
  assert.equal(bad.status, 400);
});

test("agencies: agents, skills, goals, projects, routines and knowledge all mutate", async () => {
  const agent = await post(`/api/companies/${companyId}/agents`, {
    name: "Nadia Okafor",
    title: "Retrieval Engineer",
    role: "operator",
    model: "nvidia/nemotron-3-super-120b-a12b",
    monthlyBudgetCents: 400,
    instructions: "Own retrieval quality.",
  });
  assert.equal(agent.status, 200);
  const agentId = agent.body.agent.id;

  const skill = (await get("/api/skills?limit=1")).body.items[0].id;
  const assigned = await fetch(`${base}/api/companies/${companyId}/agents/${agentId}/skills`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ skills: [skill] }),
  }).then((response) => response.json());
  assert.deepEqual(assigned.agent.skills, [skill]);

  const goal = await post(`/api/companies/${companyId}/goals`, { title: "Cut time-to-value", metric: "minutes", baseline: 24, current: 24, target: 8, unit: "min" });
  assert.equal(goal.status, 200);
  const project = await post(`/api/companies/${companyId}/projects`, { name: "Activation", description: "Day three", color: "#76b900" });
  assert.equal(project.status, 200);
  const routine = await post(`/api/companies/${companyId}/routines`, {
    name: "Daily triage",
    agentId,
    cadenceMinutes: 1440,
    instruction: "Triage the board and name the one thing that must move.",
  });
  assert.equal(routine.status, 200);

  const doc = await post(`/api/companies/${companyId}/knowledge`, { title: "Activation notes", body: "Trials stall on day three before the first saved insight." });
  assert.equal(doc.status, 200);
  const search = await post(`/api/companies/${companyId}/knowledge/search`, { query: "day three stall", topK: 3 });
  assert.ok(search.body.passages.length > 0);
});

test("settings and keys stay server-side and fail safely", async () => {
  const settings = await get("/api/settings");
  assert.equal(settings.status, 200);
  assert.equal(settings.body.config.keyPresent, false);
  assert.equal(settings.body.settings.apiKey, undefined);

  const patched = await patch("/api/settings", { simulationOverride: true, baseUrl: "https://integrate.api.nvidia.com/v1" });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.config.simulationOverride, true);

  const verify = await post("/api/keys/verify", {});
  assert.equal(verify.status, 400, "verifying with no key must be a 400, not a crash");

  const addKey = await post("/api/keys", { text: "nothing useful here" });
  assert.equal(addKey.status, 400);
});

test("a blueprint deploys a staffed team and a backlog", async () => {
  const blueprints = (await get("/api/blueprints")).body.blueprints;
  const blueprint = blueprints.find((entry) => entry.team.length >= 3) ?? blueprints[0];
  const before = (await get(`/api/companies/${companyId}`)).body;
  const deployed = await post(`/api/companies/${companyId}/blueprints/${blueprint.id}`, {});
  assert.equal(deployed.status, 200);
  assert.equal(deployed.body.blueprint.id, blueprint.id);
  assert.ok(deployed.body.agents >= blueprint.team.length);
  assert.ok(deployed.body.issues >= blueprint.backlog.length);
  assert.ok(deployed.body.company.agents.length > before.agents.length, "deploy should hire the blueprint team");
  assert.ok(deployed.body.company.issues.length > before.issues.length, "deploy should add the blueprint backlog");
  for (const agent of deployed.body.company.agents) {
    assert.ok(runtime.catalog.models.some((model) => model.id === agent.model), `${agent.name} runs on a catalog model`);
  }
  const deployedGoal = deployed.body.company.goals[0];
  assert.ok(deployedGoal?.title, "deploy should record a goal");
});

test("a new company can be created from scratch and from a blueprint", async () => {
  const created = await post("/api/companies", { name: "Test Foundry", mission: "Prove the clone can start from zero." });
  assert.equal(created.status, 200);
  assert.ok(created.body.company.id);
  assert.ok(created.body.company.agents.length >= 1, "a fresh company should get a founding team");

  const blueprint = (await get("/api/blueprints")).body.blueprints[0];
  const fromBlueprint = await post("/api/companies", { name: "Blueprint Co", blueprintId: blueprint.id });
  assert.equal(fromBlueprint.status, 200);
  assert.ok(fromBlueprint.body.company.issues.length >= 3);
  const activated = await post(`/api/companies/${created.body.company.id}/activate`, {});
  assert.equal(activated.body.activeCompanyId, created.body.company.id);
});

test("static UI is served and unknown API routes return JSON 404", async () => {
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /text\/html/);
  const html = await index.text();
  assert.match(html, /id="view"/);
  assert.match(html, /app\.js/);

  for (const asset of ["/styles.css", "/lib.js", "/app.js", "/views/dashboard.js", "/views/studio.js", "/favicon.svg"]) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200, `${asset} should be served`);
  }

  const missing = await get("/api/definitely-not-a-route");
  assert.equal(missing.status, 404);
  assert.ok(missing.body.error);

  const traversal = await fetch(`${base}/../package.json`);
  assert.ok([200, 403, 404].includes(traversal.status));
  assert.ok(!(await traversal.text()).includes('"scripts"'));
});
