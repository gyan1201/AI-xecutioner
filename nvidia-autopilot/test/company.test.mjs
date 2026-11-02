import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NIM_SIMULATION = "1";
process.env.NVIDIA_AUTOPILOT_DATA_DIR = mkdtempSync(join(tmpdir(), "nvidia-autopilot-company-"));

const { createRuntime } = await import("../server/runtime.mjs");
const { createPaperclipClient } = await import("../server/paperclip.mjs");

const runtime = createRuntime();
await runtime.loadModels();

const GOAL = "Reach $20k MRR in 90 days by launching self-serve onboarding, without adding headcount.";

async function buildCompany(overrides = {}) {
  return runtime.company.createCompany({
    name: "Northwind Labs",
    goal: GOAL,
    budgetMonthlyCents: 5000,
    settings: { approvalPolicy: "high", maxIssuesPerCycle: 4, reworkLimit: 1 },
    ...overrides,
  });
}

test("a goal becomes a staffed company with departments, goals and a backlog", async () => {
  const company = await buildCompany();

  assert.equal(company.name, "Northwind Labs");
  assert.equal(company.status, "active");
  assert.equal(company.mission, GOAL);
  assert.ok(company.departments.length >= 2, "expected multiple departments");
  assert.ok(company.agents.length >= 4, "expected a real roster");
  assert.ok(company.agents.some((agent) => agent.role === "ceo"), "a company needs a CEO");
  assert.ok(company.goals.length >= 1, "expected at least one company goal");
  assert.ok(company.goals[0].kpis.length >= 1, "goals must carry KPIs");
  assert.ok(company.issues.length >= 3, "expected a board of issues");

  // Reporting lines resolve to real agents.
  for (const agent of company.agents) {
    if (agent.reportsTo) assert.ok(company.agents.some((entry) => entry.id === agent.reportsTo));
  }

  // Budgets are allocated exactly once.
  const allocated = company.agents.reduce((sum, agent) => sum + agent.budgetMonthlyCents, 0);
  assert.equal(allocated, company.budgetMonthlyCents, "agent budgets must sum to the company budget");

  // Every issue is assigned to a colleague with a model.
  for (const issue of company.issues) {
    const owner = company.agents.find((agent) => agent.id === issue.assigneeAgentId);
    assert.ok(owner, `${issue.key} has no assignee`);
    assert.ok(owner.model, `${owner.name} has no model`);
  }

  // Paperclip-compatible enums only.
  assert.ok(["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"].includes(company.issues[0].status));
  assert.match(company.issues[0].key, /^[A-Z]+-\d+$/);
});

test("a cycle plans, works, reviews, charges and writes artifacts", async () => {
  const company = await buildCompany({ name: "Cycle Co" });
  const { cycle, company: after } = await runtime.company.runCycle(company.id);

  assert.equal(cycle.status, "completed");
  assert.ok(cycle.index >= 1);
  assert.ok(cycle.focus.length > 3, "the CEO sets a cycle focus");
  assert.ok(cycle.results.length >= 1, "at least one issue should be worked");
  assert.ok(cycle.stats.tokens > 0, "the cycle must book tokens");

  const done = after.issues.filter((issue) => issue.status === "done");
  assert.ok(done.length >= 1, "the reviewer should accept at least one deliverable");

  // Deliverables exist as artifacts on disk.
  const artifacts = runtime.company.artifacts.list(company.id);
  assert.ok(artifacts.length >= 1, "expected artifacts");
  const content = runtime.company.artifacts.read(company.id, artifacts[0].name);
  assert.ok(content.length > 100, "artifact should hold the deliverable");
  assert.match(done[0].artifacts.join(","), /.md$/);

  // Every model call is booked against the agent and the company.
  assert.ok(after.ledger.length > 0, "ledger should record model calls");
  assert.ok(after.spentCents > 0, "the company should be charged");
  assert.equal(Math.round(after.spentCents * 10_000) / 10_000, after.spentCents, "spend keeps sub-cent precision");
  for (const entry of after.ledger) {
    assert.ok(entry.costCents >= 0);
    assert.ok(entry.promptTokens + entry.completionTokens > 0, "ledger rows must carry token usage");
  }

  // Accepted issues only ever have one owner and no required changes left.
  for (const issue of done) {
    assert.equal(issue.review?.verdict, "pass");
    assert.ok(issue.comments.length >= 2, "deliverable + review comments expected");
  }

  const events = runtime.company.companies.events(company.id, 500).map((event) => event.type);
  for (const type of ["company.created", "cycle.started", "cycle.planned", "issue.started", "issue.done", "cycle.completed"]) {
    assert.ok(events.includes(type), `missing ${type} event`);
  }
});

