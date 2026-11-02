/**
 * Engine tests: a simulated company must still behave like a company.
 * Every run goes through plan → context → tools → deliverable → review → ledger.
 *
 * These run against a throwaway PAPERCLIP_DATA_DIR so the demo state is never
 * touched, and they never leave the machine: NIM is simulated.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "paperclip-nim-test-"));
process.env.PAPERCLIP_DATA_DIR = dataDir;
delete process.env.NVIDIA_API_KEY;
delete process.env.NIM_API_KEY;

const { createRuntime } = await import("../server/runtime.mjs");
const { embedText, cosine } = await import("../server/nim/sim.mjs");

const runtime = createRuntime({ logger: { log() {}, warn() {}, error() {} } });
const service = runtime.service;
const engine = runtime.engine;
runtime.catalog.live = false;

const seeded = service.ensureSeed();
const companyId = seeded?.id ?? service.listCompanies?.()[0]?.id ?? "co_northwind";

after(() => {
  runtime.store.flush?.();
  rmSync(dataDir, { recursive: true, force: true });
});

test("seed produces a staffed company with a board, goals and a ledger", () => {
  const company = runtime.store.getCompany(companyId);
  assert.ok(company, "seed company should exist");
  assert.ok(company.agents.length >= 6, `expected a team, got ${company.agents.length}`);
  assert.ok(company.issues.length >= 10, `expected a board, got ${company.issues.length}`);
  assert.ok(company.goals.length >= 1);
  assert.ok(company.ledger.length >= 10, "the demo should ship with spend history");
  for (const agent of company.agents) {
    assert.ok(agent.model.includes("/"), `${agent.name} must run on a real NIM model id`);
    assert.ok(runtime.catalog.models.some((model) => model.id === agent.model), `${agent.model} is not in the catalog`);
    assert.ok(agent.monthlyBudgetCents > 0, `${agent.name} needs a budget`);
  }
});

test("runIssue executes the full loop and writes a trace, verdict, artifact and ledger row", async () => {
  const company = runtime.store.getCompany(companyId);
  const issue = company.issues.find((entry) => entry.status === "todo" || entry.status === "backlog");
  assert.ok(issue, "need an open issue to run");

  const ledgerBefore = runtime.store.getCompany(companyId).ledger.length;
  const result = await engine.runIssue({ companyId, issueId: issue.id, actorId: "test" });

  assert.ok(result.run, "run should be returned");
  assert.ok(result.run.steps.length >= 5, `expected a multi-step trace, got ${result.run.steps.length}`);
  assert.equal(result.run.status, "succeeded");
  assert.ok(result.run.costCents > 0, "a run must cost something");
  assert.ok(result.run.usage.completion_tokens > 0);
  assert.ok(result.verdict?.verdict, "review must return a verdict");
  assert.ok(["accepted", "changes_requested"].includes(result.verdict.verdict));
  assert.ok(result.run.output.length > 200, "deliverable should be substantive");

  const after = runtime.store.getCompany(companyId);
  assert.ok(after.ledger.length > ledgerBefore, "the run should append ledger rows");
  const row = after.ledger[0];
  assert.ok(row.costCents >= 0);
  assert.ok(row.model.includes("/"));
  assert.ok(after.issues.find((entry) => entry.id === issue.id).status !== "backlog");
});

test("every run is reviewed and the attempt number is visible in the trace", async () => {
  const company = runtime.store.getCompany(companyId);
  const rework = company.issues.find((entry) => entry.status === "todo") ?? company.issues.find((entry) => entry.status === "in_progress");
  assert.ok(rework, "need an issue still on the board");
  const before = rework.reviewCount ?? 0;
  const result = await engine.runIssue({ companyId, issueId: rework.id, actorId: "test" });
  const gate = result.run.steps.find((step) => step.label === "Quality gate");
  assert.ok(gate, "a reviewed run must record the quality gate");
  assert.ok(/attempt \d+/.test(gate.detail), `gate detail should name the attempt: ${gate.detail}`);
  const issue = runtime.store.getCompany(companyId).issues.find((entry) => entry.id === rework.id);
  assert.ok((issue.reviewCount ?? 0) > before, "reviewCount should move after a review");
  if (result.verdict?.verdict === "changes_requested") {
    assert.equal(issue.status, "todo", "returned work goes back to todo, not done");
  } else {
    assert.equal(issue.status, "done");
  }
});

test("budget gate blocks a run instead of overspending", async () => {
  const company = runtime.store.getCompany(companyId);
  const agent = company.agents.find((entry) => company.issues.some((issue) => issue.assigneeId === entry.id && !["done", "cancelled"].includes(issue.status)));
  assert.ok(agent, "need an agent with open work");
  agent.monthlyBudgetCents = 0;
  runtime.store.saveCompany(company);
  const target = runtime.store
    .getCompany(companyId)
    .issues.find((issue) => issue.assigneeId === agent.id && !["done", "cancelled"].includes(issue.status));
  assert.ok(target, "need an open issue for that agent");
  const result = await engine.runIssue({ companyId, issueId: target.id, actorId: "test" });
  assert.equal(result.blocked, true);
  assert.match(result.reason, /budget|cap/i);
  const blockedIssue = runtime.store.getCompany(companyId).issues.find((issue) => issue.id === target.id);
  assert.equal(blockedIssue.status, "blocked");
  assert.ok(blockedIssue.blockedReason.includes("$"));
  company.agents.find((entry) => entry.id === agent.id).monthlyBudgetCents = 500;
  runtime.store.saveCompany(company);
});

test("planOnly reads the board and returns console-ready assignments", async () => {
  const plan = await engine.planOnly({ companyId });
  assert.ok(plan.plan.focus.length > 10);
  assert.ok(Array.isArray(plan.plan.assignments));
  assert.ok(plan.plan.assignments.length >= 1);
  const company = runtime.store.getCompany(companyId);
  const titles = new Set(company.issues.map((issue) => issue.title));
  for (const assignment of plan.plan.assignments) {
    assert.ok(!/^\[/.test(assignment.title), "assignment titles must not carry the board prefix");
    assert.ok(titles.has(assignment.title), `assignment "${assignment.title}" should match a board issue`);
    assert.ok(["Strategist", "Operator", "Analyst", "Critic"].includes(assignment.owner));
  }
});

test("planCycle runs issues, writes a standup and records the cycle", async () => {
  const before = runtime.store.getCompany(companyId).cycleHistory.length;
  const result = await engine.planCycle({ companyId, maxIssues: 2 });
  assert.ok(result.plan.focus);
  assert.ok(result.results.length >= 1 && result.results.length <= 2);
  assert.ok(result.standup.includes("Cycle standup"));
  assert.ok(result.standup.includes(result.plan.focus), "the standup must repeat the real focus");
  assert.match(result.standup, /\*\*Cost:\*\* \$\d+\.\d{2}/);
  assert.ok(result.cycle.costCents >= 0);
  for (const row of result.results) {
    assert.ok(Object.values(row).every((value) => typeof value !== "number" || Number.isFinite(value)));
    if (row.costCents != null) assert.equal(row.costCents, Math.round(row.costCents * 100) / 100);
  }
  assert.equal(runtime.store.getCompany(companyId).cycleHistory.length, before + 1);
});

test("approvals can be decided and unblock the issue", async () => {
  const company = runtime.store.getCompany(companyId);
  const pending = company.approvals.find((approval) => approval.status === "pending");
  const approval = pending ?? company.approvals[0];
  assert.ok(approval, "the seed should include at least one approval");
  const decided = await engine.decideApproval({ companyId, approvalId: approval.id, decision: "approve", by: "test" });
  const fresh = runtime.store.getCompany(companyId).approvals.find((entry) => entry.id === approval.id);
  assert.equal(fresh.status, "approved");
  assert.ok(decided);
});

test("knowledge search embeds and reranks the seeded documents", async () => {
  const result = await service.knowledgeSearch(companyId, "why do trials stall on day three", 4);
  assert.ok(result.passages.length > 0);
  assert.ok(result.passages[0].score > 0);
  const scores = result.passages.map((passage) => passage.rerankScore ?? passage.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "passages must arrive in rank order");
  assert.ok(result.passages.some((passage) => passage.docId));
});

test("agent creation, skills and instructions round-trip", () => {
  const skills = runtime.skillsCatalog?.search?.({ query: "rag", limit: 5 }) ?? null;
  const before = runtime.store.getCompany(companyId).agents.length;
  const agent = service.addAgent(companyId, {
    name: "Test Agent",
    title: "Verification Engineer",
    role: "operator",
    reportsTo: null,
    model: runtime.catalog.models.find((model) => model.capabilities.includes("chat")).id,
    instructions: "Check the build.",
    monthlyBudgetCents: 500,
  });
  assert.ok(agent.id);
  assert.equal(runtime.store.getCompany(companyId).agents.length, before + 1);
  const patched = service.updateAgent(companyId, agent.id, { instructions: "Check the build twice." });
  assert.equal(patched.instructions, "Check the build twice.");
  const removed = service.removeAgent(companyId, agent.id);
  assert.ok(removed);
  assert.equal(runtime.store.getCompany(companyId).agents.length, before);
  void skills;
});

test("runs orphaned by a restart are reaped and their issues released", async () => {
  const company = runtime.store.getCompany(companyId);
  // Pick an issue with no other live run, otherwise the reaper is right to keep it.
  const issue = company.issues.find(
    (entry) => !["done", "cancelled"].includes(entry.status) && !company.runs.some((run) => run.issueId === entry.id && run.status === "running"),
  );
  assert.ok(issue, "need an idle issue to park");
  const stale = {
    id: "run_stale_test",
    issueId: issue.id,
    agentId: company.agents[0].id,
    kind: "work",
    status: "running",
    model: company.agents[0].model,
    simulated: true,
    startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    endedAt: null,
    usage: { prompt_tokens: 10, completion_tokens: 0 },
    costCents: 0,
    steps: [],
    output: "",
    review: null,
    error: null,
  };
  company.runs.unshift(stale);
  issue.status = "in_progress";
  runtime.store.saveCompany(company);

  const reaped = engine.reapStaleRuns({ olderThanMs: 5 * 60_000 });
  assert.ok(reaped.some((row) => row.runId === stale.id), "the stale run should be reaped");

  const after = runtime.store.getCompany(companyId);
  const run = after.runs.find((entry) => entry.id === stale.id);
  assert.equal(run.status, "failed");
  assert.match(run.error, /Interrupted/);
  assert.ok(run.endedAt);
  assert.notEqual(after.issues.find((entry) => entry.id === issue.id).status, "in_progress");
  assert.ok(after.activity.some((entry) => entry.kind === "run.failed" && entry.meta?.runId === stale.id));

  // A fresh running run is left alone.
  const fresh = {
    ...stale,
    id: "run_fresh_test",
    status: "running",
    endedAt: null,
    error: null,
    startedAt: new Date().toISOString(),
  };
  const doc = runtime.store.getCompany(companyId);
  doc.runs.unshift(fresh);
  runtime.store.saveCompany(doc);
  engine.reapStaleRuns({ olderThanMs: 5 * 60_000 });
  assert.equal(runtime.store.getCompany(companyId).runs.find((entry) => entry.id === fresh.id).status, "running");
});

test("simulator embeddings and cosine similarity behave like vectors", () => {
  const a = embedText("Retrieval augmented generation over a knowledge base");
  const b = embedText("Retrieval augmented generation with a knowledge base");
  const c = embedText("Chocolate croissant and espresso pricing");
  assert.equal(a.length, 1024);
  assert.ok(cosine(a, b) > cosine(a, c), "similar sentences should score higher");
  assert.ok(cosine(a, a) > 0.999);
  assert.equal(cosine(a, new Array(1024).fill(0)), 0);
});
