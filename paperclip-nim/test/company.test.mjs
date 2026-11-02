/**
 * Company-quality tests: a launched company has to look like a real company.
 *
 * These cover the four things that made the Signal Desk run read like a
 * template: the same two skills for every hire, a metric nobody chose, routines
 * that never fired, and a plan that repeated itself while three issues starved.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const dataDir = mkdtempSync(join(tmpdir(), "paperclip-nim-company-"));
process.env.PAPERCLIP_DATA_DIR = dataDir;
delete process.env.NVIDIA_API_KEY;
delete process.env.NIM_API_KEY;

const { createRuntime } = await import("../server/runtime.mjs");
const { deriveGoal, planForGoal, matchBlueprint, goalTitle } = await import("../server/domain/launch.mjs");
const { createGoal, createIssue, recordGoalMeasurement } = await import("../server/domain/model.mjs");
const { goalPill, goalProgress, goalTarget } = await import("../web/views/shared.js");

const runtime = createRuntime({ logger: { log() {}, warn() {}, error() {} } });
const service = runtime.service;
const engine = runtime.engine;
runtime.catalog.live = false;

after(() => {
  runtime.store.flush?.();
  rmSync(dataDir, { recursive: true, force: true });
});

/* --------------------------------------------------------------- metrics */

test("a goal sentence yields a metric with a unit, a target and a direction", () => {
  const support = deriveGoal("Cut support response time to under five minutes with an AI triage copilot");
  assert.equal(support.unit, "min");
  assert.equal(support.target, 5);
  assert.equal(support.direction, "decrease");
  assert.equal(support.baseline, null, "no baseline was stated, so none is invented");
  assert.match(support.metric, /support response time/);

  const clinical = deriveGoal("Cut clinician documentation time from 12 minutes to under 4 per encounter");
  assert.equal(clinical.baseline, 12);
  assert.equal(clinical.target, 4);

  const weeks = deriveGoal("Deploy a manipulation policy to a new cell in 5 days instead of 6 weeks");
  assert.equal(weeks.target, 5, "the target is the first number when 'instead of' flips the sentence");
  assert.equal(weeks.baseline, 42, "weeks are converted to the target's unit");

  const percent = deriveGoal("Cut cloud spend by 40% while keeping p95 latency under 300 ms");
  assert.equal(percent.unit, "%");
  assert.equal(percent.target, 60);
  assert.match(percent.metric, /cloud spend/);

  assert.equal(deriveGoal("Make the best analytics product in the world"), null);

  // A stated baseline is the starting point, not zero: 12 → 4 is 0% moved on
  // day one, not 100%.
  const stated = createGoal({ title: "Clinical", metric: "documentation time", unit: "min", baseline: 12, target: 4, direction: "decrease" });
  assert.equal(stated.current, 12, "a stated baseline is the current value until it is measured");
  assert.equal(goalProgress(stated), 0);
  const unmeasured = createGoal({ title: "Support", metric: "response time", unit: "min", target: 5, baseline: null });
  assert.equal(unmeasured.current, null, "an unmeasured goal has no current value");
});

test("the launched goal keeps the user's number, not the blueprint's placeholder", () => {
  const plan = planForGoal({ name: "Signal Desk", goal: "Cut support response time to under five minutes" });
  assert.equal(plan.goal.metric, "support response time");
  assert.equal(plan.goal.target, 5);
  assert.equal(plan.goal.unit, "min");
  assert.notEqual(plan.goal.metric, "accepted deliverables");
  assert.match(plan.goal.title, /support response time/i);
});

/* ------------------------------------------------------------- staffing */

test("a support goal staffs a contact-centre team with different skills per hire", () => {
  const plan = planForGoal({
    name: "Signal Desk",
    goal: "Cut support response time to under five minutes with an AI triage copilot that cites the policy it used",
  });
  assert.equal(plan.blueprint.id, "contact-center");
  const signatures = plan.agents.map((agent) => (agent.skills ?? []).slice().sort().join("|"));
  assert.ok(signatures.every((signature) => signature.split("|").filter(Boolean).length >= 2), "every hire gets skills");
  assert.equal(new Set(signatures).size, plan.agents.length, "two agents must not carry the same pair");
});

