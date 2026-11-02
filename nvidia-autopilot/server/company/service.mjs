import { randomUUID } from "node:crypto";
import { AGENT_TOOLS, describeModel } from "../catalog.mjs";
import { extractJson, parseToolArguments } from "../nim.mjs";
import { createToolRuntime } from "../tools.mjs";
import { createCompanyStore, costFor, formatCents, summarize } from "./store.mjs";
import { ROLE_ARCHETYPE, designOrg } from "./org.mjs";

/**
 * Company OS service.
 *
 * Combines Paperclip's operating model (company → agents → goals → issues →
 * budgets → approvals → activity) with NVIDIA NIM inference and the same tool
 * runtime the autopilot uses. One "cycle" is a working day: the CEO sets focus,
 * employees do the work, a reviewer accepts or sends it back, and finance books
 * every token against the agent's budget.
 */

const DEFAULT_PRICING = { inputCentsPerMTok: 30, outputCentsPerMTok: 60, estimated: true };
const CYCLE_LIMIT_MIN = 0.01;
// A company must have money to spend: a blank or zero budget at creation falls
// back to this. After that, 0 is a deliberate hard stop.
const DEFAULT_COMPANY_BUDGET_CENTS = 5000;

function nowIso() {
  return new Date().toISOString();
}

function money(cents) {
  return formatCents(cents);
}

function priorityRank(issue) {
  return { critical: 0, high: 1, medium: 2, low: 3 }[issue.priority] ?? 4;
}

function openIssues(company) {
  return company.issues.filter((issue) => !["done", "cancelled"].includes(issue.status));
}

function isActionable(company, issue) {
  if (["done", "cancelled", "blocked"].includes(issue.status)) return false;
  // Issues that need board approval are still assignable; the cycle gates them
  // before any agent runs, which is how Paperclip treats approval-required work.
  return issue.blockedBy.every((key) => {
    const dep = company.issues.find((entry) => entry.key === key || entry.id === key);
    return !dep || dep.status === "done";
  });
}

function agentForRole(company, role) {
  return company.agents.find((agent) => agent.role === role) ?? company.agents.find((agent) => agent.id === company.agents[0]?.id);
}

function agentUsable(agent) {
  return agent && agent.status === "active";
}

const CEO_SYSTEM = `You are the CEO of an AI company that runs on NVIDIA NIM agents.
Each cycle you set one focus, assign ready issues to the right people, and may open at most two new issues.
Return ONLY valid JSON:
{
  "focus": string,
  "assignments": [{ "issueKey": string, "agentRole": string, "why": string }],
  "newIssues": [{
    "title": string, "description": string, "priority": "critical"|"high"|"medium"|"low",
    "assigneeRole": string, "acceptanceCriteria": [string], "estimate": "S"|"M"|"L", "needsApproval": boolean
  }],
  "risks": [string]
}
Rules: assign only issues listed as READY. One assignment per issue. Prefer critical/high.
Never assign to an agent marked over_budget or paused. Do not invent issue keys.`;

const EMPLOYEE_TOOL_GUIDANCE = `You are an employee. Finish the assigned issue this session.
Use the tools when they help: search_knowledge for company facts, calculate for arithmetic,
save_artifact to persist the deliverable, safety_check before publishing, escalate_to_human when
you are blocked on money, access or a decision you cannot make.
Write finished, specific markdown with owners, numbers and next actions. No placeholders.`;

const REVIEW_SYSTEM = `You are the quality lead. Judge the deliverable strictly against the acceptance criteria.
Return ONLY valid JSON:
{"verdict":"pass"|"rework","score":0-100,"notes":string,"requiredChanges":[string]}
Pass only when every criterion is met, the work is specific, and there are no placeholders.`;

function companyDigest(company, issues) {
  const agents = company.agents.map((agent) => ({
    name: agent.name,
    role: agent.role,
    title: agent.title,
    status: agent.status,
    budgetCents: agent.budgetMonthlyCents,
    spentCents: agent.spentCents,
  }));
  const ready = issues.filter((issue) => isActionable(company, issue)).map((issue) => ({
    key: issue.key,
    title: issue.title,
    priority: issue.priority,
    assigneeRole: company.agents.find((agent) => agent.id === issue.assigneeAgentId)?.role ?? null,
  }));
  return { agents, ready };
}

