import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NIM_SIMULATION = "1";
process.env.NVIDIA_AUTOPILOT_DATA_DIR = mkdtempSync(join(tmpdir(), "nvidia-autopilot-test-"));

const { createRuntime } = await import("../server/runtime.mjs");

const TERMINAL = new Set(["completed", "completed_with_issues", "blocked", "failed", "cancelled"]);

async function waitFor(fn, { timeoutMs = 15_000, intervalMs = 25 } = {}) {
  const startedAt = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Drive a run to a terminal state, approving any human gates on the way. */
async function settle(rt, runId, { autoApprove = true, timeoutMs = 30_000 } = {}) {
  return waitFor(() => {
    const current = rt.autopilot.get(runId);
    if (!current) return null;
    if (TERMINAL.has(current.status)) return current;
    if (autoApprove && current.status === "awaiting_approval") {
      rt.autopilot.approve(runId, { approved: true, note: "Auto-approved in test" });
    }
    return null;
  }, { timeoutMs });
}

const GOAL = "Launch the Q3 self-serve onboarding motion and grow activated accounts by 20%.";

function runtime() {
  const instance = createRuntime();
  return instance;
}

test("autopilot completes a full goal end-to-end in simulation", async () => {
  const rt = runtime();
  await rt.loadModels();
  const run = await rt.autopilot.start({ goal: GOAL, company: "Northwind Labs" });
  assert.equal(run.status, "queued");

  const finished = await settle(rt, run.id);

  assert.ok(["completed", "completed_with_issues"].includes(finished.status), `unexpected status ${finished.status}`);
  assert.ok(finished.plan, "plan should be persisted");
  assert.ok(finished.plan.kpis.length > 0, "plan should define KPIs");
  assert.ok(finished.tasks.length >= 3, "plan should have several work items");
  assert.ok(finished.tasks.every((task) => ["done", "blocked"].includes(task.status)), "every task should settle");

  const completed = finished.tasks.filter((task) => task.status === "done");
  assert.ok(completed.length >= 2, "at least two work items should complete");
  assert.ok(completed.every((task) => task.critique), "each completed task should be reviewed");
  assert.ok(finished.usage.calls >= finished.tasks.length, "usage should be tracked per call");
  assert.ok(finished.usage.totalTokens > 0);
  assert.ok(finished.report?.markdown.includes("# Executive report"));

  const artifacts = rt.store.listArtifacts(run.id);
  const names = artifacts.map((artifact) => artifact.name);
  assert.ok(names.includes("executive-report.md"), `report artifact missing: ${names.join(", ")}`);
  assert.ok(names.filter((name) => /^t\d+\.md$/.test(name)).length >= 2, "task deliverables should be saved");

  const events = rt.store.readEvents(run.id);
  const types = new Set(events.map((event) => event.type));
  for (const type of [
    "run.created",
    "guardrail",
    "plan.ready",
    "task.started",
    "task.critique",
    "task.completed",
    "report.ready",
    "run.finished",
  ]) {
    assert.ok(types.has(type), `missing event type ${type}`);
  }
  // Every model call must name a concrete model; a missing role model is a bug.
  for (const event of events.filter((entry) => entry.type === "usage")) {
    assert.equal(typeof event.model, "string");
    assert.ok(event.model.length > 2, "usage events must record the model id");
  }
  // Guardrails must run on the goal and on each shipped output, not just tools.
  const guardrails = events.filter((event) => event.type === "guardrail");
  assert.ok(guardrails.some((event) => event.scope === "goal"), "the goal should be screened");
  assert.ok(guardrails.some((event) => event.scope === "output"), "outputs should be screened");
  // Event sequence numbers must be strictly increasing for replay.
  const sequences = events.map((event) => event.seq);
  assert.deepEqual(sequences, [...new Set(sequences)].sort((a, b) => a - b));
});

test("autopilot can pause, resume and cancel", async () => {
  const rt = runtime();
  await rt.loadModels();
  const run = await rt.autopilot.start({ goal: GOAL, options: { maxSteps: 4 } });

  rt.autopilot.pause(run.id);
  const paused = await waitFor(() => {
    const current = rt.autopilot.get(run.id);
    return current.status === "paused" || TERMINAL.has(current.status) ? current : null;
  });
  assert.ok(["paused", "completed", "completed_with_issues"].includes(paused.status));

  const resumed = rt.autopilot.resume(run.id);
  assert.ok(resumed);
  const settled = await settle(rt, run.id, { timeoutMs: 25_000 });
  assert.ok(["completed", "completed_with_issues"].includes(settled.status));

  const cancelledRun = await rt.autopilot.start({ goal: GOAL });
  rt.autopilot.cancel(cancelledRun.id);
  const cancelled = await waitFor(() => {
    const current = rt.autopilot.get(cancelledRun.id);
    return current.status === "cancelled" ? current : null;
  });
  assert.equal(cancelled.status, "cancelled");
});

test("approval policy gates high-risk work until a human decides", async () => {
  const rt = runtime();
  await rt.loadModels();
  const run = await rt.autopilot.start({
    goal: GOAL,
    options: { requireApproval: "all", maxSteps: 3, concurrency: 1 },
  });

  const waiting = await waitFor(() => {
    const current = rt.autopilot.get(run.id);
    return current.status === "awaiting_approval" ? current : null;
  });
  assert.ok(waiting.pendingApproval?.question, "a concrete approval question should be raised");

  const approval = rt.autopilot.approve(run.id, { approved: true, note: "Approved in test" });
  assert.equal(approval.resolved, true);

  // Every remaining work item also requires approval; keep approving until done.
  await waitFor(async () => {
    const current = rt.autopilot.get(run.id);
    if (current.status === "awaiting_approval") {
      rt.autopilot.approve(run.id, { approved: true, note: "Approved" });
      return false;
    }
    return TERMINAL.has(current.status);
  }, { timeoutMs: 20_000 });

  const finished = rt.autopilot.get(run.id);
  assert.ok(["completed", "completed_with_issues"].includes(finished.status));
  assert.ok(finished.approvals.length >= 1);
});

test("token budget stops a run with an explicit blocker", async () => {
  const rt = runtime();
  await rt.loadModels();
  const run = await rt.autopilot.start({ goal: GOAL, options: { maxTokens: 5_000, maxSteps: 6, requireApproval: "never" } });
  const finished = await settle(rt, run.id, { timeoutMs: 20_000 });
  assert.equal(finished.status, "blocked");
  assert.match(finished.blockedReason ?? "", /Token budget/);
});

test("rejects goals that are too vague to execute", async () => {
  const rt = runtime();
  await assert.rejects(() => rt.autopilot.start({ goal: "grow" }), /at least a sentence/);
});
