import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { paths, ensureDataDirs } from "../config.mjs";

/**
 * Company store.
 *
 * Vocabulary and enums mirror Paperclip (`AGENT_ROLES`, `ISSUE_STATUSES`,
 * `ISSUE_PRIORITIES`, `GOAL_LEVELS`, `GOAL_STATUSES`) so a company built here can
 * be mirrored into a real Paperclip instance without translation loss.
 *
 *   data/companies/<id>/company.json     current state (safe to read anytime)
 *   data/companies/<id>/events.ndjson    append-only audit log
 *   data/companies/<id>/artifacts/*      deliverables produced by employees
 */

export const AGENT_ROLES = [
  "ceo",
  "cto",
  "cmo",
  "cfo",
  "security",
  "engineer",
  "designer",
  "pm",
  "qa",
  "devops",
  "researcher",
  "general",
];

export const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"];
export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"];
export const GOAL_LEVELS = ["company", "team", "agent", "task"];
export const GOAL_STATUSES = ["planned", "active", "achieved", "cancelled"];
export const COMPANY_STATUSES = ["active", "paused", "archived"];

const ALLOWED_ROLE = new Set(AGENT_ROLES);
const ALLOWED_STATUS = new Set(ISSUE_STATUSES);
const ALLOWED_PRIORITY = new Set(ISSUE_PRIORITIES);

function companyDir(id) {
  return join(paths.companies, id);
}