test("a physical-AI goal lands on the robotics cell, not a guardrails blueprint", () => {
  const goal =
    "Ship a robot manipulation policy learned from teleoperation video that cuts pick-and-place deployment from 6 weeks to 5 days";
  const match = matchBlueprint(goal);
  assert.equal(match.blueprintId, "physical-ai-robotics");
  const plan = planForGoal({ name: "Cell Works", goal });
  assert.equal(plan.goal.baseline, 42);
  assert.equal(plan.goal.target, 5);
  assert.ok(plan.issues.some((issue) => /teleoperation/i.test(issue.title)), "the backlog is about teleoperation");
});

/* ------------------------------------------------------------- routines */

test("the launch standup is due immediately and follows the company's cycle length", () => {
  return (async () => {
    const plan = planForGoal({ name: "Heartbeat Co", goal: "Cut support response time to under five minutes" });
    const launched = await service.launchCompany({ name: "Heartbeat Co", mission: plan.goal.description, plan, runCycle: false });
    const companyId = launched.company.id;
    const routine = runtime.store.getCompany(companyId).routines[0];
    assert.equal(routine.followsCycle, true);
    assert.ok(new Date(routine.nextRunAt).getTime() <= Date.now() + 1000, "a routine that is not due for a day never fires");

    service.updateCompany(companyId, { settings: { cycleMinutes: 5 } });
    const updated = runtime.store.getCompany(companyId).routines[0];
    assert.equal(updated.cadenceMinutes, 5, "the standup runs on the company's rhythm");
  })();
});

test("a cycle dispatches the routines that came due", async () => {
  const plan = planForGoal({ name: "Routine Co", goal: "Cut support response time to under five minutes" });
  const launched = await service.launchCompany({ name: "Routine Co", mission: plan.goal.description, plan, runCycle: false });
  const companyId = launched.company.id;
  const before = runtime.store.getCompany(companyId).routines[0].runs ?? 0;
  await engine.planCycle({ companyId, maxIssues: 1 });
  const routine = runtime.store.getCompany(companyId).routines[0];
  assert.ok(routine.runs > before, "nextRunAt alone is not a scheduler");
  assert.ok(new Date(routine.nextRunAt).getTime() > Date.now(), "the next run is scheduled forward");
  const company = runtime.store.getCompany(companyId);
  const routineRun = company.runs.find((run) => run.kind === "routine");
  assert.ok(routineRun, "a routine leaves a run row, not just an activity entry");
  assert.equal(routineRun.status, "succeeded");
  assert.ok(company.ledger.some((row) => row.runId === routineRun.id), "scheduled work is billed like any other call");
  assert.equal(company.ledger.filter((row) => row.runId === routineRun.id).every((row) => row.simulated), true);
});

/* ------------------------------------------------------ fair work + goal */

test("cycles spread work across the board instead of starving the tail", async () => {
  const goal = "Cut support response time to under five minutes with an AI triage copilot";
  const plan = planForGoal({ name: "Fair Work Co", goal });
  const launched = await service.launchCompany({ name: "Fair Work Co", mission: goal, plan, runCycle: false });
  const companyId = launched.company.id;
  for (let index = 0; index < 2; index += 1) await engine.planCycle({ companyId, maxIssues: 2 });
  const company = runtime.store.getCompany(companyId);
  const touched = new Set(company.runs.filter((run) => run.kind === "work" && run.issueId).map((run) => run.issueId));
  assert.ok(touched.size >= 4, `two cycles of two should touch four distinct issues, touched ${touched.size}`);
});

test("goal progress is written from accepted work, never asserted", async () => {
  const goal = "Cut support response time to under five minutes";
  const plan = planForGoal({ name: "Progress Co", goal });
  const launched = await service.launchCompany({ name: "Progress Co", mission: goal, plan, runCycle: false });
  const companyId = launched.company.id;
  await engine.planCycle({ companyId, maxIssues: 2 });
  const company = runtime.store.getCompany(companyId);
  const activeGoal = company.goals[0];
  assert.equal(activeGoal.progress.total, company.issues.filter((issue) => issue.goalId === activeGoal.id).length);
  assert.equal(activeGoal.progress.accepted, company.issues.filter((issue) => issue.goalId === activeGoal.id && issue.status === "done").length);
  // A metric goal's current value is never a placeholder count: it is either
  // unmeasured (null) or backed by a measurement an accepted run recorded.
  if (activeGoal.current === null) {
    assert.equal(activeGoal.progress.metricPct, null, "no measurement means no metric percentage");
  } else {
    assert.ok(activeGoal.measurements.length > 0, "a current value must come from a measurement");
    assert.ok(
      activeGoal.measurements.some((entry) => company.issues.find((issue) => issue.id === entry.issueId)?.status === "done"),
      "the measurement must come from accepted work",
    );
    assert.ok(activeGoal.progress.metricPct >= 0 && activeGoal.progress.metricPct <= 100);
  }
});

