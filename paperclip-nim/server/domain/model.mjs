/**
 * Paperclip domain primitives: the enums and helpers every other module
 * agrees on. Keeping these in one file is what makes the board, the engine and
 * the UI speak the same language.
 */

import { newId, nowIso } from "../store.mjs";

export const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];
export const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
export const PRIORITIES = ["urgent", "high", "medium", "low"];
export const PRIORITY_WEIGHT = { urgent: 0, high: 1, medium: 2, low: 3 };
export const AGENT_STATUSES = ["active", "paused", "over_budget"];
export const APPROVAL_STATUSES = ["pending", "approved", "denied", "expired"];

export function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "company";
}

export function createAgent(overrides = {}) {
  return {
    id: overrides.id ?? newId("agent"),
    name: overrides.name ?? "New Hire",
    role: overrides.role ?? "operator",
    title: overrides.title ?? "Teammate",
    description: overrides.description ?? "",
    model: overrides.model ?? "nvidia/nemotron-3-super-120b-a12b",
    fallbackModel: overrides.fallbackModel ?? "nvidia/nemotron-nano-3-30b-a3b",
    temperature: overrides.temperature ?? 0.4,
    maxTokens: overrides.maxTokens ?? 1800,
    instructions: overrides.instructions ?? "",
    capabilities: overrides.capabilities ?? [],
    skills: overrides.skills ?? [],
    reportsTo: overrides.reportsTo ?? null,
    status: overrides.status ?? "active",
    // 0 = unlimited (the default); set a positive cap to re-enable budgeting.
    monthlyBudgetCents: overrides.monthlyBudgetCents ?? 0,
    accent: overrides.accent ?? "#76b900",
    // What this person learned from accepted work. Written only by the engine,
    // on acceptance, and shown as-is in the UI — no hidden summarisation.
    memory: overrides.memory ?? [],
    createdAt: overrides.createdAt ?? nowIso(),
  };
}

export function createIssue(company, overrides = {}) {
  const nextNumber = (company.nextIssueNumber ?? 101) + 1;
  company.nextIssueNumber = nextNumber;
  return {
    id: overrides.id ?? newId("issue"),
    key: overrides.key ?? `${company.issuePrefix ?? "NW"}-${nextNumber}`,
    title: overrides.title ?? "Untitled issue",
    description: overrides.description ?? "",
    status: overrides.status ?? "backlog",
    priority: overrides.priority ?? "medium",
    assigneeId: overrides.assigneeId ?? null,
    projectId: overrides.projectId ?? null,
    goalId: overrides.goalId ?? null,
    labels: overrides.labels ?? [],
    acceptance: overrides.acceptance ?? [],
    blockedBy: overrides.blockedBy ?? [],
    blockedReason: overrides.blockedReason ?? "",
    createdBy: overrides.createdBy ?? "system",
    createdAt: overrides.createdAt ?? nowIso(),
    updatedAt: overrides.updatedAt ?? nowIso(),
    reviewCount: overrides.reviewCount ?? 0,
    spendCents: overrides.spendCents ?? 0,
    dueAt: overrides.dueAt ?? null,
    source: overrides.source ?? "human",
  };
}

export function createGoal(overrides = {}) {
  // A goal read out of a sentence often has a target but no baseline yet — the
  // baseline is measured by the first run. Keep that "unknown" as null instead
  // of pretending it is zero, which would invent progress that never happened.
  const baseline = overrides.baseline === null ? null : overrides.baseline ?? 0;
  const target = overrides.target ?? 100;
  return {
    id: overrides.id ?? newId("goal"),
    title: overrides.title ?? "New goal",
    description: overrides.description ?? "",
    metric: overrides.metric ?? "",
    unit: overrides.unit ?? "",
    baseline,
    target,
    // "Minutes per encounter" improves downward, "notes signed" upward. Infer
    // it from the numbers so a goal authored as 12 → 4 is read correctly.
    direction: overrides.direction ?? (baseline === null ? "decrease" : Number(target) < Number(baseline) ? "decrease" : "increase"),
    current: overrides.current ?? (baseline === null ? null : 0),
    progress: overrides.progress ?? { accepted: 0, total: 0, pct: 0 },
    ownerId: overrides.ownerId ?? null,
    status: overrides.status ?? "active",
    dueAt: overrides.dueAt ?? null,
    createdAt: overrides.createdAt ?? nowIso(),
  };
}