export function slugify(value, fallback = "company") {
  const slug = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

export function issuePrefixFor(name, existing = []) {
  const words = String(name ?? "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const base = (words.length > 1
    ? words.map((word) => word[0]).join("")
    : (words[0] ?? "co").slice(0, 3)
  ).toUpperCase().slice(0, 4) || "CO";
  let prefix = base;
  let counter = 2;
  while (existing.includes(prefix)) {
    prefix = `${base}${counter}`;
    counter += 1;
  }
  return prefix;
}

function nowIso() {
  return new Date().toISOString();
}

export function createCompanyStore() {
  ensureDataDirs();
  const listeners = new Map();

  function emitter(companyId) {
    if (!listeners.has(companyId)) listeners.set(companyId, new Set());
    return listeners.get(companyId);
  }

  const store = {
    paths,

    list() {
      ensureDataDirs();
      const dirs = readdirSync(paths.companies, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      const companies = [];
      for (const dir of dirs) {
        const file = join(paths.companies, dir.name, "company.json");
        if (!existsSync(file)) continue;
        try {
          const company = JSON.parse(readFileSync(file, "utf8"));
          companies.push({
            id: company.id,
            name: company.name,
            mission: company.mission,
            issuePrefix: company.issuePrefix,
            status: company.status,
            createdAt: company.createdAt,
            updatedAt: company.updatedAt,
            counts: summarize(company),
            autoMode: company.autoMode ?? { enabled: false },
            paperclip: company.paperclip ? { linked: true, baseUrl: company.paperclip.baseUrl } : { linked: false },
          });
        } catch {
          /* skip unreadable company */
        }
      }
      return companies.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    get(companyId) {
      const file = join(companyDir(companyId), "company.json");
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },

    save(company) {
      mkdirSync(companyDir(company.id), { recursive: true });
      company.updatedAt = nowIso();
      writeFileSync(join(companyDir(company.id), "company.json"), `${JSON.stringify(company, null, 2)}\n`);
      for (const listener of emitter(company.id)) {
        try {
          listener({ type: "state", company });
        } catch {
          /* a dead subscriber must never break a cycle */
        }
      }
      return company;
    },

    create({ name, mission, description, budgetMonthlyCents = 0, settings = {} }) {
      const existing = store.list();
      const company = {
        id: randomUUID(),
        name: String(name ?? "Untitled Company").trim().slice(0, 120),
        mission: String(mission ?? "").trim(),
        description: String(description ?? "").trim(),
        issuePrefix: issuePrefixFor(name, existing.map((entry) => entry.issuePrefix)),
        status: "active",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        currency: settings.currency ?? "USD",
        budgetMonthlyCents: Math.max(0, Math.round(Number(budgetMonthlyCents) || 0)),
        spentCents: 0,
        settings: {
          approvalPolicy: settings.approvalPolicy === "never" ? "never" : settings.approvalPolicy === "all" ? "all" : "high",
          maxIssuesPerCycle: Math.min(Math.max(Number(settings.maxIssuesPerCycle) || 3, 1), 8),
          reworkLimit: Math.min(Math.max(Number(settings.reworkLimit) || 1, 0), 3),
          pricing: settings.pricing ?? { inputCentsPerMTok: 0, outputCentsPerMTok: 0 },
          ...settings,
        },
        autoMode: { enabled: false, everyMinutes: 15, maxCycles: 20, cyclesRun: 0, lastRunAt: null, stopReason: null },
        departments: [],
        agents: [],
        projects: [],
        goals: [],
        issues: [],
        approvals: [],
        ledger: [],
        cycles: [],
        activity: [],
        paperclip: null,
        counters: { issue: 0, cycle: 0 },
      };
      // Settings.pricing must not be duplicated over the normalised defaults.
      company.settings.pricing = {
        inputCentsPerMTok: Number(settings.pricing?.inputCentsPerMTok) || 0,
        outputCentsPerMTok: Number(settings.pricing?.outputCentsPerMTok) || 0,
      };
      store.save(company);
      store.log(company, { type: "company.created", actor: "board", message: `Company "${company.name}" created` });
      return store.get(company.id);
    },

    delete(companyId) {
      const dir = companyDir(companyId);
      if (!existsSync(dir)) return false;
      listeners.get(companyId)?.clear();
      listeners.delete(companyId);
      rmSync(dir, { recursive: true, force: true });
      return true;
    },

    log(company, event) {
      const record = { ...event, at: nowIso(), id: randomUUID() };
      mkdirSync(companyDir(company.id), { recursive: true });
      appendFileSync(join(companyDir(company.id), "events.ndjson"), `${JSON.stringify(record)}\n`);
      company.activity = [...(company.activity ?? []), record].slice(-400);
      for (const listener of emitter(company.id)) {
        try {
          listener({ type: "event", event: record });
        } catch {
          /* ignore */
        }
      }
      return record;
    },

    events(companyId, limit = 400) {
      const file = join(companyDir(companyId), "events.ndjson");
      if (!existsSync(file)) return [];
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-limit);
      const events = [];
      for (const line of lines) {
        try {
          events.push(JSON.parse(line));
        } catch {
          /* tolerate a partially written tail */
        }
      }
      return events;
    },

    subscribe(companyId, listener) {
      const set = emitter(companyId);
      set.add(listener);
      return () => set.delete(listener);
    },

    /* ------------------------------ artifacts ------------------------------ */

    writeArtifact(companyId, filename, content, meta = {}) {
      const dir = join(companyDir(companyId), "artifacts");
      mkdirSync(dir, { recursive: true });
      const name = String(filename || "artifact.md").replace(/[^\w.\- ]+/g, "-").replace(/\s+/g, "-").slice(0, 120);
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
      writeFileSync(join(dir, name), buffer);
      const record = {
        name,
        bytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex").slice(0, 16),
        createdAt: nowIso(),
        ...meta,
      };
      const manifest = join(dir, "manifest.json");
      const existing = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
      writeFileSync(manifest, `${JSON.stringify([...existing.filter((entry) => entry.name !== name), record], null, 2)}\n`);
      return record;
    },

    listArtifacts(companyId) {
      const manifest = join(companyDir(companyId), "artifacts", "manifest.json");
      if (!existsSync(manifest)) return [];
      try {
        return JSON.parse(readFileSync(manifest, "utf8"));
      } catch {
        return [];
      }
    },

    readArtifact(companyId, name) {
      const file = join(companyDir(companyId), "artifacts", String(name).replace(/[^\w.\- ]+/g, "-"));
      if (!existsSync(file)) return null;
      return readFileSync(file);
    },

    /* ------------------------------ mutations ------------------------------ */

    addAgent(company, agent) {
      const role = ALLOWED_ROLE.has(agent.role) ? agent.role : "general";
      const record = {
        id: randomUUID(),
        name: String(agent.name ?? "New hire").slice(0, 80),
        role,
        title: String(agent.title ?? role.toUpperCase()).slice(0, 120),
        reportsTo: agent.reportsTo ?? null,
        departmentId: agent.departmentId ?? null,
        model: agent.model ?? null,
        temperature: typeof agent.temperature === "number" ? agent.temperature : 0.4,
        maxTokens: Number(agent.maxTokens) || 1600,
        adapter: "nvidia_nim",
        capabilities: Array.isArray(agent.capabilities) ? agent.capabilities.slice(0, 12) : [],
        skills: Array.isArray(agent.skills) ? agent.skills.slice(0, 12) : [],
        instructions: String(agent.instructions ?? "").slice(0, 4000),
        budgetMonthlyCents: Math.max(0, Math.round(Number(agent.budgetMonthlyCents) || 0)),
        spentCents: 0,
        status: "active",
        hiredAt: nowIso(),
      };
      company.agents.push(record);
      company.departments = company.departments.map((department) =>
        department.id === record.departmentId && !department.leadAgentId
          ? { ...department, leadAgentId: record.id }
          : department,
      );
      store.save(company);
      store.log(company, {
        type: "agent.hired",
        actor: "board",
        agentId: record.id,
        message: `Hired ${record.name} (${record.title})`,
      });
      return store.get(company.id);
    },

    updateAgent(company, agentId, patch) {
      const agent = company.agents.find((entry) => entry.id === agentId);
      if (!agent) return null;
      for (const key of ["name", "title", "model", "instructions", "status"]) {
        if (typeof patch[key] === "string") agent[key] = patch[key].slice(0, 4000);
      }
      if (typeof patch.temperature === "number") agent.temperature = Math.min(Math.max(patch.temperature, 0), 1.5);
      if (patch.maxTokens) agent.maxTokens = Math.min(Math.max(Number(patch.maxTokens) || 1600, 128), 8000);
      if (patch.status && ["active", "paused", "over_budget"].includes(patch.status)) agent.status = patch.status;
      if (patch.budgetMonthlyCents != null) agent.budgetMonthlyCents = Math.max(0, Math.round(Number(patch.budgetMonthlyCents) || 0));
      if (patch.reportsTo !== undefined) agent.reportsTo = patch.reportsTo || null;
      store.save(company);
      store.log(company, { type: "agent.updated", actor: "board", agentId, message: `${agent.name} updated` });
      return store.get(company.id);
    },

    removeAgent(company, agentId) {
      const agent = company.agents.find((entry) => entry.id === agentId);
      if (!agent) return null;
      if (agent.role === "ceo") return { error: "A company needs a CEO. Reassign the role instead of removing the agent." };
      company.agents = company.agents.filter((entry) => entry.id !== agentId);
      for (const issue of company.issues) {
        if (issue.assigneeAgentId === agentId) issue.assigneeAgentId = null;
      }
      for (const other of company.agents) if (other.reportsTo === agentId) other.reportsTo = null;
      store.save(company);
      store.log(company, { type: "agent.removed", actor: "board", agentId, message: `${agent.name} left the company` });
      return store.get(company.id);
    },

    addGoal(company, goal) {
      const record = {
        id: randomUUID(),
        title: String(goal.title ?? "Untitled goal").slice(0, 200),
        description: String(goal.description ?? "").slice(0, 4000),
        level: GOAL_LEVELS.includes(goal.level) ? goal.level : "company",
        status: GOAL_STATUSES.includes(goal.status) ? goal.status : "active",
        parentId: goal.parentId ?? null,
        ownerAgentId: goal.ownerAgentId ?? null,
        kpis: Array.isArray(goal.kpis)
          ? goal.kpis.slice(0, 6).map((kpi) => ({
              name: String(kpi.name ?? "KPI").slice(0, 120),
              target: String(kpi.target ?? "").slice(0, 80),
              current: String(kpi.current ?? "0").slice(0, 40),
              measure: String(kpi.measure ?? "").slice(0, 200),
              updatedAt: nowIso(),
            }))
          : [],
        createdAt: nowIso(),
      };
      company.goals.push(record);
      store.save(company);
      store.log(company, { type: "goal.created", actor: "board", message: `Goal set: ${record.title}` });
      return store.get(company.id);
    },

    addIssue(company, issue, actor = "board") {
      company.counters.issue += 1;
      const record = {
        id: randomUUID(),
        key: `${company.issuePrefix}-${company.counters.issue}`,
        title: String(issue.title ?? "Untitled task").slice(0, 240),
        description: String(issue.description ?? "").slice(0, 8000),
        status: ALLOWED_STATUS.has(issue.status) ? issue.status : "todo",
        priority: ALLOWED_PRIORITY.has(issue.priority) ? issue.priority : "medium",
        assigneeAgentId: issue.assigneeAgentId ?? null,
        projectId: issue.projectId ?? null,
        goalId: issue.goalId ?? null,
        createdBy: actor,
        acceptanceCriteria: Array.isArray(issue.acceptanceCriteria) ? issue.acceptanceCriteria.slice(0, 10).map(String) : [],
        estimate: issue.estimate ?? "M",
        blockedBy: Array.isArray(issue.blockedBy) ? issue.blockedBy.slice(0, 6) : [],
        needsApproval: Boolean(issue.needsApproval),
        comments: [],
        artifacts: [],
        review: null,
        reworks: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        closedAt: null,
      };
      company.issues.push(record);
      store.save(company);
      store.log(company, {
        type: "issue.created",
        actor,
        issueId: record.id,
        message: `${record.key} created: ${record.title}`,
      });
      return record;
    },

    comment(company, issueId, { authorType = "agent", authorAgentId = null, body }) {
      const issue = company.issues.find((entry) => entry.id === issueId);
      if (!issue) return null;
      const comment = {
        id: randomUUID(),
        authorType,
        authorAgentId,
        body: String(body ?? "").slice(0, 20_000),
        createdAt: nowIso(),
      };
      issue.comments.push(comment);
      issue.updatedAt = nowIso();
      store.save(company);
      return comment;
    },

    setIssueStatus(company, issueId, status) {
      const issue = company.issues.find((entry) => entry.id === issueId);
      if (!issue || !ALLOWED_STATUS.has(status)) return null;
      issue.status = status;
      issue.updatedAt = nowIso();
      issue.closedAt = ["done", "cancelled"].includes(status) ? nowIso() : null;
      store.save(company);
      return issue;
    },

    charge(company, entry) {
      // Sub-cent precision matters: a single call can cost a fraction of a cent,
      // so the ledger keeps 4 decimals and only the UI rounds for display.
      const cents = Math.max(0, Math.round((Number(entry.costCents) || 0) * 10_000) / 10_000);
      const agent = company.agents.find((item) => item.id === entry.agentId);
      const ledgerEntry = {
        id: randomUUID(),
        at: nowIso(),
        agentId: entry.agentId ?? null,
        issueId: entry.issueId ?? null,
        model: entry.model ?? null,
        promptTokens: entry.promptTokens ?? 0,
        completionTokens: entry.completionTokens ?? 0,
        costCents: cents,
        kind: entry.kind ?? "model_call",
        cycleId: entry.cycleId ?? null,
      };
      company.ledger = [...company.ledger, ledgerEntry].slice(-5000);
      company.spentCents = Math.round((company.spentCents + cents) * 10_000) / 10_000;
      if (agent) {
        agent.spentCents = Math.round((agent.spentCents + cents) * 10_000) / 10_000;
        const capped = agent.budgetMonthlyCents != null;
        if (capped && agent.spentCents >= agent.budgetMonthlyCents && agent.status === "active") {
          agent.status = "over_budget";
          store.log(company, {
            type: "agent.over_budget",
            actor: "finance",
            agentId: agent.id,
            message: `${agent.name} hit their monthly budget (${formatCents(agent.spentCents)} of ${formatCents(agent.budgetMonthlyCents)})`,
          });
        }
      }
      return ledgerEntry;
    },

    createApproval(company, approval) {
      const record = {
        id: randomUUID(),
        kind: approval.kind ?? "spend",
        title: String(approval.title ?? "Approval needed").slice(0, 200),
        detail: String(approval.detail ?? "").slice(0, 2000),
        requestedByAgentId: approval.requestedByAgentId ?? null,
        issueId: approval.issueId ?? null,
        amountCents: Math.max(0, Math.round(Number(approval.amountCents) || 0)),
        status: "pending",
        note: null,
        createdAt: nowIso(),
        decidedAt: null,
      };
      company.approvals.push(record);
      store.save(company);
      store.log(company, {
        type: "approval.requested",
        actor: "agent",
        agentId: record.requestedByAgentId,
        issueId: record.issueId,
        message: `Approval requested: ${record.title}`,
      });
      return record;
    },

    decideApproval(company, approvalId, { approved, note = "" }) {
      const approval = company.approvals.find((entry) => entry.id === approvalId);
      if (!approval || approval.status !== "pending") return null;
      approval.status = approved ? "approved" : "rejected";
      approval.note = String(note ?? "").slice(0, 2000);
      approval.decidedAt = nowIso();
      if (approval.issueId) {
        const issue = company.issues.find((entry) => entry.id === approval.issueId);
        if (issue) {
          issue.needsApproval = false;
          issue.status = approved ? "todo" : "blocked";
          issue.updatedAt = nowIso();
        }
      }
      store.save(company);
      store.log(company, {
        type: approved ? "approval.approved" : "approval.rejected",
        actor: "board",
        issueId: approval.issueId,
        message: `${approved ? "Approved" : "Rejected"}: ${approval.title}`,
      });
      return approval;
    },
  };

  return store;
}

export function summarize(company) {
  const issues = company.issues ?? [];
  return {
    agents: company.agents?.length ?? 0,
    departments: company.departments?.length ?? 0,
    goals: company.goals?.length ?? 0,
    projects: company.projects?.length ?? 0,
    issues: issues.length,
    open: issues.filter((issue) => !["done", "cancelled"].includes(issue.status)).length,
    done: issues.filter((issue) => issue.status === "done").length,
    blocked: issues.filter((issue) => issue.status === "blocked").length,
    pendingApprovals: (company.approvals ?? []).filter((approval) => approval.status === "pending").length,
    cycles: company.cycles?.length ?? 0,
    spentCents: company.spentCents ?? 0,
    budgetMonthlyCents: company.budgetMonthlyCents ?? 0,
    tokens:
      (company.ledger ?? []).reduce((sum, entry) => sum + (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0), 0),
  };
}

export function formatCents(cents) {
  return `$${((Number(cents) || 0) / 100).toFixed(2)}`;
}

/** Charge for one model call using the company's configured rates (cents / 1M tokens). */
export function costFor(company, usage) {
  const pricing = company.settings?.pricing ?? {};
  const input = Number(pricing.inputCentsPerMTok) || 0;
  const output = Number(pricing.outputCentsPerMTok) || 0;
  const costCents = ((usage?.promptTokens ?? 0) / 1_000_000) * input + ((usage?.completionTokens ?? 0) / 1_000_000) * output;
  return Math.round(costCents * 100) / 100;
}