test("an accepted baseline issue measures the goal, and later work moves the metric", async () => {
  const goal = "Cut support response time to under five minutes";
  const plan = planForGoal({ name: "Measure Co", goal });
  const launched = await service.launchCompany({ name: "Measure Co", mission: goal, plan, runCycle: false });
  const companyId = launched.company.id;
  let company = runtime.store.getCompany(companyId);
  const baselineIssue = company.issues.find((issue) => /baseline/i.test(issue.title));
  assert.ok(baselineIssue, "the launch backlog includes the issue that measures the baseline");

  const baselineRun = await engine.runIssue({ companyId, issueId: baselineIssue.id, actorId: "test" });
  assert.equal(baselineRun.verdict?.verdict, "accepted", "the simulated reviewer accepts the baseline issue");
  company = runtime.store.getCompany(companyId);
  const goalAfterBaseline = company.goals[0];
  assert.notEqual(goalAfterBaseline.baseline, null, "the measured baseline is recorded on the goal");
  assert.equal(goalAfterBaseline.current, goalAfterBaseline.baseline);
  assert.ok(goalAfterBaseline.measurements.length >= 1);
  assert.equal(goalAfterBaseline.measurements[0].kind, "baseline");
  assert.equal(company.issues.find((issue) => issue.id === baselineIssue.id).measurement.value, goalAfterBaseline.baseline);

  // A follow-up measurement moves current toward the target, without ever
  // claiming a number the reviewer did not see.
  const followUp = {
    title: "Measure support response time after the baseline",
    description: "Run the support response time check on the new triage path and record the measured value with its source.",
    acceptance: ["A measured support response time value with its source", "Compared to the target, with the gap named"],
    status: "todo",
    priority: "high",
    assigneeId: company.agents.find((agent) => agent.role === "operator")?.id ?? company.agents[0].id,
    goalId: goalAfterBaseline.id,
    labels: ["follow-up"],
    createdBy: "test",
  };
  const created = await service.createIssue(companyId, followUp);
  const followUpRun = await engine.runIssue({ companyId, issueId: created.issue.id, actorId: "test" });
  assert.equal(followUpRun.verdict?.verdict, "accepted", "the follow-up measurement is accepted");
  company = runtime.store.getCompany(companyId);
  const goalAfterFollowUp = company.goals[0];
  assert.notEqual(goalAfterFollowUp.current, goalAfterBaseline.baseline, "the metric moved");
  assert.ok(goalAfterFollowUp.measurements.length >= 2);
  assert.equal(goalAfterFollowUp.measurements[0].kind, "current");
  const span = Math.abs(goalAfterBaseline.target - goalAfterBaseline.baseline);
  const moved = Math.abs(goalAfterFollowUp.current - goalAfterBaseline.baseline);
  assert.ok(moved > 0 && moved <= span, "the measurement moves toward the target without overshooting it");
  assert.ok(goalAfterFollowUp.progress.metricPct > 0 && goalAfterFollowUp.progress.metricPct <= 100);
});