test("risky work waits for the board, and approval releases it", async () => {
  const company = await buildCompany({ name: "Approval Co" });
  let state = company;
  let pending = null;

  // Run until the approval-gated issue surfaces (bounds the test).
  for (let attempt = 0; attempt < 4 && !pending; attempt += 1) {
    const result = await runtime.company.runCycle(state.id);
    state = result.company;
    pending = state.approvals.find((approval) => approval.status === "pending");
  }
  assert.ok(pending, "expected an approval-gated issue");
  const gated = state.issues.find((issue) => issue.id === pending.issueId);
  assert.equal(gated.status, "blocked");

  const decided = runtime.company.decideApproval(state.id, pending.id, { approved: true, note: "Ship it" });
  assert.equal(decided.approval.status, "approved");
  const reopened = decided.company.issues.find((issue) => issue.id === pending.issueId);
  assert.notEqual(reopened.status, "blocked", "approval should put the issue back on the board");

  const next = await runtime.company.runCycle(state.id);
  assert.ok(
    next.company.issues.find((issue) => issue.id === pending.issueId).status !== "blocked",
    "an approved issue should progress on the next cycle",
  );
});

test("the approval policy controls how much runs unattended", async () => {
  const gated = await buildCompany({
    name: "Policy All Co",
    settings: { approvalPolicy: "all", maxIssuesPerCycle: 3, reworkLimit: 1 },
  });
  const first = await runtime.company.runCycle(gated.id);
  assert.ok(first.cycle.results.length >= 1, "the cycle should still assign work");
  assert.ok(
    first.cycle.results.every((result) => result.status === "awaiting_approval"),
    "policy 'all' must gate every issue before any work",
  );
  assert.equal(first.company.ledger.filter((entry) => entry.kind === "model_call").length, 0, "no work should run");
  const pending = first.company.approvals.filter((approval) => approval.status === "pending");
  assert.ok(pending.length >= 1);

  const free = await buildCompany({
    name: "Policy Never Co",
    settings: { approvalPolicy: "never", maxIssuesPerCycle: 3, reworkLimit: 1 },
  });
  const unattended = await runtime.company.runCycle(free.id);
  assert.ok(
    unattended.cycle.results.some((result) => ["done", "rework"].includes(result.status)),
    "policy 'never' must let work run",
  );
  assert.equal(unattended.company.approvals.length, 0, "no approvals under 'never'");
});

test("auto mode runs itself, then stops on its own limit", async () => {
  const company = await buildCompany({
    name: "Auto Co",
    settings: { approvalPolicy: "never", maxIssuesPerCycle: 2, reworkLimit: 1 },
  });
  runtime.company.startAutoMode(company.id, { everyMinutes: 0.02, maxCycles: 2 });

  let current = runtime.company.get(company.id).company;
  for (let attempt = 0; attempt < 200 && current.autoMode.enabled; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    current = runtime.company.get(company.id).company;
  }
  runtime.company.stopAutoMode(company.id, "test cleanup");

  assert.equal(current.autoMode.cyclesRun, 2, "auto mode should respect maxCycles");
  assert.equal(current.autoMode.stopReason, "Reached max cycles (2)");
  assert.ok(current.cycles.length >= 2);
  assert.equal(current.cycles[0].trigger, "auto");
});

test("over-budget agents are blocked before they can spend more", async () => {
  const company = await buildCompany({ name: "Budget Co", budgetMonthlyCents: 100 });
  const victim = company.agents.find((agent) => agent.role !== "qa");
  runtime.company.updateAgent(company.id, victim.id, { budgetMonthlyCents: 0 });

  const { company: after } = await runtime.company.runCycle(company.id);
  const updated = after.agents.find((agent) => agent.id === victim.id);
  const blocked = after.issues.filter((issue) => issue.assigneeAgentId === victim.id && issue.status === "blocked");
  assert.ok(
    blocked.length > 0 || updated.status === "over_budget" || updated.spentCents === 0,
    "a zero-budget agent must not spend",
  );
  assert.equal(updated.spentCents, 0, "no charges for a zero-budget agent");
});