export function createProject(overrides = {}) {
  return {
    id: overrides.id ?? newId("project"),
    name: overrides.name ?? "New project",
    description: overrides.description ?? "",
    color: overrides.color ?? "#76b900",
    status: overrides.status ?? "active",
    createdAt: overrides.createdAt ?? nowIso(),
  };
}

export function createRoutine(overrides = {}) {
  const cadenceMinutes = overrides.cadenceMinutes ?? 1440;
  return {
    id: overrides.id ?? newId("routine"),
    name: overrides.name ?? "Routine",
    instruction: overrides.instruction ?? "",
    agentId: overrides.agentId ?? null,
    cadenceMinutes,
    // A standup that follows the company's cycle length should keep following it
    // when the owner changes the rhythm.
    followsCycle: overrides.followsCycle ?? false,
    enabled: overrides.enabled ?? true,
    lastRunAt: overrides.lastRunAt ?? null,
    // First run follows the cadence, not a hardcoded day: a 5-minute standup
    // that is not due for 24 hours is a routine that never fires.
    nextRunAt: overrides.nextRunAt ?? new Date(Date.now() + cadenceMinutes * 60_000).toISOString(),
    runs: overrides.runs ?? 0,
    createdAt: overrides.createdAt ?? nowIso(),
  };
}

export function createComment(overrides = {}) {
  return {
    id: overrides.id ?? newId("comment"),
    issueId: overrides.issueId,
    authorType: overrides.authorType ?? "agent",
    authorId: overrides.authorId ?? "system",
    body: overrides.body ?? "",
    kind: overrides.kind ?? "comment",
    meta: overrides.meta ?? {},
    createdAt: overrides.createdAt ?? nowIso(),
  };
}

export function createApproval(overrides = {}) {
  return {
    id: overrides.id ?? newId("approval"),
    issueId: overrides.issueId ?? null,
    runId: overrides.runId ?? null,
    requestedBy: overrides.requestedBy ?? "system",
    reason: overrides.reason ?? "",
    risk: overrides.risk ?? "medium",
    action: overrides.action ?? "",
    status: overrides.status ?? "pending",
    decidedBy: overrides.decidedBy ?? null,
    decidedAt: overrides.decidedAt ?? null,
    note: overrides.note ?? "",
    createdAt: overrides.createdAt ?? nowIso(),
  };
}

export function createKnowledge(overrides = {}) {
  return {
    id: overrides.id ?? newId("doc"),
    title: overrides.title ?? "Untitled",
    body: overrides.body ?? "",
    tags: overrides.tags ?? [],
    source: overrides.source ?? "human",
    // Provenance for shipped work: which issue (and which agent) produced this.
    sourceIssueId: overrides.sourceIssueId ?? null,
    agentId: overrides.agentId ?? null,
    embedding: overrides.embedding ?? null,
    embedModel: overrides.embedModel ?? null,
    createdAt: overrides.createdAt ?? nowIso(),
  };
}

/* --------------------------------------------------------------- helpers */

export function findAgent(company, id) {
  return company.agents.find((agent) => agent.id === id || agent.name.toLowerCase() === String(id ?? "").toLowerCase()) ?? null;
}

export function findIssue(company, id) {
  return company.issues.find((issue) => issue.id === id || issue.key === id) ?? null;
}

export function jobTitle(agent) {
  return agent ? `${agent.name} · ${agent.title}` : "Unassigned";
}

export function agentSpend(company, agentId, { sinceDays = 30 } = {}) {
  const cutoff = Date.now() - sinceDays * 86_400_000;
  return Math.round(
    (company.ledger ?? [])
      .filter((row) => row.agentId === agentId && new Date(row.at).getTime() >= cutoff)
      .reduce((sum, row) => sum + row.costCents, 0),
  );
}

export function pushActivity(company, { kind, actorId = "system", subject = "", detail = "", issueId = null, meta = {} }) {
  const entry = {
    id: newId("act"),
    at: nowIso(),
    kind,
    actorId,
    subject,
    detail,
    issueId,
    meta,
  };
  company.activity.unshift(entry);
  if (company.activity.length > 400) company.activity.length = 400;
  return entry;
}

