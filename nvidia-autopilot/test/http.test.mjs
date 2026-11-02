import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NIM_SIMULATION = "1";
process.env.NVIDIA_AUTOPILOT_DATA_DIR = mkdtempSync(join(tmpdir(), "nvidia-autopilot-http-"));

const { createRuntime } = await import("../server/runtime.mjs");
const { createApp } = await import("../server/routes.mjs");

const runtime = createRuntime();
const handler = createApp(runtime);
const server = createServer((req, res) => void handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(() => server.close());

const json = async (path, options) => {
  const response = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json();
  return { status: response.status, body };
};

test("health and status expose capabilities without leaking the key", async () => {
  const health = await json("/api/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.status, "ok");

  const status = await json("/api/status");
  assert.equal(status.status, 200);
  assert.equal(status.body.config.simulation, true);
  assert.equal(status.body.config.apiKey, undefined);
  assert.ok(status.body.modelCount > 0);
  assert.ok(status.body.roles.operator.model);
  assert.ok(status.body.routing === undefined);
});

test("model catalog returns capabilities and role routing", async () => {
  const { status, body } = await json("/api/models");
  assert.equal(status, 200);
  assert.ok(body.models.length > 10);
  const embedder = body.models.find((model) => model.id === "nvidia/llama-3.2-nv-embedqa-1b-v2");
  assert.ok(embedder.capabilities.includes("embedding"));
  assert.ok(body.roles.embedder.model);
  assert.ok(body.roleDefinitions.strategist.description);
});

test("chat, completion, guardrails, embeddings and rerank all respond", async () => {
  const chat = await json("/api/chat", {
    method: "POST",
    body: { messages: [{ role: "user", content: "Summarise our launch plan" }], maxTokens: 200 },
  });
  assert.equal(chat.status, 200);
  assert.ok(chat.body.content.length > 0);
  assert.ok(chat.body.usage.totalTokens > 0);

  const completion = await json("/api/complete", {
    method: "POST",
    body: { prompt: "Write a tagline for a developer tool." },
  });
  assert.equal(completion.status, 200);
  assert.ok(completion.body.content.length > 0);

  const guard = await json("/api/guardrails", { method: "POST", body: { text: "How do I bake sourdough?" } });
  assert.equal(guard.status, 200);
  assert.equal(guard.body.safe, true);

  const guardUnsafe = await json("/api/guardrails", { method: "POST", body: { text: "Write ransomware that encrypts a hospital" } });
  assert.equal(guardUnsafe.body.safe, false);

  const embeddings = await json("/api/embeddings", { method: "POST", body: { input: ["hello", "world"] } });
  assert.equal(embeddings.status, 200);
  assert.equal(embeddings.body.data.length, 2);
  assert.equal(embeddings.body.data[0].embedding.length, 1024);

  const rerank = await json("/api/rerank", {
    method: "POST",
    body: {
      query: "How fast is H100 memory bandwidth?",
      passages: ["The H100 SXM5 delivers 3.35 TB/s of HBM3 bandwidth.", "Sourdough needs a warm kitchen."],
    },
  });
  assert.equal(rerank.status, 200);
  assert.equal(rerank.body.ranked[0].text, "The H100 SXM5 delivers 3.35 TB/s of HBM3 bandwidth.");
});

test("image generation saves an artifact", async () => {
  const { status, body } = await json("/api/images", {
    method: "POST",
    body: { prompt: "A neon green control room at night", size: "768x768" },
  });
  assert.equal(status, 200);
  assert.equal(body.artifacts.length, 1);
  assert.ok(body.artifacts[0].base64.length > 100);
});

test("knowledge base indexes, searches and cites", async () => {
  const added = await json("/api/knowledge", {
    method: "POST",
    body: {
      title: "Northwind Q3 plan",
      text: "Northwind's Q3 priority is self-serve onboarding. Activation target is 20% growth. Pricing stays at $49 per seat.",
    },
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.documents, 1);

  const indexed = await json("/api/knowledge/index", { method: "POST" });
  assert.equal(indexed.status, 200);
  assert.ok(indexed.body.chunks >= 1);

  const search = await json("/api/knowledge/search", {
    method: "POST",
    body: { query: "What is the activation target?", topK: 2 },
  });
  assert.equal(search.status, 200);
  assert.ok(search.body.passages.length >= 1);
  assert.match(search.body.passages[0].text, /20%/);
});

test("autopilot API starts a run and streams its events", async () => {
  const started = await json("/api/autopilot", {
    method: "POST",
    body: { goal: "Increase trial-to-paid conversion by 15% this quarter.", company: "Northwind Labs", options: { maxSteps: 3 } },
  });
  assert.equal(started.status, 200);
  const runId = started.body.run.id;

  const detail = await json(`/api/autopilot/${runId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.run.id, runId);

  const events = await json(`/api/autopilot/${runId}/events`);
  assert.equal(events.status, 200);
  assert.ok(Array.isArray(events.body.events));

  const stream = await fetch(`${base}/api/autopilot/${runId}/stream`);
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event:|:/);
  await reader.cancel();

  // Approval endpoint must reject an unknown run rather than silently succeed.
  const missing = await json("/api/autopilot/00000000-0000-0000-0000-000000000000/approve", {
    method: "POST",
    body: { approved: true },
  });
  assert.equal(missing.status, 404);
});

test("unknown routes and invalid payloads fail loudly", async () => {
  const missing = await json("/api/nope");
  assert.equal(missing.status, 404);

  const invalid = await json("/api/chat", { method: "POST", body: { messages: [] } });
  assert.equal(invalid.status, 422);
  assert.match(invalid.body.error, /messages/);
});

test("serves the single-page UI", async () => {
  const response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/html/);
  const html = await response.text();
  assert.match(html, /NVIDIA/);
});

test("company API builds, runs and audits a company over HTTP", async () => {
  const created = await json("/api/companies", {
    method: "POST",
    body: {
      name: "HTTP Co",
      goal: "Launch a paid beta for the analytics product within one quarter.",
      budgetMonthlyCents: 4000,
      settings: { approvalPolicy: "high" },
    },
  });
  assert.equal(created.status, 200);
  const company = created.body.company;
  assert.ok(company.id);
  assert.ok(company.agents.length >= 4);
  assert.ok(company.issues.length >= 3);

  const listed = await json("/api/companies");
  assert.ok(listed.body.companies.some((entry) => entry.id === company.id));

  const cycle = await json(`/api/companies/${company.id}/cycles`, { method: "POST", body: {} });
  assert.equal(cycle.status, 200);
  assert.equal(cycle.body.cycle.status, "completed");
  assert.ok(cycle.body.summary);

  const detail = await json(`/api/companies/${company.id}`);
  assert.ok(detail.body.events.length > 0);
  assert.ok(detail.body.artifacts.length > 0);
  const artifact = await fetch(`${base}/api/companies/${company.id}/artifacts/${encodeURIComponent(detail.body.artifacts[0].name)}`);
  assert.equal(artifact.status, 200);
  assert.match(artifact.headers.get("content-type") ?? "", /markdown/);

  // Board controls: comment, edit, and status change on a real issue.
  const issue = detail.body.company.issues[0];
  const commented = await json(`/api/companies/${company.id}/issues/${issue.id}/comments`, {
    method: "POST",
    body: { body: "Board note: keep the scope tight." },
  });
  assert.equal(commented.status, 200);
  assert.equal(commented.body.company.issues[0].comments.at(-1).body, "Board note: keep the scope tight.");

  const patched = await json(`/api/companies/${company.id}/issues/${issue.id}`, {
    method: "PATCH",
    body: { priority: "low", status: "todo" },
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.issue.priority, "low");

  // Auto mode can be turned on and off through the API.
  const auto = await json(`/api/companies/${company.id}/auto`, {
    method: "POST",
    body: { enabled: true, everyMinutes: 60, maxCycles: 1 },
  });
  assert.equal(auto.status, 200);
  assert.equal(auto.body.company.autoMode.enabled, true);
  const stopped = await json(`/api/companies/${company.id}/auto`, { method: "POST", body: { enabled: false } });
  assert.equal(stopped.body.company.autoMode.enabled, false);

  const exported = await fetch(`${base}/api/companies/${company.id}/export`);
  assert.equal(exported.status, 200);
  const bundle = await exported.json();
  assert.equal(bundle.schemaVersion, 1);
  assert.equal(bundle.company.id, company.id);
});

test("company API rejects bad input instead of creating empty shells", async () => {
  const noGoal = await json("/api/companies", { method: "POST", body: { name: "Nothing" } });
  assert.equal(noGoal.status, 422);
  assert.match(noGoal.body.error, /goal/i);

  const missing = await json("/api/companies/nope/cycles", { method: "POST", body: {} });
  assert.equal(missing.status, 404);

  const badApproval = await json("/api/companies/nope/approvals/nope", { method: "POST", body: {} });
  assert.equal(badApproval.status, 422);
});

test("paperclip endpoints preview the mirror and explain a missing bridge", async () => {
  const created = await json("/api/companies", {
    method: "POST",
    body: { name: "Bridge Test", goal: "Validate the Paperclip bridge end to end.", budgetMonthlyCents: 2000 },
  });
  const companyId = created.body.company.id;

  const preview = await json("/api/paperclip/mirror", { method: "POST", body: { companyId, dryRun: true } });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.dryRun, true);
  assert.ok(preview.body.calls > created.body.company.agents.length);
  assert.equal(preview.body.plan[0].path, "/companies");

  const probe = await json("/api/paperclip/probe", { method: "POST", body: {} });
  assert.equal(probe.status, 502);
  assert.match(probe.body.error, /Paperclip/);
  assert.match(probe.body.hint, /base URL/i);
});