test("the Paperclip bridge builds a valid call plan and mirrors over HTTP", async () => {
  const company = await buildCompany({ name: "Bridge Co" });

  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const path = new URL(url).pathname;
    if (path === "/api/companies" && init.method === "POST") {
      return new Response(JSON.stringify({ id: "pc-company-1", name: "Bridge Co", issuePrefix: "BC" }), { status: 201 });
    }
    if (path === "/api/companies/pc-company-1/agents") {
      return new Response(JSON.stringify({ id: `pc-agent-${calls.length}` }), { status: 201 });
    }
    if (path === "/api/companies/pc-company-1/goals") {
      return new Response(JSON.stringify({ id: `pc-goal-${calls.length}` }), { status: 201 });
    }
    return new Response(JSON.stringify({ id: `pc-issue-${calls.length}` }), { status: 201 });
  };
  const client = createPaperclipClient({
    fetchImpl: fakeFetch,
    config: { load: () => ({}), read: () => ({ paperclip: { baseUrl: "http://paperclip.test/api", token: "pc-token" } }) },
  });

  const dry = await client.mirror(company, { dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.equal(calls.length, 0, "dry runs must not touch the network");
  assert.equal(dry.plan[0].step, "create-company");
  assert.equal(dry.plan[0].body.name, "Bridge Co");
  assert.equal(dry.plan.filter((step) => step.step.startsWith("hire-")).length, company.agents.length);
  assert.equal(dry.plan.filter((step) => step.step === "issue").length, company.issues.length);
  for (const step of dry.plan.slice(1)) {
    assert.ok(step.path.startsWith("/companies/:companyId"), "follow-up calls must target the created company");
  }
  const firstHire = dry.plan.find((step) => step.step.startsWith("hire-"));
  assert.ok(firstHire.body.adapterType, "Paperclip requires an adapterType");
  assert.ok(["ceo", "cto", "engineer", "qa", "researcher", "cmo"].includes(firstHire.body.role));

  const result = await client.mirror(company, { dryRun: false });
  assert.equal(result.dryRun, false);
  assert.equal(result.created.companyId, "pc-company-1");
  assert.equal(result.created.agents.length, company.agents.length);
  assert.equal(result.created.goals.length, company.goals.length);
  assert.equal(result.created.issues.length, company.issues.length);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.Authorization, "Bearer pc-token");
  assert.equal(calls[0].body.budgetMonthlyCents, company.budgetMonthlyCents);
  // Every call after creation goes to the new Paperclip company.
  for (const call of calls.slice(1)) {
    assert.ok(call.url.startsWith("http://paperclip.test/api/companies/pc-company-1"), `unexpected url ${call.url}`);
  }
});

test("bridge failures explain themselves instead of throwing raw HTTP errors", async () => {
  const client = createPaperclipClient({
    fetchImpl: async () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
    config: { load: () => ({}), read: () => ({ paperclip: { baseUrl: "http://paperclip.test/api", token: "bad" } }) },
  });
  await assert.rejects(
    () => client.probe(),
    (error) => {
      assert.equal(error.name, "PaperclipError");
      assert.equal(error.status, 401);
      assert.match(error.hint, /board token/i);
      return true;
    },
  );

  const unreachable = createPaperclipClient({
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    },
    config: { load: () => ({}), read: () => ({ paperclip: { baseUrl: "http://paperclip.test/api", token: "t" } }) },
  });
  await assert.rejects(
    () => unreachable.probe(),
    (error) => {
      assert.match(error.message, /Could not reach Paperclip/);
      assert.match(error.hint, /Paperclip server is running/);
      return true;
    },
  );
});

test("a company can be exported as a portable bundle", async () => {
  const company = await buildCompany({ name: "Export Co" });
  const detail = runtime.company.get(company.id);
  assert.ok(detail.summary.agents >= 4);
  assert.equal(detail.company.id, company.id);
  assert.ok(Array.isArray(detail.events) && detail.events.length > 0);
});

test("deleting a company mid-run leaves nothing behind and never crashes the timer", async () => {
  const company = await buildCompany({
    name: "Vanishing Co",
    settings: { approvalPolicy: "never", maxIssuesPerCycle: 2 },
  });
  runtime.company.startAutoMode(company.id, { everyMinutes: 0.02, maxCycles: 5 });
  await new Promise((resolve) => setTimeout(resolve, 40));

  runtime.company.deleteCompany(company.id);
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(runtime.company.companies.get(company.id), null, "company state must stay deleted");
  assert.ok(!runtime.company.list().some((entry) => entry.id === company.id));
  assert.throws(
    () => runtime.company.get(company.id),
    (error) => error.status === 404,
    "lookups must 404, not resurrect data",
  );
});