export function recordLedger(company, { runId, agentId, model, usage, cost, endpoint = "", simulated = false }) {
  const row = {
    id: newId("led"),
    at: nowIso(),
    runId: runId ?? null,
    agentId: agentId ?? null,
    model,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    images: usage?.images ?? 0,
    costCents: Math.max(0, Math.round((cost?.cents ?? 0) * 100) / 100),
    costDollars: cost?.dollars ?? 0,
    endpoint,
    // Simulation is a routing decision, not a secret: the ledger says so, so a
    // demo never looks like billed inference.
    simulated: Boolean(simulated),
  };
  company.ledger.unshift(row);
  if (company.ledger.length > 4000) company.ledger.length = 4000;
  return row;
}

/**
 * Spend is tracked either way; the cap only gates work when one is set.
 * `monthlyBudgetCents` of 0 (or absent) means **no limit** — the product ships
 * unlimited, and a company or agent can opt back into a ceiling at any time.
 */
export function agentSpendStatus(company, agent) {
  const spent = agentSpend(company, agent.id, { sinceDays: 30 });
  const cap = agent.monthlyBudgetCents ?? 0;
  const unlimited = !(cap > 0);
  return {
    spentCents: spent,
    capCents: unlimited ? 0 : cap,
    unlimited,
    ratio: unlimited ? 0 : spent / cap,
    // `null` rather than Infinity: every remaining-cents value is serialised to JSON.
    remainingCents: unlimited ? null : Math.max(0, cap - spent),
    overBudget: !unlimited && spent >= cap,
  };
}

/** Refresh derived counters after any mutation. */
export function recomputeCompany(company) {
  for (const agent of company.agents) {
    const status = agentSpendStatus(company, agent);
    if (agent.status !== "paused") agent.status = status.overBudget ? "over_budget" : "active";
  }
  // Goal movement is computed, never asserted: an accepted issue is the only
  // evidence that a goal advanced. Metric goals (minutes, percent) keep their
  // measured unit untouched until a run actually reports a measurement.
  for (const goal of company.goals ?? []) {
    const linked = company.issues.filter((issue) => issue.goalId === goal.id);
    const accepted = linked.filter((issue) => issue.status === "done").length;
    goal.progress = {
      accepted,
      total: linked.length,
      pct: linked.length ? Math.round((accepted / linked.length) * 100) : 0,
    };
    const countGoal = !goal.unit || goal.unit === "issues" || /deliverable/i.test(goal.metric ?? "");
    if (countGoal && goal.baseline !== null) goal.current = accepted;
  }
  company.stats = {
    agents: company.agents.length,
    activeAgents: company.agents.filter((agent) => agent.status === "active").length,
    openIssues: company.issues.filter((issue) => OPEN_STATUSES.includes(issue.status)).length,
    issuesInProgress: company.issues.filter((issue) => issue.status === "in_progress").length,
    blockedIssues: company.issues.filter((issue) => issue.status === "blocked").length,
    pendingApprovals: company.approvals.filter((approval) => approval.status === "pending").length,
    spentCents: Math.round(company.ledger.reduce((sum, row) => sum + row.costCents, 0) * 100) / 100,
    monthlyBudgetCents: company.settings.monthlyBudgetCents ?? 0,
    budgetUnlimited: !((company.settings.monthlyBudgetCents ?? 0) > 0),
    runs: company.runs.length,
    updatedAt: nowIso(),
  };
  return company;
}

export function publicCompany(company, { include = [] } = {}) {
  if (!company) return null;
  const want = new Set(include);
  const base = {
    id: company.id,
    name: company.name,
    slug: company.slug,
    mission: company.mission,
    issuePrefix: company.issuePrefix,
    createdAt: company.createdAt,
    updatedAt: company.updatedAt,
    settings: company.settings,
    stats: company.stats,
  };
  for (const key of ["agents", "goals", "projects", "issues", "routines", "approvals", "activity", "ledger", "runs", "comments", "knowledge", "artifacts"]) {
    if (want.has(key) || want.has("all")) base[key] = company[key] ?? [];
  }
  return base;
}
