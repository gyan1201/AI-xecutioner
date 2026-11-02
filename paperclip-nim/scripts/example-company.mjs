/**
 * Example company benchmark.
 *
 * Launches "Signal Desk" from one sentence, runs five cycles against a throwaway
 * data dir, and prints the numbers this repo is judged on: shipped work, accept
 * rate, cost per shipped issue, routines fired, goal progress, and whether every
 * accepted issue left something behind for the next cycle.
 *
 *   npm run bench                # writes to ./.bench-data by default
 *   BENCH_DIR=/tmp/x node scripts/example-company.mjs
 *
 * It never touches ./data and never reaches the network: the NIM client is
 * forced into simulation, so every ledger row it writes says `simulated: true`.
 */
import { spawn } from "node:child_process";
import { rm, mkdir } from "node:fs/promises";

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(process.env.BENCH_DIR ?? join(ROOT, ".bench-data"));
const PORT = Number(process.env.BENCH_PORT ?? 8883);
const BASE = `http://127.0.0.1:${PORT}`;
const GOAL =
  "Cut support response time to under five minutes with an AI triage copilot that cites the policy it used";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const c = (cents) => `$${(Math.round(cents) / 100).toFixed(2)}`;

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 400)}`);
  return json;
}

await rm(DATA, { recursive: true, force: true });
await mkdir(DATA, { recursive: true });

const server = spawn(process.execPath, ["server/index.mjs"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), PAPERCLIP_DATA_DIR: DATA, FORCE_SIMULATION: "1", NODE_ENV: "test" },
  stdio: ["ignore", "pipe", "pipe"],
});
const logs = [];
server.stdout.on("data", (chunk) => logs.push(String(chunk)));
server.stderr.on("data", (chunk) => logs.push(String(chunk)));

let up = false;
for (let attempt = 0; attempt < 60; attempt += 1) {
  try {
    await api("/api/health");
    up = true;
    break;
  } catch {
    await sleep(500);
  }
}
if (!up) {
  console.error(logs.join(""));
  throw new Error("server did not start");
}

const startedAt = Date.now();
const launched = await api("/api/launch", {
  method: "POST",
  body: { name: "Signal Desk", goal: GOAL, verify: false },
});
const companyId = launched.company.id;
let company = launched.company;
const firstBoardMs = Date.now() - startedAt;

console.log(`launched ${company.name} (${companyId}) in ${firstBoardMs} ms`);
const planInfo = launched.launch?.plan ?? {};
console.log(`blueprint: ${planInfo.blueprint?.name ?? "?"} (${planInfo.blueprint?.category ?? "?"})`);
console.log(`goal: ${company.goals[0]?.metric} ${company.goals[0]?.baseline ?? "unmeasured"} → ${company.goals[0]?.target} ${company.goals[0]?.unit ?? ""} (${company.goals[0]?.direction})`);
for (const agent of company.agents) {
  console.log(`  - ${agent.name} · ${agent.title} · ${agent.model} · ${(agent.skills ?? []).join(", ")}`);
}

await api(`/api/companies/${companyId}`, { method: "PATCH", body: { settings: { cycleMinutes: 5, maxCycles: 0 } } });

const cycleRows = [];
for (let index = 1; index <= 4; index += 1) {
  const started = Date.now();
  const result = await api(`/api/companies/${companyId}/cycle`, { method: "POST", body: { maxIssues: 2 } });
  cycleRows.push({
    index,
    ms: Date.now() - started,
    focus: result.plan?.focus ?? "",
    ran: result.results?.length ?? 0,
    accepted: (result.results ?? []).filter((row) => row.verdict === "accepted").length,
    costCents: Math.round((result.results ?? []).reduce((sum, row) => sum + (row.costCents ?? 0), 0) * 100) / 100,
    routine: result.cycle?.routine ?? null,
  });
  console.log(`cycle ${index}: ${cycleRows.at(-1).ran} ran · ${cycleRows.at(-1).accepted} accepted · ${c(cycleRows.at(-1).costCents)} · ${Math.round(cycleRows.at(-1).ms / 1000)}s · ${cycleRows.at(-1).focus.slice(0, 90)}`);
}

// Give the standup routine its chance to fire on the next cycle.
await sleep(2000);
const fifth = await api(`/api/companies/${companyId}/cycle`, { method: "POST", body: { maxIssues: 1 } });
console.log(`cycle 5 (routine check): ${fifth.results?.length ?? 0} ran`);

company = await api(`/api/companies/${companyId}`);
const issues = company.issues;
const runs = company.runs;
const shipped = issues.filter((issue) => issue.status === "done");
const accepted = runs.filter((run) => run.review?.verdict === "accepted");
const rework = runs.filter((run) => run.review?.verdict === "changes_requested" || run.review?.verdict === "rejected");
const workRuns = runs.filter((run) => run.kind === "work");
const spend = company.ledger.reduce((sum, row) => sum + row.costCents, 0);
const perShipped = shipped.length ? spend / shipped.length : 0;

console.log("\n== company ==");
console.log(`cycles: ${company.cycleHistory.length}`);
console.log(`work runs: ${workRuns.length} · accepted ${accepted.length} · rework ${rework.length} · accept rate ${Math.round((accepted.length / Math.max(1, accepted.length + rework.length)) * 100)}%`);
console.log(`shipped: ${shipped.length}/${issues.length} · artifacts ${company.artifacts.length} · spend ${c(spend)} · ${c(perShipped)} per shipped issue`);
console.log(`routines: ${company.routines.map((routine) => `${routine.name}: ${routine.runs} runs (every ${routine.cadenceMinutes}m)`).join(", ") || "none"}`);
const goal = company.goals[0];
console.log(`goal: ${goal?.metric} · baseline ${goal?.baseline ?? "unmeasured"} → ${goal?.current ?? "unmeasured"} → ${goal?.target} ${goal?.unit ?? ""} · progress ${JSON.stringify(goal?.progress)}`);
console.log(`measurements: ${goal?.measurements?.length ?? 0}${goal?.measurements?.[0] ? ` · latest ${goal.measurements[0].value} ${goal.measurements[0].unit} (${goal.measurements[0].kind}) from ${goal.measurements[0].issueKey}` : ""}`);
console.log(`knowledge docs: ${company.knowledge.length} · agent memory: ${company.agents.filter((agent) => (agent.memory ?? []).length).length}/${company.agents.length}`);
console.log(`ledger rows: ${company.ledger.length} · simulated only: ${company.ledger.every((row) => row.simulated)}`);

console.log("\n== per issue ==");
for (const issue of issues) {
  const issueRuns = runs.filter((run) => run.issueId === issue.id && run.kind === "work");
  console.log(`  ${issue.key} [${issue.status}/${issue.priority}] runs=${issueRuns.length} · ${issue.title.slice(0, 60)}`);
}

console.log("\n== per agent ==");
for (const agent of company.agents) {
  const agentRuns = workRuns.filter((run) => run.agentId === agent.id);
  const otherRuns = runs.filter((run) => run.agentId === agent.id && run.kind !== "work");
  const ok = agentRuns.filter((run) => run.review?.verdict === "accepted").length;
  const cost = runs.filter((run) => run.agentId === agent.id).reduce((sum, run) => sum + (run.costCents ?? 0), 0);
  console.log(`  ${agent.name.padEnd(18)} ${agent.title.padEnd(24)} ${agentRuns.length} work · ${otherRuns.length} plan/standup · ${ok} accept · ${c(cost)} · ${Math.round((ok / Math.max(1, agentRuns.length)) * 100)}%`);
}

console.log("\n== focus per cycle ==");
for (const row of cycleRows) console.log(`  ${row.index}: ${row.focus}`);

console.log("\n== verdicts ==");
const checks = [
  ["launch produces a real roster", company.agents.length >= 3],
  ["skills are distinct per agent", new Set(company.agents.map((agent) => (agent.skills ?? []).sort().join("|"))).size === company.agents.length],
  ["goal metric read from the sentence", !/accepted deliverables/.test(company.goals[0]?.metric ?? "")],
  ["goal has moved", (company.goals[0]?.progress?.accepted ?? 0) > 0],
  ["goal metric was measured", (company.goals[0]?.measurements?.length ?? 0) > 0],
  ["measurement came from accepted work", (company.goals[0]?.measurements ?? []).every((entry) => company.issues.find((issue) => issue.id === entry.issueId)?.status === "done")],
  ["a routine fired", company.routines.some((routine) => (routine.runs ?? 0) > 0)],
  ["every issue got at least one run", issues.every((issue) => runs.some((run) => run.issueId === issue.id && run.kind === "work"))],
  ["all issues shipped", shipped.length === issues.length],
  ["accept rate above 75%", accepted.length / Math.max(1, accepted.length + rework.length) > 0.75],
  ["planning changes per cycle", new Set(cycleRows.map((row) => row.focus)).size >= 3],
  ["every accepted issue left a knowledge doc", shipped.every((issue) => company.knowledge.some((doc) => doc.sourceIssueId === issue.id))],
  ["accepted work wrote agent memory", company.agents.filter((agent) => (agent.memory ?? []).length).length >= 1],
  ["ledger is honest", company.ledger.every((row) => row.simulated)],
];
for (const [label, pass] of checks) console.log(`  ${pass ? "PASS" : "FAIL"}  ${label}`);
console.log(`  ${checks.filter(([, pass]) => pass).length}/${checks.length} checks`);

server.kill("SIGTERM");
await sleep(300);
process.exit(0);