test("a measurement is evidence: invalid values and mismatched units are ignored", () => {
  const company = { nextIssueNumber: 100, issuePrefix: "T" };
  const goal = createGoal({ title: "Cut latency", metric: "latency", unit: "min", target: 5, baseline: null });
  const baselineIssue = createIssue(company, { title: "Lock the baseline for latency", goalId: goal.id });
  assert.equal(recordGoalMeasurement(company, goal, baselineIssue, { value: "nope" }, null, null), null);
  assert.equal(recordGoalMeasurement(company, goal, baselineIssue, { value: 8, unit: "kg" }, null, null), null);
  const baseline = recordGoalMeasurement(company, goal, baselineIssue, { value: 8, unit: "minutes" }, null, null);
  assert.ok(baseline, "a valid measurement with an equivalent unit is recorded");
  assert.equal(baseline.kind, "baseline");
  assert.equal(goal.baseline, 8);
  assert.equal(goal.current, 8);
  assert.equal(baselineIssue.measurement.value, 8);

  const currentIssue = createIssue(company, { title: "Measure latency again", goalId: goal.id });
  const current = recordGoalMeasurement(company, goal, currentIssue, { value: 6, unit: "min", source: "run trace" }, null, null);
  assert.ok(current);
  assert.equal(current.kind, "current");
  assert.equal(goal.current, 6);
  assert.equal(goal.progress.metricPct, 67, "6 is two thirds of the way from 8 to 5");

  // Without a baseline, only the issue that measures the starting point counts.
  const unmeasured = createGoal({ title: "Cut latency", metric: "latency", unit: "min", target: 5, baseline: null });
  const otherIssue = createIssue(company, { title: "Build the pipeline", goalId: unmeasured.id });
  assert.equal(recordGoalMeasurement(company, unmeasured, otherIssue, { value: 6, unit: "min" }, null, null), null);
  assert.equal(unmeasured.current, null);
});

test("an empty board with shipped work opens the next measurement", async () => {
  const goal = "Cut support response time to under five minutes";
  const plan = planForGoal({ name: "Refill Co", goal });
  const launched = await service.launchCompany({ name: "Refill Co", mission: goal, plan, runCycle: false });
  const companyId = launched.company.id;
  const doc = runtime.store.getCompany(companyId);
  // Every issue is shipped: the board is empty, the company is not finished.
  for (const issue of doc.issues) issue.status = "done";
  runtime.store.saveCompany(doc);
  const before = doc.issues.length;
  await engine.planCycle({ companyId, maxIssues: 1 });
  const afterCycles = runtime.store.getCompany(companyId);
  assert.ok(afterCycles.issues.length > before, "the next cycle should open grounded follow-up work");
  const created = afterCycles.issues.filter((issue) => (issue.labels ?? []).includes("follow-up"));
  assert.ok(created.length >= 1 && created.length <= 2, `at most two follow-ups per cycle, got ${created.length}`);
  assert.ok(created.every((issue) => /support response time|follow-up/i.test(issue.title)), "follow-ups reference the goal");
});

test("accepted work is remembered in agent memory and citable knowledge", async () => {
  const goal = "Cut support response time to under five minutes";
  const plan = planForGoal({ name: "Memory Co", goal });
  const launched = await service.launchCompany({ name: "Memory Co", mission: goal, plan, runCycle: false });
  const companyId = launched.company.id;
  const before = runtime.store.getCompany(companyId);
  const issue = before.issues.find((entry) => entry.status !== "done");
  const result = await engine.runIssue({ companyId, issueId: issue.id, actorId: "test" });
  const company = runtime.store.getCompany(companyId);
  const updated = company.issues.find((entry) => entry.id === issue.id);
  const agent = company.agents.find((entry) => entry.id === updated.assigneeId);
  if (updated.status === "done") {
    assert.ok((agent.memory ?? []).length >= 1, "an accepted issue leaves a memory entry");
    assert.equal(agent.memory[0].issueKey, issue.key);
    assert.ok(company.knowledge.some((doc) => doc.sourceIssueId === issue.id), "the deliverable becomes a knowledge document");
  } else {
    assert.equal(result.issue.status, "todo", "a rejected deliverable writes no memory");
    assert.equal((agent.memory ?? []).length, 0);
  }
});

test("goalTitle keeps the goal sentence readable", () => {
  const title = goalTitle("Cut support response time to under five minutes with an AI triage copilot that cites the policy it used");
  assert.ok(title.length <= 140);
  assert.match(title, /^Cut support response time/);
});

test("an unmeasured metric goal shows work accepted, not a fake percentage", () => {
  const goal = { metric: "support response time", unit: "min", baseline: null, target: 5, direction: "decrease", progress: { accepted: 3, total: 6, pct: 50 } };
  assert.equal(goalTarget(goal), "target 5 min");
  assert.equal(goalPill(goal), "3/6 accepted");
  assert.equal(goalProgress(goal), 0.5);
  // A measured goal keeps its distance-closed maths.
  const measured = { baseline: 12, current: 8, target: 4, unit: "min" };
  assert.equal(goalProgress(measured), 0.5);
  assert.equal(goalTarget(measured), "8 → 4 min");
  assert.equal(goalPill(measured), "50%");
});