export function createCompanyService({ nim, store, retrieval, roles, getConfig, onEvent = () => {} }) {
  const companies = createCompanyStore();
  const timers = new Map();
  const running = new Map();

  function emit(company, type, payload = {}) {
    return companies.log(company, { type, actor: payload.actor ?? "system", ...payload });
  }

  function roleFor(capability) {
    return roles?.[capability] ?? null;
  }

  function modelForRole(role) {
    return roleFor(ROLE_ARCHETYPE[role] ?? "operator")?.model ?? null;
  }

  function requireCompany(companyId) {
    const company = companies.get(companyId);
    if (!company) {
      const error = new Error("Company not found");
      error.status = 404;
      throw error;
    }
    return company;
  }

  /** Book one model call against the agent and the company. */
  function charge(company, { agent, issue, model, usage, kind = "model_call", cycleId }) {
    const costCents = costFor(company, usage);
    const entry = companies.charge(company, {
      agentId: agent?.id ?? null,
      issueId: issue?.id ?? null,
      model,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      costCents,
      kind,
      cycleId,
    });
    onEvent({ kind: "company.charge", companyId: company.id, agentId: agent?.id ?? null, costCents, usage, model });
    return entry;
  }

  // `null` means uncapped; any number (including 0) is a hard limit.
  function companyBudgetLeft(company) {
    if (company.budgetMonthlyCents == null) return Infinity;
    return company.budgetMonthlyCents - company.spentCents;
  }

  function agentBudgetLeft(agent) {
    if (!agent || agent.budgetMonthlyCents == null) return Infinity;
    return agent.budgetMonthlyCents - agent.spentCents;
  }

  /** Nobody — not even the CEO in a planning call — may spend past their cap. */
  function canSpend(agent) {
    return agentBudgetLeft(agent) > 0;
  }

  /* --------------------------------- company -------------------------------- */

  async function createCompany({
    name,
    goal,
    constraints = "",
    size,
    budgetMonthlyCents = 5000,
    settings = {},
    signal,
  }) {
    const missingGoal = !String(goal ?? "").trim() || String(goal).trim().length < 8;
    if (missingGoal) {
      const error = new Error("Describe the company goal in at least a sentence — it drives the org design.");
      error.status = 422;
      throw error;
    }
    const companyName = String(name ?? "").trim() || "Untitled Company";
    const normalizedBudget =
      Number(budgetMonthlyCents) > 0 ? Math.round(Number(budgetMonthlyCents)) : DEFAULT_COMPANY_BUDGET_CENTS;
    const company = companies.create({
      name: companyName,
      mission: String(goal).trim(),
      description: String(constraints ?? ""),
      budgetMonthlyCents: normalizedBudget,
      settings: { ...settings, pricing: { ...DEFAULT_PRICING, ...(settings.pricing ?? {}) } },
    });
    emit(company, "company.design_started", { message: "Designing the organization with the strategist model" });

    const design = await designOrg({
      nim,
      role: roleFor("strategist"),
      goal: String(goal).trim(),
      companyName,
      constraints,
      size,
      signal,
    });

    if (design.usage) charge(company, { model: roleFor("strategist")?.model, usage: design.usage, kind: "org_design" });

    // Departments first so agents can join one.
    const departmentIds = new Map();
    for (const department of design.org.departments) {
      const record = { id: randomUUID(), name: department.name, mission: department.mission, leadAgentId: null };
      company.departments.push(record);
      departmentIds.set(department.name, record.id);
    }

    // Agents, in two passes so "reportsTo" can resolve by role.
    const byRole = new Map();
    // Allocate by share, keep the total exactly equal to the company budget.
    let allocated = 0;
    design.org.agents.forEach((agent, index) => {
      if (index === design.org.agents.length - 1) return;
      allocated += Math.floor(company.budgetMonthlyCents * agent.budgetShare);
    });
    for (const [index, agent] of design.org.agents.entries()) {
      const budgetCents =
        index === design.org.agents.length - 1
          ? Math.max(0, company.budgetMonthlyCents - allocated)
          : Math.floor(company.budgetMonthlyCents * agent.budgetShare);
      companies.addAgent(company, {
        name: agent.name,
        role: agent.role,
        title: agent.title,
        departmentId: departmentIds.get(agent.department) ?? null,
        model: modelForRole(agent.role),
        capabilities: agent.capabilities,
        skills: agent.skills,
        instructions: agent.instructions,
        budgetMonthlyCents: budgetCents,
      });
      byRole.set(agent.role, company.agents[company.agents.length - 1]);
    }
    for (const agent of design.org.agents) {
      const record = byRole.get(agent.role);
      if (!record) continue;
      const manager = agent.reportsToRole ? byRole.get(agent.reportsToRole) : null;
      if (manager && manager.id !== record.id) record.reportsTo = manager.id;
    }

    // Goals, projects, backlog.
    design.org.goals.forEach((goal_, index) => {
      companies.addGoal(company, {
        ...goal_,
        ownerAgentId: index === 0 ? byRole.get("ceo")?.id ?? null : null,
      });
    });
    design.org.projects.forEach((project) => {
      company.projects.push({
        id: randomUUID(),
        name: project.name,
        description: project.description,
        status: "active",
        goalId: company.goals[project.goalIndex]?.id ?? null,
        ownerAgentId: byRole.get("cto")?.id ?? null,
        createdAt: nowIso(),
      });
    });
    for (const issue of design.org.issues) {
      const assignee = agentForRole(company, issue.assigneeRole);
      companies.addIssue(
        company,
        {
          title: issue.title,
          description: issue.description,
          priority: issue.priority,
          assigneeAgentId: assignee?.id ?? null,
          projectId: company.projects[issue.projectIndex]?.id ?? null,
          goalId: company.goals[issue.goalIndex]?.id ?? null,
          acceptanceCriteria: issue.acceptanceCriteria,
          estimate: issue.estimate,
          needsApproval: issue.needsApproval,
        },
        "board",
      );
    }
    company.orgSource = design.source;
    emit(company, "company.created", {
      actor: "board",
      message: `${company.name} staffed with ${company.agents.length} agents and ${company.issues.length} issues (${design.source})`,
    });
    emit(company, "company.ready", {
      message: `Ready. Budget ${money(company.budgetMonthlyCents)}/month across ${company.agents.length} agents.`,
    });
    return companies.save(company);
  }

  function list() {
    return companies.list();
  }

  function get(companyId) {
    const company = requireCompany(companyId);
    return {
      company,
      artifacts: companies.listArtifacts(companyId),
      summary: summarize(company),
      events: companies.events(companyId, 200),
      running: running.has(companyId),
    };
  }

  function updateCompany(companyId, patch) {
    const company = requireCompany(companyId);
    if (typeof patch.name === "string" && patch.name.trim()) company.name = patch.name.trim().slice(0, 120);
    if (typeof patch.mission === "string") company.mission = patch.mission.slice(0, 400);
    if (["active", "paused", "archived"].includes(patch.status)) {
      company.status = patch.status;
      if (company.status !== "active") stopAutoMode(companyId, `Company ${company.status}`);
    }
    if (patch.budgetMonthlyCents !== undefined) {
      company.budgetMonthlyCents =
        patch.budgetMonthlyCents === null ? null : Math.max(0, Math.round(Number(patch.budgetMonthlyCents) || 0));
    }
    if (patch.settings && typeof patch.settings === "object") {
      const settings = patch.settings;
      if (["never", "high", "all"].includes(settings.approvalPolicy)) company.settings.approvalPolicy = settings.approvalPolicy;
      if (settings.maxIssuesPerCycle != null) {
        company.settings.maxIssuesPerCycle = Math.min(Math.max(Number(settings.maxIssuesPerCycle) || 3, 1), 8);
      }
      if (settings.reworkLimit != null) company.settings.reworkLimit = Math.min(Math.max(Number(settings.reworkLimit) || 0, 0), 3);
      if (settings.pricing && typeof settings.pricing === "object") {
        company.settings.pricing = {
          inputCentsPerMTok: Math.max(0, Number(settings.pricing.inputCentsPerMTok) || 0),
          outputCentsPerMTok: Math.max(0, Number(settings.pricing.outputCentsPerMTok) || 0),
          estimated: false,
        };
      }
    }
    companies.save(company);
    emit(company, "company.updated", { actor: "board", message: "Company settings updated" });
    return companies.get(companyId);
  }

  function deleteCompany(companyId) {
    stopAutoMode(companyId, "Company deleted");
    return companies.delete(companyId);
  }

  /* ---------------------------------- people -------------------------------- */

  function hire(companyId, agent) {
    const company = requireCompany(companyId);
    const role = agent.role ?? "general";
    companies.addAgent(company, {
      ...agent,
      model: agent.model || modelForRole(role),
      budgetMonthlyCents: agent.budgetMonthlyCents ?? Math.round(company.budgetMonthlyCents * 0.1),
      departmentId: agent.departmentId ?? company.departments[0]?.id ?? null,
    });
    return companies.get(companyId);
  }

  function updateAgent(companyId, agentId, patch) {
    const company = requireCompany(companyId);
    const updated = companies.updateAgent(company, agentId, patch);
    if (!updated) {
      const error = new Error("Agent not found");
      error.status = 404;
      throw error;
    }
    return updated;
  }

  function fire(companyId, agentId) {
    const company = requireCompany(companyId);
    const result = companies.removeAgent(company, agentId);
    if (result?.error) {
      const error = new Error(result.error);
      error.status = 422;
      throw error;
    }
    if (!result) {
      const error = new Error("Agent not found");
      error.status = 404;
      throw error;
    }
    return result;
  }

  /* ---------------------------------- issues -------------------------------- */

  function createIssue(companyId, issue, actor = "board") {
    const company = requireCompany(companyId);
    const assignee =
      company.agents.find((agent) => agent.id === issue.assigneeAgentId) ??
      (issue.assigneeRole ? agentForRole(company, issue.assigneeRole) : null);
    const record = companies.addIssue(
      company,
      {
        ...issue,
        assigneeAgentId: assignee?.id ?? null,
        projectId: issue.projectId ?? company.projects[0]?.id ?? null,
        goalId: issue.goalId ?? company.goals[0]?.id ?? null,
      },
      actor,
    );
    return { issue: record, company: companies.get(companyId) };
  }

  function updateIssue(companyId, issueId, patch) {
    const company = requireCompany(companyId);
    const issue = company.issues.find((entry) => entry.id === issueId || entry.key === issueId);
    if (!issue) {
      const error = new Error("Issue not found");
      error.status = 404;
      throw error;
    }
    if (typeof patch.title === "string" && patch.title.trim()) issue.title = patch.title.trim().slice(0, 240);
    if (typeof patch.description === "string") issue.description = patch.description.slice(0, 8000);
    if (["critical", "high", "medium", "low"].includes(patch.priority)) issue.priority = patch.priority;
    if (patch.assigneeAgentId !== undefined) issue.assigneeAgentId = patch.assigneeAgentId || null;
    if (patch.status && ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "cancelled"].includes(patch.status)) {
      companies.setIssueStatus(company, issue.id, patch.status);
    }
    if (patch.needsApproval !== undefined) issue.needsApproval = Boolean(patch.needsApproval);
    issue.updatedAt = nowIso();
    companies.save(company);
    emit(company, "issue.updated", { actor: "board", issueId: issue.id, message: `${issue.key} updated by the board` });
    return { issue, company: companies.get(companyId) };
  }

  function commentOnIssue(companyId, issueId, body, author = "board") {
    const company = requireCompany(companyId);
    const issue = company.issues.find((entry) => entry.id === issueId || entry.key === issueId);
    if (!issue) {
      const error = new Error("Issue not found");
      error.status = 404;
      throw error;
    }
    const comment = companies.comment(company, issue.id, { authorType: author, body });
    emit(company, "issue.comment", { actor: author, issueId: issue.id, message: `Comment on ${issue.key}` });
    return { comment, company: companies.get(companyId) };
  }

  function decideApproval(companyId, approvalId, decision) {
    const company = requireCompany(companyId);
    const approval = companies.decideApproval(company, approvalId, decision);
    if (!approval) {
      const error = new Error("Approval not found or already decided");
      error.status = 404;
      throw error;
    }
    return { approval, company: companies.get(companyId) };
  }

  /* ---------------------------------- cycle --------------------------------- */

  function setCycleStatus(company, issue, status) {
    issue.status = status;
    issue.updatedAt = nowIso();
    companies.save(company);
  }

  async function planCycle(company, cycleId, signal) {
    const ceo = company.agents.find((agent) => agent.role === "ceo") ?? company.agents[0];
    const candidates = openIssues(company)
      .filter((issue) => isActionable(company, issue))
      .sort((a, b) => priorityRank(a) - priorityRank(b) || String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, company.settings.maxIssuesPerCycle);
    const digest = companyDigest(company, company.issues);
    const fallback = {
      focus: company.mission,
      assignments: candidates.map((issue) => ({
        issueKey: issue.key,
        agentRole: company.agents.find((agent) => agent.id === issue.assigneeAgentId)?.role ?? "general",
        why: `${issue.priority} priority and ready to execute`,
      })),
      newIssues: [],
      risks: [],
    };
    const model = ceo?.model ?? roleFor("strategist")?.model;
    if (!nim || !model) return { plan: fallback, parsed: false };
    if (!canSpend(ceo)) {
      emit(company, "cycle.degraded", {
        message: `${ceo.name} is out of budget, so this cycle is planned by policy instead of the model`,
      });
      return { plan: fallback, parsed: false };
    }
    try {
      const response = await nim.chat({
        model,
        temperature: 0.3,
        maxTokens: 1400,
        intent: "cycle",
        signal,
        messages: [
          { role: "system", content: CEO_SYSTEM },
          {
            role: "user",
            content: [
              `Company: ${company.name}`,
              `Mission: ${company.mission}`,
              `Budget: ${money(company.budgetMonthlyCents)}/month, spent ${money(company.spentCents)} (${money(companyBudgetLeft(company))} left)`,
              `Goals: ${company.goals.map((goal) => `${goal.title} [${goal.status}]`).join(" | ")}`,
              `AGENTS_JSON: ${JSON.stringify(digest.agents)}`,
              `READY_ISSUES_JSON: ${JSON.stringify(digest.ready)}`,
              company.cycles.length
                ? `Last cycle summary: ${company.cycles[company.cycles.length - 1]?.summary ?? ""}`.slice(0, 1200)
                : "",
              "Set this cycle's focus and assignments. Return the JSON.",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      });
      charge(company, { agent: ceo, model, usage: response.usage, kind: "cycle_plan", cycleId });
      const parsed = extractJson(response.content);
      if (!parsed || !Array.isArray(parsed.assignments)) return { plan: fallback, parsed: false, raw: response.content };
      purgePlan(parsed, company, candidates);
      return { plan: parsed, parsed: true };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return { plan: fallback, parsed: false, error: error?.message };
    }
  }

  /** Drop assignments the company cannot honour (unknown keys, unavailable agents). */
  function purgePlan(plan, company, candidates) {
    const allowed = new Set(candidates.map((issue) => issue.key));
    const seen = new Set();
    plan.assignments = (plan.assignments ?? []).filter((assignment) => {
      const key = String(assignment?.issueKey ?? "");
      if (!allowed.has(key) || seen.has(key)) return false;
      seen.add(key);
      const agent = company.agents.find((entry) => entry.role === assignment.agentRole);
      return Boolean(agent);
    });
    plan.newIssues = (plan.newIssues ?? []).slice(0, 2);
    plan.risks = (plan.risks ?? []).slice(0, 5).map(String);
    plan.focus = String(plan.focus ?? company.mission).slice(0, 300);
  }

  async function deliverIssue(company, issue, agent, cycle, signal) {
    const model = agent.model ?? modelForRole(agent.role);
    if (!model) {
      throw Object.assign(new Error(`No NIM model assigned to ${agent.name}.`), { code: "model_missing" });
    }
    const context = [];
    if (company.settings.useKnowledge !== false) {
      try {
        const search = await retrieval.search(`${issue.title} ${issue.description}`, { topK: 3, signal });
        if (search.passages.length) {
          context.push(
            [
              "Company knowledge (cite as [K1], [K2] …):",
              ...search.passages.map((passage, index) => `[K${index + 1}] ${passage.title}: ${passage.text.slice(0, 700)}`),
            ].join("\n"),
          );
        }
      } catch (error) {
        if (error?.name === "AbortError") throw error;
      }
    }
    if (issue.comments.length) {
      context.push(
        `Prior discussion:\n${issue.comments
          .slice(-4)
          .map((comment) => `- ${comment.body.slice(0, 400)}`)
          .join("\n")}`,
      );
    }

    const messages = [
      {
        role: "system",
        content: [
          EMPLOYEE_TOOL_GUIDANCE,
          `You are ${agent.name}, ${agent.title} at ${company.name}.`,
          agent.instructions ? `How you work: ${agent.instructions}` : "",
          `Company mission: ${company.mission}`,
        ]
          .filter(Boolean)
          .join("\n"),
      },
      {
        role: "user",
        content: [
          `ISSUE ${issue.key}: ${issue.title}`,
          issue.description,
          issue.acceptanceCriteria.length ? `Acceptance criteria:\n${issue.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}` : "",
          context.join("\n\n"),
          "Produce the finished deliverable now and save it with save_artifact.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];

    const toolRuntime = createToolRuntime({
      nim,
      store: companies,
      retrieval,
      roles: { safety: roleFor("safety"), artist: roleFor("artist") },
      runId: company.id,
      emit: (type, payload) => emit(company, type, { actor: "agent", agentId: agent.id, issueId: issue.id, ...payload }),
      signal,
      writeArtifact: (name, content, meta) => {
        const record = companies.writeArtifact(company.id, `${issue.key}-${name}`.replace(/\.md$/, "-" + agent.role + ".md"), content, {
          ...meta,
          issueId: issue.id,
          agentId: agent.id,
        });
        issue.artifacts.push(record.name);
        return record;
      },
      requireApproval: async (request) => {
        // Tool-level escalations become company approvals and stop this issue.
        const approval = companies.createApproval(company, {
          kind: "escalation",
          title: request.question,
          detail: request.whyBlocked,
          requestedByAgentId: agent.id,
          issueId: issue.id,
        });
        return { approved: false, note: `Escalated to the board as ${approval.id}; work pauses until a human decides.` };
      },
    });

    let content = "";
    for (let round = 0; round < 4; round += 1) {
      const response = await nim.chat({
        model,
        temperature: agent.temperature,
        maxTokens: agent.maxTokens,
        tools: AGENT_TOOLS,
        toolChoice: "auto",
        intent: "employee",
        signal,
        messages,
      });
      charge(company, { agent, issue, model, usage: response.usage, cycleId: cycle.id });
      if (response.toolCalls?.length) {
        messages.push({
          role: "assistant",
          content: response.content || null,
          tool_calls: response.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments },
          })),
        });
        for (const call of response.toolCalls) {
          const result = await toolRuntime.run(call.name, parseToolArguments(call.arguments));
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 4000) });
          if (result?.approved === false && call.name === "escalate_to_human") {
            issue.status = "blocked";
            issue.blockedReason = "Escalated to the board for a decision.";
          }
        }
        if (issue.status === "blocked") return { content: "", blocked: true };
        continue;
      }
      content = response.content ?? "";
      break;
    }
    if (!content) content = "The agent returned no deliverable. See the activity log for tool calls.";
    return { content, blocked: false };
  }

  async function reviewDeliverable(company, issue, content, cycle, signal) {
    const reviewer = agentForRole(company, "qa") ?? company.agents.find((agent) => agent.role === "ceo");
    const model = reviewer?.model ?? roleFor("critic")?.model;
    const fallbackPass = { verdict: "pass", score: null, notes: "No reviewer model available; accepted by policy.", requiredChanges: [] };
    if (!nim || !model || !reviewer) return fallbackPass;
    if (!canSpend(reviewer)) {
      return { ...fallbackPass, notes: `${reviewer.name} is out of budget; accepted by policy.` };
    }
    try {
      const response = await nim.chat({
        model,
        temperature: 0.1,
        maxTokens: 600,
        intent: "review",
        signal,
        messages: [
          { role: "system", content: REVIEW_SYSTEM },
          {
            role: "user",
            content: [
              `ISSUE ${issue.key}: ${issue.title}`,
              `Acceptance criteria:\n${issue.acceptanceCriteria.map((item) => `- ${item}`).join("\n") || "- (none recorded)"}`,
              `DELIVERABLE:\n${String(content).slice(0, 9000)}`,
              "Return the review JSON.",
            ].join("\n\n"),
          },
        ],
      });
      charge(company, { agent: reviewer, issue, model, usage: response.usage, kind: "review", cycleId: cycle.id });
      const parsed = extractJson(response.content) ?? {};
      return {
        verdict: parsed.verdict === "rework" ? "rework" : "pass",
        score: Number(parsed.score) || null,
        notes: String(parsed.notes ?? "").slice(0, 1200),
        requiredChanges: (parsed.requiredChanges ?? []).slice(0, 6).map(String),
        reviewerId: reviewer.id,
      };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return { ...fallbackPass, notes: `Review skipped: ${error?.message ?? error}` };
    }
  }

  async function standup(company, cycle, signal) {
    const scribe = roleFor("scribe") ?? roleFor("strategist");
    const fallback = [
      `**Cycle ${cycle.index}** — focus: ${cycle.focus || company.mission}`,
      "",
      ...cycle.results.map(
        (result) =>
          `- ${result.key}: ${result.status}${result.score ? ` (score ${result.score})` : ""}${result.note ? ` — ${result.note}` : ""}`,
      ),
      "",
      `Spend this cycle: ${money(cycle.stats.costCents)} · ${cycle.stats.tokens} tokens · ${cycle.stats.issuesDone} done, ${cycle.stats.issuesOpen} still open.`,
    ].join("\n");
    if (!nim || !scribe?.model || companyBudgetLeft(company) <= 0) return fallback;
    try {
      const response = await nim.chat({
        model: scribe.model,
        temperature: 0.4,
        maxTokens: 700,
        intent: "standup",
        signal,
        messages: [
          {
            role: "system",
            content:
              "You write the end-of-cycle standup for an AI company. Be blunt and specific: what shipped, what is blocked, what the board must decide. Markdown, max 200 words.",
          },
          {
            role: "user",
            content: [
              `Company: ${company.name} — mission: ${company.mission}`,
              `Cycle ${cycle.index}: ${cycle.focus}`,
              `Results:\n${cycle.results.map((result) => `- ${result.key} (${result.owner}): ${result.status}; ${result.note ?? ""}`).join("\n")}`,
              `Open issues after the cycle: ${openIssues(company).length}`,
              `Spend: ${money(company.spentCents)} of ${money(company.budgetMonthlyCents)}`,
              "Write the standup.",
            ].join("\n"),
          },
        ],
      });
      charge(company, { model: scribe.model, usage: response.usage, kind: "standup", cycleId: cycle.id });
      return response.content?.trim() || fallback;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return fallback;
    }
  }

  async function runCycle(companyId, { signal, trigger = "manual" } = {}) {
    const company = requireCompany(companyId);
    if (running.has(companyId)) {
      const error = new Error("A cycle is already running for this company.");
      error.status = 409;
      throw error;
    }
    if (company.status !== "active") {
      const error = new Error(`Company is ${company.status}; resume it before running a cycle.`);
      error.status = 422;
      throw error;
    }
    if (!openIssues(company).length) {
      const error = new Error("Nothing left to do: every issue is done or cancelled.");
      error.status = 422;
      throw error;
    }
    if (companyBudgetLeft(company) <= 0) {
      const error = new Error(`Monthly budget exhausted (${money(company.spentCents)} of ${money(company.budgetMonthlyCents)}).`);
      error.status = 422;
      throw error;
    }

    running.set(companyId, true);
    const alive = () => Boolean(companies.get(companyId));
    company.counters.cycle += 1;
    const cycle = {
      id: randomUUID(),
      index: company.counters.cycle,
      trigger,
      status: "running",
      startedAt: nowIso(),
      finishedAt: null,
      focus: "",
      plan: [],
      results: [],
      summary: "",
      newIssues: [],
      risks: [],
      stats: { issuesWorked: 0, issuesDone: 0, issuesOpen: 0, costCents: 0, tokens: 0, calls: 0 },
    };
    company.cycles.push(cycle);
    companies.save(company);
    emit(company, "cycle.started", { message: `Cycle ${cycle.index} started (${trigger})` });

    const spentBefore = company.spentCents;
    const tokensBefore = company.ledger.reduce((sum, entry) => sum + entry.promptTokens + entry.completionTokens, 0);

    try {
      const { plan, parsed } = await planCycle(company, cycle.id, signal);
      cycle.focus = plan.focus;
      cycle.plan = plan.assignments;
      cycle.risks = plan.risks ?? [];
      cycle.planSource = parsed ? "model" : "policy";
      companies.save(company);
      emit(company, "cycle.planned", {
        message: `Focus: ${cycle.focus}`,
        detail: `${plan.assignments.length} assignment(s)${parsed ? "" : " (policy fallback)"}`,
      });

      // New issues proposed by the CEO (capacity permitting).
      for (const proposal of plan.newIssues ?? []) {
        if (!proposal?.title) continue;
        const assignee = agentForRole(company, proposal.assigneeRole ?? "general");
        const record = companies.addIssue(
          company,
          {
            title: proposal.title,
            description: proposal.description ?? "",
            priority: proposal.priority,
            assigneeAgentId: assignee?.id ?? null,
            projectId: company.projects[0]?.id ?? null,
            goalId: company.goals[0]?.id ?? null,
            acceptanceCriteria: proposal.acceptanceCriteria,
            estimate: proposal.estimate,
            needsApproval: proposal.needsApproval,
          },
          "ceo",
        );
        cycle.newIssues.push({ key: record.key, title: record.title });
      }

      for (const assignment of plan.assignments) {
        if (signal?.aborted) throw Object.assign(new Error("Cycle cancelled"), { name: "AbortError" });
        if (!alive()) throw Object.assign(new Error("Company deleted"), { name: "AbortError", status: 409 });
        const issue = company.issues.find((entry) => entry.key === assignment.issueKey);
        if (!issue || !isActionable(company, issue)) continue;
        const agent =
          company.agents.find((entry) => entry.role === assignment.agentRole && entry.status === "active") ??
          company.agents.find((entry) => entry.id === issue.assigneeAgentId);
        if (!agent) {
          issue.status = "blocked";
          issue.blockedReason = `No active agent for role ${assignment.agentRole}.`;
          emit(company, "issue.blocked", { issueId: issue.id, message: `${issue.key} blocked: no active agent` });
          continue;
        }
        if (!agentUsable(agent)) {
          companies.comment(company, issue.id, {
            authorType: "system",
            body: `${agent.name} is ${agent.status}, so ${issue.key} was not worked this cycle.`,
          });
          emit(company, "issue.deferred", { issueId: issue.id, message: `${issue.key} deferred: ${agent.name} ${agent.status}` });
          continue;
        }
        if (!canSpend(agent)) {
          issue.status = "blocked";
          issue.blockedReason = `${agent.name} is over their monthly budget.`;
          emit(company, "issue.blocked", { issueId: issue.id, message: `${issue.key} blocked: ${agent.name} over budget` });
          continue;
        }

        // Approval policy gate (Paperclip-style board approval):
        //   never → nothing gates, high → only issues flagged needsApproval,
        //   all   → every issue waits for a human before an agent touches it.
        const policy = company.settings.approvalPolicy;
        const needsBoard =
          policy !== "never" &&
          (policy === "all" || issue.needsApproval) &&
          !company.approvals.some((approval) => approval.issueId === issue.id && approval.status === "approved");
        if (needsBoard) {
          if (!company.approvals.some((approval) => approval.issueId === issue.id && approval.status === "pending")) {
            companies.createApproval(company, {
              kind: "issue",
              title: `Approve: ${issue.title}`,
              detail: `This issue is marked as needing board approval before ${agent.name} executes it.`,
              requestedByAgentId: agent.id,
              issueId: issue.id,
            });
          }
          issue.status = "blocked";
          issue.blockedReason = "Waiting for board approval.";
          companies.save(company);
          cycle.results.push({ key: issue.key, owner: agent.name, status: "awaiting_approval", note: "Board approval requested" });
          continue;
        }

        issue.status = "in_progress";
        issue.updatedAt = nowIso();
        companies.save(company);
        emit(company, "issue.started", {
          issueId: issue.id,
          agentId: agent.id,
          message: `${agent.name} started ${issue.key}: ${issue.title}`,
        });

        const deliverable = await deliverIssue(company, issue, agent, cycle, signal);
        cycle.stats.issuesWorked += 1;

        if (deliverable.blocked) {
          companies.comment(company, issue.id, {
            authorType: "agent",
            authorAgentId: agent.id,
            body: "I am blocked and escalated this to the board. Work stops until the approval is decided.",
          });
          cycle.results.push({ key: issue.key, owner: agent.name, status: "blocked", note: "Escalated for approval" });
          continue;
        }

        // Persist the deliverable as an artifact even when the agent never
        // called save_artifact itself, so every accepted issue has a file.
        const artifact = companies.writeArtifact(company.id, `${issue.key}-${agent.role}.md`, deliverable.content, {
          issueId: issue.id,
          agentId: agent.id,
          source: "employee",
          model: agent.model,
        });
        if (!issue.artifacts.includes(artifact.name)) issue.artifacts.push(artifact.name);
        companies.comment(company, issue.id, {
          authorType: "agent",
          authorAgentId: agent.id,
          body: `**Deliverable** (${artifact.name})\n\n${deliverable.content.slice(0, 6000)}`,
        });
        issue.status = "in_review";
        companies.save(company);

        const review = await reviewDeliverable(company, issue, deliverable.content, cycle, signal);
        issue.review = review;
        if (review.verdict === "pass") {
          companies.setIssueStatus(company, issue.id, "done");
          issue.reworks = issue.reworks ?? 0;
          companies.comment(company, issue.id, {
            authorType: "agent",
            authorAgentId: review.reviewerId ?? null,
            body: `**Review: pass**${review.score ? ` (${review.score}/100)` : ""}\n\n${review.notes || "Meets the acceptance criteria."}`,
          });
          cycle.stats.issuesDone += 1;
          cycle.results.push({
            key: issue.key,
            owner: agent.name,
            status: "done",
            score: review.score,
            note: review.notes || "Accepted",
          });
          emit(company, "issue.done", { issueId: issue.id, message: `${issue.key} accepted by ${review.reviewerId ? "the quality lead" : "policy"}` });
        } else {
          issue.reworks = (issue.reworks ?? 0) + 1;
          const exhausted = issue.reworks > company.settings.reworkLimit;
          issue.status = exhausted ? "blocked" : "todo";
          issue.blockedReason = exhausted ? "Rework limit reached; needs a human decision." : null;
          companies.save(company);
          companies.comment(company, issue.id, {
            authorType: "agent",
            authorAgentId: review.reviewerId ?? null,
            body: [
              `**Review: rework**${review.score ? ` (${review.score}/100)` : ""}`,
              review.notes,
              review.requiredChanges.length ? `Required changes:\n${review.requiredChanges.map((item) => `- ${item}`).join("\n")}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          });
          cycle.results.push({
            key: issue.key,
            owner: agent.name,
            status: exhausted ? "blocked" : "rework",
            score: review.score,
            note: review.requiredChanges[0] ?? review.notes,
          });
          emit(company, exhausted ? "issue.blocked" : "issue.rework", {
            issueId: issue.id,
            message: `${issue.key} ${exhausted ? "blocked after rework limit" : "sent back for rework"}`,
          });
        }
        companies.save(company);
      }

      cycle.stats.issuesOpen = openIssues(company).length;
      cycle.stats.costCents = Math.round((company.spentCents - spentBefore) * 100) / 100;
      cycle.stats.tokens =
        company.ledger.reduce((sum, entry) => sum + entry.promptTokens + entry.completionTokens, 0) - tokensBefore;
      cycle.stats.calls = company.ledger.filter((entry) => entry.cycleId === cycle.id).length;
      cycle.summary = await standup(company, cycle, signal);
      cycle.status = "completed";
      cycle.finishedAt = nowIso();
      // Auto-mode limits count autonomous cycles only; manual cycles are board work.
      if (trigger === "auto") company.autoMode.cyclesRun = (company.autoMode.cyclesRun ?? 0) + 1;
      company.autoMode.lastRunAt = cycle.finishedAt;
      companies.save(company);
      emit(company, "cycle.completed", {
        message: `Cycle ${cycle.index} finished: ${cycle.stats.issuesDone} done, ${cycle.stats.issuesOpen} open, ${money(cycle.stats.costCents)} spent`,
      });
      return { cycle, company: companies.get(companyId) };
    } catch (error) {
      cycle.status = error?.name === "AbortError" ? "cancelled" : "failed";
      cycle.finishedAt = nowIso();
      cycle.summary = `Cycle failed: ${error?.message ?? error}`;
      if (!alive()) {
        // The company was deleted mid-cycle: drop anything this cycle wrote
        // instead of resurrecting a directory nobody owns any more.
        companies.delete(companyId);
        running.delete(companyId);
        throw error;
      }
      companies.save(company);
      emit(company, cycle.status === "cancelled" ? "cycle.cancelled" : "cycle.failed", {
        message: cycle.summary,
      });
      throw error;
    } finally {
      running.delete(companyId);
    }
  }

  /* -------------------------------- auto mode ------------------------------- */

  function autoModeReason(company) {
    if (company.status !== "active") return `Company is ${company.status}`;
    if (!company.autoMode.enabled) return "Auto mode is off";
    if (company.autoMode.maxCycles > 0 && company.autoMode.cyclesRun >= company.autoMode.maxCycles) {
      return `Reached max cycles (${company.autoMode.maxCycles})`;
    }
    if (company.approvals.some((approval) => approval.status === "pending")) {
      return "Waiting for board approvals";
    }
    if (!openIssues(company).length) return "Every issue is closed";
    if (companyBudgetLeft(company) <= 0) return "Monthly budget exhausted";
    return null;
  }

  function stopAutoMode(companyId, reason) {
    const timer = timers.get(companyId);
    if (timer) clearInterval(timer);
    timers.delete(companyId);
    const company = companies.get(companyId);
    if (company) {
      company.autoMode.enabled = false;
      company.autoMode.stopReason = reason ?? null;
      companies.save(company);
      companies.log(company, { type: "auto_mode.stopped", actor: "system", message: `Auto mode stopped: ${reason}` });
    }
  }

  async function autoTick(companyId) {
    const company = companies.get(companyId);
    if (!company) {
      stopAutoMode(companyId, "Company deleted");
      return;
    }
    const reason = autoModeReason(company);
    if (reason) {
      if (!company.autoMode.enabled) return;
      stopAutoMode(companyId, reason);
      return;
    }
    if (running.has(companyId)) return;
    try {
      await runCycle(companyId, { trigger: "auto" });
      const fresh = companies.get(companyId);
      if (fresh) {
        fresh.autoMode.failures = 0;
        companies.save(fresh);
      }
    } catch (error) {
      // A failing cycle must never take the process down (these timers are
      // fire-and-forget) and must never spin forever on the same error.
      if (running.has(companyId)) return;
      const current = companies.get(companyId);
      if (!current) {
        stopAutoMode(companyId, "Company deleted");
        return;
      }
      const failures = (current.autoMode.failures ?? 0) + 1;
      current.autoMode.failures = failures;
      companies.save(current);
      companies.log(current, {
        type: "auto_mode.failure",
        actor: "system",
        message: `Auto cycle failed (${failures}): ${error?.message ?? error}`,
      });
      const fatal = [409, 422].includes(error?.status) || failures >= (current.autoMode.failureLimit ?? 2);
      if (fatal) stopAutoMode(companyId, error?.message ?? "Cycle failed");
    }
  }

  function startAutoMode(companyId, options = {}) {
    const company = requireCompany(companyId);
    const everyMinutes = Math.max(CYCLE_LIMIT_MIN, Number(options.everyMinutes ?? company.autoMode.everyMinutes ?? 15));
    company.autoMode = {
      ...company.autoMode,
      enabled: true,
      everyMinutes,
      maxCycles: Math.max(0, Number(options.maxCycles ?? company.autoMode.maxCycles ?? 20)),
      stopReason: null,
      startedAt: nowIso(),
    };
    companies.save(company);
    companies.log(company, {
      type: "auto_mode.started",
      actor: "board",
      message: `Auto mode on: one cycle every ${everyMinutes} min, max ${company.autoMode.maxCycles}`,
    });
    const existing = timers.get(companyId);
    if (existing) clearInterval(existing);
    const timer = setInterval(() => void autoTick(companyId), Math.max(1000, everyMinutes * 60_000));
    timer.unref?.();
    timers.set(companyId, timer);
    // Kick off the first cycle immediately so auto mode feels instant.
    setTimeout(() => void autoTick(companyId), 0).unref?.();
    return companies.get(companyId);
  }

  function resumeAutoModes() {
    for (const entry of companies.list()) {
      const company = companies.get(entry.id);
      if (!company?.autoMode?.enabled) continue;
      const reason = autoModeReason(company);
      if (reason) {
        stopAutoMode(entry.id, reason);
        continue;
      }
      const timer = setInterval(
        () => void autoTick(entry.id),
        Math.max(1000, (company.autoMode.everyMinutes ?? 15) * 60_000),
      );
      timer.unref?.();
      timers.set(entry.id, timer);
    }
  }

  function stopAll() {
    for (const [companyId, timer] of timers) {
      clearInterval(timer);
      timers.delete(companyId);
    }
    void companies;
  }

  return {
    companies,
    list,
    get,
    createCompany,
    updateCompany,
    deleteCompany,
    hire,
    updateAgent,
    fire,
    createIssue,
    updateIssue,
    commentOnIssue,
    decideApproval,
    runCycle,
    startAutoMode,
    stopAutoMode,
    resumeAutoModes,
    stopAll,
    autoModeReason,
    artifacts: {
      list: companies.listArtifacts,
      read: companies.readArtifact,
    },
    helpers: { describeModel, costFor, money },
  };
}
