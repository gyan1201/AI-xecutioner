/**
 * Application service: every mutation the API can perform, in one place.
 *
 * Routes stay thin (parse → call → respond). This layer owns validation,
 * board invariants, and the derived views (dashboard, inbox, agent detail)
 * that the UI asks for.
 */

import { estimateCost, findModel, selectModel } from "../nim/catalog.mjs";
import { BLUEPRINTS, getBlueprint, planBlueprint } from "../nim/blueprints.mjs";
import { loadSkills, searchSkills, skillStats, suggestSkills } from "../nim/skills.mjs";
import { newId, nowIso } from "../store.mjs";
import { buildSeedCompany } from "./seed.mjs";
import {
  AGENT_STATUSES,
  ISSUE_STATUSES,
  OPEN_STATUSES,
  PRIORITIES,
  PRIORITY_WEIGHT,
  agentSpend,
  agentSpendStatus,
  createAgent,
  createComment,
  createGoal,
  createIssue,
  createKnowledge,
  createProject,
  createRoutine,
  findAgent,
  findIssue,
  pushActivity,
  recomputeCompany,
  slugify,
} from "./model.mjs";
import { searchKnowledge } from "./retrieval.mjs";
import { planFromBlueprint } from "./launch.mjs";

function httpError(message, status = 400, code = "bad_request") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function requireString(value, field, { max = 4000, min = 1 } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text.length < min) throw httpError(`${field} is required.`);
  if (text.length > max) throw httpError(`${field} is too long (max ${max}).`);
  return text;
}

function optionalNumber(value, field, { min = -1e12, max = 1e12 } = {}) {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw httpError(`${field} must be a number between ${min} and ${max}.`);
  return number;
}

export function createService({ store, nim, engine, bus }) {
  /* -------------------------------------------------------------- seeding */

  /** Two NVIDIA skills whose text matches the role, so no agent starts empty-handed. */
  function skillsFor(text, limit = 2) {
    try {
      return suggestSkills({ text, limit }).map((skill) => skill.id).slice(0, limit);
    } catch {
      return [];
    }
  }

  /** A share of the company cap, or 0 (unlimited) when the company is unlimited. */
  function shareOfCap(capCents, share) {
    const cap = capCents ?? 0;
    return cap > 0 ? Math.round(cap * share) : 0;
  }

  /**
   * Budgeting is opt-in now, so existing companies that carry caps are moved to
   * "unlimited" once. The old numbers are kept on the record (nothing is
   * destroyed) in case an operator wants a ceiling back.
   */
  function removeBudgetLimits() {
    const migrated = [];
    for (const summary of store.listCompanies()) {
      const company = store.getCompany(summary.id);
      if (!company || company.settings?.budgetLimitsRemovedAt) continue;
      const companyCap = company.settings.monthlyBudgetCents ?? 0;
      company.settings.legacyMonthlyBudgetCents = companyCap > 0 ? companyCap : null;
      company.settings.monthlyBudgetCents = 0;
      company.settings.budgetLimitsRemovedAt = nowIso();
      for (const agent of company.agents ?? []) {
        if ((agent.monthlyBudgetCents ?? 0) > 0) {
          agent.legacyMonthlyBudgetCents = agent.monthlyBudgetCents;
          agent.monthlyBudgetCents = 0;
        }
        if (agent.status === "over_budget") agent.status = "active";
      }
      recomputeCompany(company);
      store.saveCompany(company);
      migrated.push(company.id);
    }
    return migrated;
  }

  function ensureSeed() {
    const existing = store.getCompany("co_northwind");
    if (existing) return existing;
    if (store.listCompanies().length > 0) return store.activeCompany();
    const company = buildSeedCompany();
    store.createCompany(company);
    return company;
  }

  /* ------------------------------------------------------------- bootstrap */

  function bootstrap() {
    const companies = store.listCompanies();
    const active = store.activeCompany();
    return {
      companies,
      activeCompanyId: active?.id ?? null,
      blueprints: { count: BLUEPRINTS.length },
      skills: { count: skillStats().count },
      models: { count: 0 }, // filled by routes with the live catalog
      serverTime: nowIso(),
    };
  }

  /* -------------------------------------------------------------- company */

  function companyView(companyId, { include = ["all"] } = {}) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    recomputeCompany(company);
    const want = new Set(include);
    const view = {
      id: company.id,
      name: company.name,
      slug: company.slug,
      mission: company.mission,
      issuePrefix: company.issuePrefix,
      createdAt: company.createdAt,
      updatedAt: company.updatedAt,
      settings: company.settings,
      stats: company.stats,
      cycleHistory: (company.cycleHistory ?? []).slice(0, 12),
    };
    if (want.has("all") || want.has("agents")) {
      view.agents = company.agents.map((agent) => ({
        ...agent,
        spend: agentSpendStatus(company, agent),
        openIssues: company.issues.filter((issue) => issue.assigneeId === agent.id && OPEN_STATUSES.includes(issue.status)).length,
      }));
    }
    if (want.has("all") || want.has("issues")) view.issues = company.issues;
    if (want.has("all") || want.has("goals")) view.goals = company.goals;
    if (want.has("all") || want.has("projects")) {
      view.projects = company.projects.map((project) => ({
        ...project,
        issueCount: company.issues.filter((issue) => issue.projectId === project.id).length,
        openCount: company.issues.filter((issue) => issue.projectId === project.id && OPEN_STATUSES.includes(issue.status)).length,
      }));
    }
    if (want.has("all") || want.has("comments")) view.comments = company.comments;
    if (want.has("all") || want.has("runs")) view.runs = company.runs.slice(0, 60);
    if (want.has("all") || want.has("ledger")) view.ledger = company.ledger.slice(0, 250);
    if (want.has("all") || want.has("approvals")) view.approvals = company.approvals;
    if (want.has("all") || want.has("activity")) view.activity = company.activity.slice(0, 80);
    if (want.has("all") || want.has("routines")) view.routines = company.routines;
    if (want.has("all") || want.has("knowledge")) {
      view.knowledge = company.knowledge.map(({ embedding, ...doc }) => doc);
    }
    if (want.has("all") || want.has("artifacts")) view.artifacts = company.artifacts.slice(0, 60);
    return view;
  }

  async function createCompany({ name, mission = "", blueprintId = null, budgetMonthlyCents = 0, plan = null }) {
    const cleanName = requireString(name, "Company name", { max: 80 });
    const id = `co_${slugify(cleanName).replace(/-/g, "_")}_${Math.random().toString(36).slice(2, 5)}`;
    const issuePrefix = cleanName
      .split(/\s+/)
      .map((word) => word[0])
      .join("")
      .toUpperCase()
      .slice(0, 3) || "CO";
    const company = {
      id,
      name: cleanName,
      slug: slugify(cleanName),
      mission: mission.trim(),
      issuePrefix,
      nextIssueNumber: 100,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      settings: {
        approvalPolicy: "high",
        autoMode: false,
        cycleMinutes: 60,
        // 0 = keep going. A company that stops after three cycles is a demo.
        maxCycles: 0,
        reworkLimit: 1,
        // 0 = no limit. Budgeting is opt-in now: the product ships unlimited.
        monthlyBudgetCents: optionalNumber(budgetMonthlyCents, "Budget", { min: 0, max: 10_000_000 }) ?? 0,
        guardrails: { safetyCheck: true, blockUnsafe: true, redactSecrets: true },
        defaultModels: {
          strategist: selectModel("reasoning"),
          operator: selectModel("chat"),
          analyst: selectModel("chat"),
          critic: selectModel("chat"),
          embedding: selectModel("embedding"),
          rerank: selectModel("rerank"),
          image: selectModel("image"),
          safety: selectModel("safety"),
        },
      },
      agents: [],
      goals: [],
      projects: [],
      issues: [],
      comments: [],
      runs: [],
      ledger: [],
      approvals: [],
      activity: [],
      routines: [],
      knowledge: [],
      artifacts: [],
      cycleHistory: [],
      threads: {},
      stats: {},
    };

    // A full-auto launch supplies a complete plan (goal + team + backlog) built
    // from the company brief, so the company is staffed exactly once.
    if (plan?.agents?.length) {
      company.mission = company.mission || plan.goal?.description || "";
      const created = deployPlan(company, plan, { actorId: "human" });
      company.knowledge = [
        createKnowledge({
          title: "Company brief",
          body: `${cleanName}. Goal: ${company.mission || plan.goal?.title || "to be defined"}.\n\nBlueprint: ${plan.blueprint?.name ?? "custom"} (${plan.blueprint?.category ?? "custom"}). This brief was drafted at launch — edit it so agents ground their answers in your real context.`,
          tags: ["company", "brief"],
        }),
      ];
      // The standup runs on the company's own rhythm, and the first one is due
      // immediately so launch → first cycle already produces a report.
      const cadenceMinutes = Math.max(5, Number(company.settings.cycleMinutes) || 60);
      company.routines = [
        createRoutine({
          name: "Cycle standup",
          instruction:
            "Summarise what shipped, what is blocked and what it cost. Name the single most valuable next action toward the goal.",
          agentId: company.agents.find((agent) => agent.role === "strategist")?.id ?? company.agents[0]?.id ?? null,
          cadenceMinutes,
          followsCycle: true,
          nextRunAt: new Date().toISOString(),
        }),
      ];
      store.createCompany(company);
      store.setActive(company.id);
      pushActivity(company, {
        kind: "company.launched",
        actorId: "human",
        subject: cleanName,
        detail: `Full auto · ${created.agents} agents · ${created.issues} issues · ${plan.blueprint?.name ?? "custom blueprint"}`,
      });
      recomputeCompany(company);
      store.saveCompany(company);
      if (company.settings.autoMode) engine.startAuto(company.id);
      return { company, deployed: created };
    }

    if (blueprintId) {
      const plan = planBlueprint(blueprintId, { issuePrefix });
      const blueprint = getBlueprint(blueprintId);
      company.mission = company.mission || blueprint.summary;
      const created = deployPlan(company, plan, { actorId: "human" });
      store.createCompany(company);
      pushActivity(company, {
        kind: "blueprint.deployed",
        actorId: "human",
        subject: blueprint.name,
        detail: `${created.agents} agents · ${created.issues} issues`,
      });
      recomputeCompany(company);
      store.saveCompany(company);
      if (company.settings.autoMode) engine.startAuto(company.id);
      return { company, deployed: created };
    }

    // Default staffing: a small, sensible team so the board is never empty.
    const ceo = createAgent({
      name: "Ada Chen",
      role: "strategist",
      title: "Chief Executive",
      model: company.settings.defaultModels.strategist,
      reportsTo: null,
      monthlyBudgetCents: shareOfCap(company.settings.monthlyBudgetCents, 0.2),
      description: "Sets the cycle focus and owns the goal.",
      instructions: "Turn the company goal into a ranked, dependency-aware plan. Never assign work without a definition of done.",
      capabilities: ["reasoning", "chat", "tools"],
      skills: skillsFor("strategy planning roadmap prioritisation reasoning"),
      accent: "#76b900",
    });
    const operator = createAgent({
      name: "Priya Raman",
      role: "operator",
      title: "Head of Delivery",
      model: company.settings.defaultModels.operator,
      reportsTo: ceo.id,
      monthlyBudgetCents: shareOfCap(company.settings.monthlyBudgetCents, 0.3),
      description: "Produces the deliverables.",
      instructions: "Produce work a reviewer can accept: the change, the metric, the evidence, the rollback.",
      capabilities: ["chat", "tools", "vision"],
      skills: skillsFor("delivery implementation build pipeline deployment"),
      accent: "#4ec9b0",
    });
    const critic = createAgent({
      name: "Lena Fischer",
      role: "critic",
      title: "Quality Lead",
      model: company.settings.defaultModels.critic,
      reportsTo: ceo.id,
      monthlyBudgetCents: shareOfCap(company.settings.monthlyBudgetCents, 0.1),
      description: "Accepts work or sends it back with the exact fix.",
      instructions: "Judge against acceptance criteria only. Reply with JSON. Be hard to impress and specific.",
      capabilities: ["reasoning", "chat"],
      skills: skillsFor("quality review evaluation safety testing"),
      accent: "#ff7b72",
    });
    company.agents = [ceo, operator, critic];
    const goal = createGoal({
      title: company.mission || `Ship the first measurable win for ${cleanName}`,
      metric: "accepted deliverables",
      target: 5,
      baseline: 0,
      current: 0,
      ownerId: ceo.id,
      dueAt: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      description: company.mission,
    });
    company.goals = [goal];
    const project = createProject({ name: "First 30 days", description: "Everything needed to make the mission measurable.", color: "#76b900" });
    company.projects = [project];
    company.issues = [
      createIssue(company, {
        title: "Define the metric and the baseline",
        status: "todo",
        priority: "urgent",
        assigneeId: operator.id,
        projectId: project.id,
        goalId: goal.id,
        description: "Pick the single number this company is trying to move, write down the current value, and name the source of truth.",
        acceptance: ["Metric named with a definition", "Baseline value with a source", "Owner assigned"],
        labels: ["foundation"],
        createdBy: "human",
      }),
      createIssue(company, {
        title: "Map the work that moves that metric",
        status: "todo",
        priority: "high",
        assigneeId: operator.id,
        projectId: project.id,
        goalId: goal.id,
        description: "Break the goal into three deliverables that can each be reviewed in a cycle.",
        acceptance: ["Three deliverables with owners", "Each has a definition of done", "No item over a week"],
        labels: ["planning"],
        createdBy: "human",
      }),
      createIssue(company, {
        title: "Set the quality gate",
        status: "todo",
        priority: "medium",
        assigneeId: critic.id,
        projectId: project.id,
        description: "Write the review checklist every deliverable must pass before it lands on the board as done.",
        acceptance: ["Checklist written", "Applied to one deliverable", "Escalation path defined"],
        labels: ["quality"],
        createdBy: "human",
      }),
    ];
    company.knowledge = [
      createKnowledge({
        title: "Company brief",
        body: `${cleanName}. Mission: ${company.mission || "to be defined"}. This document is the starting point for retrieval — replace it with the real brief so agents ground their answers in your context.`,
        tags: ["company"],
      }),
    ];
    company.routines = [
      createRoutine({
        name: "Morning standup",
        instruction: "Summarise what shipped, what is blocked and what it cost. Name the single most valuable next action.",
        agentId: ceo.id,
        cadenceMinutes: 1440,
      }),
    ];
    pushActivity(company, { kind: "company.created", actorId: "human", subject: cleanName, detail: "Company created with a starter team." });
    recomputeCompany(company);
    store.createCompany(company);
    store.setActive(company.id);
    return { company, deployed: null };
  }

  /**
   * Full auto: create the company from a plan, optionally run its first cycle,
   * and (optionally) leave it in autonomous mode. Steps are reported as they
   * happen so the launcher can show a live checklist.
   */
  async function launchCompany({ name, mission, plan, runCycle = true, autoMode = false, maxIssues = 3, onStep = () => {} } = {}) {
    const step = (entry) => {
      try {
        onStep(entry);
      } catch {
        /* a broken listener must never break a launch */
      }
    };

    const startedAt = Date.now();
    const created = await createCompany({ name, mission, plan });
    const company = created.company;
    step({
      id: "company",
      ok: true,
      label: `${company.name} is staffed`,
      detail: `${created.deployed?.agents ?? company.agents.length} agents · ${created.deployed?.issues ?? 0} issues · prefix ${company.issuePrefix}`,
    });

    if (autoMode) {
      company.settings.autoMode = true;
      store.saveCompany(company);
      engine.startAuto(company.id);
      step({ id: "auto", ok: true, label: "Autonomous mode on", detail: `A cycle every ${company.settings.cycleMinutes} minutes.` });
    }

    let cycle = null;
    if (runCycle) {
      step({ id: "cycle", state: "running", label: "Running the first cycle", detail: "The strategist plans, the team works, quality reviews." });
      try {
        const result = await engine.planCycle({ companyId: company.id, maxIssues });
        cycle = {
          ok: true,
          focus: result.plan?.focus ?? "",
          standup: result.standup ?? "",
          ran: result.results?.length ?? 0,
          accepted: (result.results ?? []).filter((row) => row.verdict === "accepted").length,
          changesRequested: (result.results ?? []).filter((row) => row.verdict === "changes_requested").length,
          blocked: (result.results ?? []).filter((row) => row.blocked).length,
          costCents: result.cycle?.costCents ?? 0,
          cycleId: result.cycle?.id ?? null,
        };
        step({
          id: "cycle",
          ok: true,
          label: "First cycle finished",
          detail: `${cycle.ran} ran · ${cycle.accepted} accepted · ${cycle.changesRequested} changes requested · ${cycle.blocked} blocked`,
        });
      } catch (error) {
        cycle = { ok: false, reason: error.message, code: error.code ?? "cycle_failed" };
        step({ id: "cycle", ok: false, label: "First cycle skipped", detail: error.message });
      }
    }

    step({ id: "done", ok: true, label: "Company is live", detail: `${Math.round((Date.now() - startedAt) / 100) / 10}s end to end.` });
    return { company: store.getCompany(company.id), deployed: created.deployed, cycle, autoMode: Boolean(autoMode) };
  }

  function deployPlan(company, plan, { actorId = "human" } = {}) {
    // Deploying a second blueprint into the same company must not fork the
    // goal: issues join the active goal with the same title instead. Compare on
    // the sentence, not the punctuation — "…per encounter" and "…per encounter."
    // are the same goal.
    const goalKey = (title) => String(title ?? "").trim().toLowerCase().replace(/[.!?\s]+$/, "");
    const existingGoal = company.goals.find(
      (entry) => entry.status === "active" && goalKey(entry.title) === goalKey(plan.goal.title),
    );
    const goal = existingGoal ?? createGoal({ ...plan.goal, ownerId: null, description: plan.goal.description ?? "" });
    if (existingGoal) {
      // A goal created with the starter team is only a placeholder ("accepted
      // deliverables"); the blueprint knows the real metric and unit.
      const generic = !existingGoal.metric || existingGoal.metric === "accepted deliverables";
      if (generic && plan.goal.metric) {
        existingGoal.metric = plan.goal.metric;
        existingGoal.unit = plan.goal.unit ?? existingGoal.unit ?? "";
        existingGoal.target = plan.goal.target ?? existingGoal.target;
        existingGoal.baseline = plan.goal.baseline ?? existingGoal.baseline;
        existingGoal.direction =
          plan.goal.direction ??
          (Number(existingGoal.target) < Number(existingGoal.baseline) ? "decrease" : "increase");
      }
    } else {
      company.goals.unshift(goal);
    }
    const project = createProject({
      name: plan.blueprint.name,
      description: plan.blueprint.summary,
      color: "#6995ff",
    });
    company.projects.unshift(project);
    const agents = plan.agents.map((spec) =>
      createAgent({
        ...spec,
        reportsTo: null,
        capabilities: spec.capabilities ?? [],
        skills: spec.skills ?? [],
      }),
    );
    // Lead reports to the first existing strategist if there is one.
    const existingLead = company.agents.find((agent) => agent.role === "strategist");
    if (existingLead && agents[0]) agents[0].reportsTo = existingLead.id;
    for (const agent of agents.slice(1)) if (agents[0]) agent.reportsTo = agents[0].id;
    company.agents.push(...agents);
    // The goal belongs to whoever it was created for: hiring a second pod must
    // not quietly hand the company goal to the newest lead.
    goal.ownerId = goal.ownerId ?? agents[0]?.id ?? existingLead?.id ?? null;

    // A goal that already exists already owns the "lock the metric" decision.
    const issueSpecs = existingGoal
      ? plan.issues.filter((spec) => !/^lock the metric and baseline/i.test(spec.title))
      : plan.issues;
    const issues = issueSpecs.map((spec) =>
      createIssue(company, {
        title: spec.title,
        description: spec.description,
        priority: spec.priority,
        status: "todo",
        assigneeId: agents[spec.ownerIndex]?.id ?? agents[0]?.id ?? null,
        projectId: project.id,
        goalId: goal.id,
        labels: spec.labels,
        acceptance: spec.acceptance,
        createdBy: actorId,
        source: spec.source,
      }),
    );
    company.issues.unshift(...issues);
    return { agents: agents.length, issues: issues.length, goalId: goal.id, projectId: project.id, agentIds: agents.map((agent) => agent.id) };
  }

  async function deployBlueprint(companyId, blueprintId) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    const blueprint = getBlueprint(blueprintId);
    if (!blueprint) throw httpError(`Unknown blueprint: ${blueprintId}`, 404, "unknown_blueprint");
    // Same planner the launcher uses: real names, matched skills, and a backlog
    // written around this company's goal instead of the blueprint's demo copy.
    const plan = planFromBlueprint(blueprint, {
      companyName: company.name,
      goal: company.mission,
      issuePrefix: company.issuePrefix,
    });
    const created = deployPlan(company, plan, { actorId: "human" });
    pushActivity(company, {
      kind: "blueprint.deployed",
      actorId: "human",
      subject: plan.blueprint.name,
      detail: `${created.agents} agents · ${created.issues} issues`,
    });
    recomputeCompany(company);
    store.saveCompany(company);
    bus?.publish({ companyId, type: "blueprint.deployed", payload: { blueprintId, ...created } });
    return { blueprint: plan.blueprint, ...created };
  }

  function updateCompany(companyId, patch) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    if (patch.name !== undefined) company.name = requireString(patch.name, "Company name", { max: 80 });
    if (patch.mission !== undefined) company.mission = String(patch.mission).slice(0, 2000);
    const settings = patch.settings ?? {};
    if (settings.approvalPolicy !== undefined) {
      if (!["off", "high", "all"].includes(settings.approvalPolicy)) throw httpError("approvalPolicy must be off, high or all.");
      company.settings.approvalPolicy = settings.approvalPolicy;
    }
    if (settings.cycleMinutes !== undefined) {
      company.settings.cycleMinutes = optionalNumber(settings.cycleMinutes, "cycleMinutes", { min: 1, max: 1440 });
      for (const routine of company.routines ?? []) {
        if (!routine.followsCycle) continue;
        routine.cadenceMinutes = Math.max(5, company.settings.cycleMinutes);
        const next = new Date(routine.nextRunAt ?? 0).getTime();
        // Pull a too-far-future run forward; never delay one that is already due.
        if (!Number.isFinite(next) || next > Date.now() + routine.cadenceMinutes * 60_000) {
          routine.nextRunAt = new Date().toISOString();
        }
      }
    }
    if (settings.maxCycles !== undefined) company.settings.maxCycles = optionalNumber(settings.maxCycles, "maxCycles", { min: 0, max: 100 });
    if (settings.reworkLimit !== undefined) company.settings.reworkLimit = optionalNumber(settings.reworkLimit, "reworkLimit", { min: 0, max: 5 });
    if (settings.monthlyBudgetCents !== undefined) {
      company.settings.monthlyBudgetCents = optionalNumber(settings.monthlyBudgetCents, "monthlyBudgetCents", { min: 0, max: 10_000_000 });
    }
    if (settings.guardrails) company.settings.guardrails = { ...company.settings.guardrails, ...settings.guardrails };
    if (settings.defaultModels) company.settings.defaultModels = { ...company.settings.defaultModels, ...settings.defaultModels };
    if (settings.autoMode !== undefined) {
      company.settings.autoMode = Boolean(settings.autoMode);
      if (company.settings.autoMode) engine.startAuto(company.id);
      else engine.stopAuto(company.id);
    }
    recomputeCompany(company);
    store.saveCompany(company);
    bus?.publish({ companyId, type: "company.updated", payload: { company: { id: company.id, name: company.name, settings: company.settings } } });
    return companyView(companyId);
  }

  /* ---------------------------------------------------------------- agents */

  function addAgent(companyId, payload) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    const name = requireString(payload.name, "Agent name", { max: 60 });
    const model = payload.model ? findModel(payload.model)?.id : selectModel("chat");
    if (!model) throw httpError(`Unknown model: ${payload.model}`);
    const agent = createAgent({
      name,
      title: payload.title ? String(payload.title).slice(0, 60) : "Teammate",
      role: ["strategist", "operator", "analyst", "critic"].includes(payload.role) ? payload.role : "operator",
      description: String(payload.description ?? "").slice(0, 600),
      instructions: String(payload.instructions ?? "").slice(0, 4000),
      model,
      temperature: optionalNumber(payload.temperature, "temperature", { min: 0, max: 2 }) ?? 0.4,
      monthlyBudgetCents: optionalNumber(payload.monthlyBudgetCents, "monthlyBudgetCents", { min: 0, max: 1_000_000 }) ?? 0,
      reportsTo: payload.reportsTo ?? null,
      skills: Array.isArray(payload.skills) ? payload.skills.slice(0, 12) : [],
      capabilities: Array.isArray(payload.capabilities) ? payload.capabilities.slice(0, 12) : ["chat"],
    });
    company.agents.push(agent);
    pushActivity(company, { kind: "agent.hired", actorId: "human", subject: agent.name, detail: `${agent.title} on ${findModel(agent.model)?.name ?? agent.model}` });
    recomputeCompany(company);
    store.saveCompany(company);
    bus?.publish({ companyId, type: "agent.hired", payload: { agent } });
    return agent;
  }

  function updateAgent(companyId, agentId, patch) {
    const company = store.getCompany(companyId);
    const agent = findAgent(company ?? {}, agentId);
    if (!company || !agent) throw httpError("Agent not found", 404, "not_found");
    if (patch.name !== undefined) agent.name = requireString(patch.name, "Agent name", { max: 60 });
    if (patch.title !== undefined) agent.title = String(patch.title).slice(0, 60);
    if (patch.role !== undefined && ["strategist", "operator", "analyst", "critic"].includes(patch.role)) agent.role = patch.role;
    if (patch.description !== undefined) agent.description = String(patch.description).slice(0, 600);
    if (patch.instructions !== undefined) agent.instructions = String(patch.instructions).slice(0, 6000);
    if (patch.model !== undefined) {
      const model = findModel(patch.model);
      if (!model) throw httpError(`Unknown model: ${patch.model}`);
      agent.model = model.id;
    }
    if (patch.temperature !== undefined) agent.temperature = optionalNumber(patch.temperature, "temperature", { min: 0, max: 2 });
    if (patch.maxTokens !== undefined) agent.maxTokens = optionalNumber(patch.maxTokens, "maxTokens", { min: 128, max: 32_000 });
    if (patch.monthlyBudgetCents !== undefined) {
      agent.monthlyBudgetCents = optionalNumber(patch.monthlyBudgetCents, "monthlyBudgetCents", { min: 0, max: 1_000_000 });
    }
    if (patch.status !== undefined) {
      if (!AGENT_STATUSES.includes(patch.status)) throw httpError(`status must be one of ${AGENT_STATUSES.join(", ")}`);
      agent.status = patch.status;
    }
    if (patch.skills !== undefined) agent.skills = Array.isArray(patch.skills) ? patch.skills.slice(0, 12) : [];
    if (patch.capabilities !== undefined) agent.capabilities = Array.isArray(patch.capabilities) ? patch.capabilities.slice(0, 12) : [];
    if (patch.reportsTo !== undefined) agent.reportsTo = patch.reportsTo || null;
    recomputeCompany(company);
    store.saveCompany(company);
    bus?.publish({ companyId, type: "agent.updated", payload: { agent } });
    return agent;
  }

  function removeAgent(companyId, agentId) {
    const company = store.getCompany(companyId);
    const agent = findAgent(company ?? {}, agentId);
    if (!company || !agent) throw httpError("Agent not found", 404, "not_found");
    const openIssues = company.issues.filter((issue) => issue.assigneeId === agentId && OPEN_STATUSES.includes(issue.status));
    if (openIssues.length) {
      throw httpError(`${agent.name} still owns ${openIssues.length} open issue(s). Reassign them first.`, 409, "agent_has_work");
    }
    company.agents = company.agents.filter((entry) => entry.id !== agentId);
    company.agents.forEach((entry) => {
      if (entry.reportsTo === agentId) entry.reportsTo = null;
    });
    pushActivity(company, { kind: "agent.removed", actorId: "human", subject: agent.name, detail: "Off the roster." });
    recomputeCompany(company);
    store.saveCompany(company);
    return { ok: true };
  }

  function agentDetail(companyId, agentId) {
    const company = store.getCompany(companyId);
    const agent = findAgent(company ?? {}, agentId);
    if (!company || !agent) throw httpError("Agent not found", 404, "not_found");
    const runs = company.runs.filter((run) => run.agentId === agent.id).slice(0, 30);
    const issues = company.issues.filter((issue) => issue.assigneeId === agent.id);
    const spend = agentSpendStatus(company, agent);
    const byDay = {};
    for (const row of company.ledger.filter((entry) => entry.agentId === agent.id)) {
      const day = row.at.slice(0, 10);
      byDay[day] = Math.round(((byDay[day] ?? 0) + row.costCents) * 100) / 100;
    }
    return {
      agent,
      spend,
      issues,
      runs,
      byDay: Object.entries(byDay).sort((a, b) => a[0].localeCompare(b[0])).slice(-14).map(([day, cents]) => ({ day, cents })),
      skills: agent.skills.map((id) => loadSkills().skills.find((skill) => skill.id === id)).filter(Boolean),
      thread: (company.threads?.[agent.id] ?? []).slice(-20),
      model: findModel(agent.model),
    };
  }

  function setAgentSkills(companyId, agentId, skillIds = []) {
    const valid = new Set(loadSkills().skills.map((skill) => skill.id));
    const clean = skillIds.filter((id) => valid.has(id)).slice(0, 12);
    return updateAgent(companyId, agentId, { skills: clean });
  }

  /* ---------------------------------------------------------------- issues */

  function issueFilters(company, { status, priority, assigneeId, projectId, goalId, label, query, limit = 200 } = {}) {
    let issues = company.issues;
    if (status && status !== "all") {
      const statuses = String(status).split(",");
      issues = issues.filter((issue) => statuses.includes(issue.status) || (statuses.includes("open") && OPEN_STATUSES.includes(issue.status)));
    }
    if (priority && priority !== "all") issues = issues.filter((issue) => issue.priority === priority);
    if (assigneeId) issues = issues.filter((issue) => issue.assigneeId === assigneeId);
    if (projectId) issues = issues.filter((issue) => issue.projectId === projectId);
    if (goalId) issues = issues.filter((issue) => issue.goalId === goalId);
    if (label) issues = issues.filter((issue) => issue.labels.includes(label));
    if (query) {
      const term = String(query).toLowerCase();
      issues = issues.filter((issue) => `${issue.key} ${issue.title} ${issue.description}`.toLowerCase().includes(term));
    }
    return [...issues]
      .sort((a, b) => {
        const statusWeight = (issue) => ISSUE_STATUSES.indexOf(issue.status);
        if (statusWeight(a) !== statusWeight(b)) return statusWeight(a) - statusWeight(b);
        return PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
      })
      .slice(0, limit);
  }

  function listIssues(companyId, filters = {}) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    const issues = issueFilters(company, filters);
    return {
      total: company.issues.length,
      filters,
      counts: {
        all: company.issues.length,
        open: company.issues.filter((issue) => OPEN_STATUSES.includes(issue.status)).length,
        byStatus: Object.fromEntries(ISSUE_STATUSES.map((status) => [status, company.issues.filter((issue) => issue.status === status).length])),
        byPriority: Object.fromEntries(PRIORITIES.map((priority) => [priority, company.issues.filter((issue) => issue.priority === priority).length])),
      },
      issues: issues.map((issue) => ({
        ...issue,
        assignee: findAgent(company, issue.assigneeId) ? { id: issue.assigneeId, name: findAgent(company, issue.assigneeId).name, title: findAgent(company, issue.assigneeId).title } : null,
        project: company.projects.find((project) => project.id === issue.projectId)?.name ?? null,
        comments: company.comments.filter((comment) => comment.issueId === issue.id).length,
        pendingApproval: company.approvals.find((approval) => approval.issueId === issue.id && approval.status === "pending") ?? null,
      })),
    };
  }

  function issueDetail(companyId, issueId) {
    const company = store.getCompany(companyId);
    const issue = findIssue(company ?? {}, issueId);
    if (!company || !issue) throw httpError("Issue not found", 404, "not_found");
    return {
      issue: {
        ...issue,
        assignee: findAgent(company, issue.assigneeId) ?? null,
        project: company.projects.find((project) => project.id === issue.projectId) ?? null,
        goal: company.goals.find((goal) => goal.id === issue.goalId) ?? null,
      },
      comments: company.comments.filter((comment) => comment.issueId === issue.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      runs: company.runs.filter((run) => run.issueId === issue.id).slice(0, 10),
      artifacts: company.artifacts.filter((artifact) => artifact.issueId === issue.id),
      approvals: company.approvals.filter((approval) => approval.issueId === issue.id),
    };
  }

  function createIssueFor(companyId, payload) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    const title = requireString(payload.title, "Title", { max: 160 });
    const status = ISSUE_STATUSES.includes(payload.status) ? payload.status : "todo";
    if (payload.assigneeId && !findAgent(company, payload.assigneeId)) throw httpError("Assignee not found");
    const issue = createIssue(company, {
      title,
      description: String(payload.description ?? "").slice(0, 8000),
      status,
      priority: PRIORITIES.includes(payload.priority) ? payload.priority : "medium",
      assigneeId: payload.assigneeId ?? null,
      projectId: payload.projectId ?? null,
      goalId: payload.goalId ?? null,
      labels: Array.isArray(payload.labels) ? payload.labels.slice(0, 8) : [],
      acceptance: Array.isArray(payload.acceptance) ? payload.acceptance.slice(0, 10) : [],
      createdBy: payload.createdBy ?? "human",
      source: payload.source ?? "human",
      dueAt: payload.dueAt ?? null,
    });
    company.issues.unshift(issue);
    pushActivity(company, { kind: "issue.created", actorId: "human", subject: issue.key, detail: issue.title, issueId: issue.id });
    recomputeCompany(company);
    store.saveCompany(company);
    bus?.publish({ companyId, type: "issue.created", payload: { issue } });
    return issueDetail(companyId, issue.id);
  }

  function updateIssue(companyId, issueId, patch) {
    const company = store.getCompany(companyId);
    const issue = findIssue(company ?? {}, issueId);
    if (!company || !issue) throw httpError("Issue not found", 404, "not_found");
    if (patch.title !== undefined) issue.title = requireString(patch.title, "Title", { max: 160 });
    if (patch.description !== undefined) issue.description = String(patch.description).slice(0, 8000);
    if (patch.status !== undefined) {
      if (!ISSUE_STATUSES.includes(patch.status)) throw httpError(`status must be one of ${ISSUE_STATUSES.join(", ")}`);
      const wasBlocked = issue.status === "blocked";
      issue.status = patch.status;
      if (patch.status !== "blocked") issue.blockedReason = "";
      if (patch.status === "done" && wasBlocked) issue.blockedReason = "";
    }
    if (patch.priority !== undefined) {
      if (!PRIORITIES.includes(patch.priority)) throw httpError(`priority must be one of ${PRIORITIES.join(", ")}`);
      issue.priority = patch.priority;
    }
    if (patch.assigneeId !== undefined) {
      if (patch.assigneeId && !findAgent(company, patch.assigneeId)) throw httpError("Assignee not found");
      issue.assigneeId = patch.assigneeId || null;
    }
    if (patch.projectId !== undefined) issue.projectId = patch.projectId || null;
    if (patch.goalId !== undefined) issue.goalId = patch.goalId || null;
    if (patch.labels !== undefined) issue.labels = Array.isArray(patch.labels) ? patch.labels.slice(0, 8) : [];
    if (patch.acceptance !== undefined) issue.acceptance = Array.isArray(patch.acceptance) ? patch.acceptance.slice(0, 10) : [];
    if (patch.blockedReason !== undefined) issue.blockedReason = String(patch.blockedReason).slice(0, 600);
    issue.updatedAt = nowIso();
    pushActivity(company, {
      kind: patch.status ? `issue.${patch.status}` : "issue.updated",
      actorId: "human",
      subject: issue.key,
      detail: issue.title,
      issueId: issue.id,
    });
    recomputeCompany(company);
    store.saveCompany(company);
    bus?.publish({ companyId, type: "issue.updated", payload: { issue } });
    return issueDetail(companyId, issue.id);
  }

  function deleteIssue(companyId, issueId) {
    const company = store.getCompany(companyId);
    const issue = findIssue(company ?? {}, issueId);
    if (!company || !issue) throw httpError("Issue not found", 404, "not_found");
    company.issues = company.issues.filter((entry) => entry.id !== issue.id);
    company.comments = company.comments.filter((comment) => comment.issueId !== issue.id);
    company.artifacts = company.artifacts.filter((artifact) => artifact.issueId !== issue.id);
    recomputeCompany(company);
    store.saveCompany(company);
    return { ok: true };
  }

  function addComment(companyId, issueId, { body, authorType = "human", authorId = "you" }) {
    const company = store.getCompany(companyId);
    const issue = findIssue(company ?? {}, issueId);
    if (!company || !issue) throw httpError("Issue not found", 404, "not_found");
    const text = requireString(body, "Comment", { max: 20_000 });
    const comment = createComment({ issueId: issue.id, authorType, authorId, body: text, kind: "comment" });
    company.comments.unshift(comment);
    issue.updatedAt = nowIso();
    pushActivity(company, { kind: "issue.commented", actorId: authorId, subject: issue.key, detail: text.slice(0, 120), issueId: issue.id });
    store.saveCompany(company);
    bus?.publish({ companyId, type: "comment.created", payload: { comment, issueId: issue.id } });
    return comment;
  }

  /* -------------------------------------------------------- goals/projects */

  function upsertGoal(companyId, goalId, payload) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    let goal = goalId ? company.goals.find((entry) => entry.id === goalId) : null;
    if (goalId && !goal) throw httpError("Goal not found", 404, "not_found");
    if (!goal) {
      goal = createGoal({ title: requireString(payload.title, "Goal title", { max: 140 }) });
      company.goals.unshift(goal);
    }
    if (payload.title !== undefined) goal.title = requireString(payload.title, "Goal title", { max: 140 });
    if (payload.description !== undefined) goal.description = String(payload.description).slice(0, 2000);
    if (payload.metric !== undefined) goal.metric = String(payload.metric).slice(0, 80);
    if (payload.unit !== undefined) goal.unit = String(payload.unit).slice(0, 24);
    if (payload.baseline !== undefined) goal.baseline = optionalNumber(payload.baseline, "baseline") ?? goal.baseline;
    if (payload.target !== undefined) goal.target = optionalNumber(payload.target, "target") ?? goal.target;
    if (payload.current !== undefined) goal.current = optionalNumber(payload.current, "current") ?? goal.current;
    if (payload.ownerId !== undefined) goal.ownerId = payload.ownerId || null;
    if (payload.direction !== undefined) {
      goal.direction = payload.direction === "decrease" ? "decrease" : "increase";
    } else if (payload.baseline !== undefined || payload.target !== undefined) {
      // The numbers are the truth: 24 → 8 improves downward even if the goal was
      // first created with only a title. An explicit `direction` is never inferred.
      // An unmeasured baseline stays unknown — it is not zero.
      const baseline = Number(goal.baseline);
      const target = Number(goal.target);
      if (goal.baseline !== null && goal.baseline !== undefined && Number.isFinite(baseline) && Number.isFinite(target)) {
        goal.direction = target < baseline ? "decrease" : "increase";
      }
    }
    if (payload.status !== undefined) goal.status = String(payload.status);
    recomputeCompany(company);
    store.saveCompany(company);
    return goal;
  }

  function upsertProject(companyId, projectId, payload) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    let project = projectId ? company.projects.find((entry) => entry.id === projectId) : null;
    if (projectId && !project) throw httpError("Project not found", 404, "not_found");
    if (!project) {
      project = createProject({ name: requireString(payload.name, "Project name", { max: 80 }) });
      company.projects.unshift(project);
    }
    if (payload.name !== undefined) project.name = requireString(payload.name, "Project name", { max: 80 });
    if (payload.description !== undefined) project.description = String(payload.description).slice(0, 1000);
    if (payload.color !== undefined) project.color = String(payload.color).slice(0, 24);
    store.saveCompany(company);
    return project;
  }

  /* -------------------------------------------------------------- knowledge */

  async function addKnowledge(companyId, payload) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    const doc = createKnowledge({
      title: requireString(payload.title, "Title", { max: 140 }),
      body: String(payload.body ?? "").slice(0, 100_000),
      tags: Array.isArray(payload.tags) ? payload.tags.slice(0, 8) : [],
      source: payload.source ?? "human",
    });
    company.knowledge.unshift(doc);
    pushActivity(company, { kind: "knowledge.indexed", actorId: "human", subject: doc.title, detail: `${doc.body.length} chars` });
    store.saveCompany(company);
    return { id: doc.id, title: doc.title, tags: doc.tags, createdAt: doc.createdAt, chars: doc.body.length };
  }

  function updateKnowledge(companyId, docId, payload) {
    const company = store.getCompany(companyId);
    const doc = company?.knowledge.find((entry) => entry.id === docId);
    if (!company || !doc) throw httpError("Document not found", 404, "not_found");
    if (payload.title !== undefined) doc.title = requireString(payload.title, "Title", { max: 140 });
    if (payload.body !== undefined) doc.body = String(payload.body).slice(0, 100_000);
    if (payload.tags !== undefined) doc.tags = Array.isArray(payload.tags) ? payload.tags.slice(0, 8) : [];
    store.saveCompany(company);
    return doc;
  }

  function deleteKnowledge(companyId, docId) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    company.knowledge = company.knowledge.filter((doc) => doc.id !== docId);
    store.saveCompany(company);
    return { ok: true };
  }

  async function knowledgeSearch(companyId, query, topK = 5) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    const result = await searchKnowledge({ company, nim, query: requireString(query, "query", { max: 500 }), topK });
    return result;
  }

  /* -------------------------------------------------------------- routines */

  function upsertRoutine(companyId, routineId, payload) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    let routine = routineId ? company.routines.find((entry) => entry.id === routineId) : null;
    if (routineId && !routine) throw httpError("Routine not found", 404, "not_found");
    if (!routine) {
      routine = createRoutine({ name: requireString(payload.name, "Routine name", { max: 80 }) });
      company.routines.unshift(routine);
    }
    if (payload.name !== undefined) routine.name = requireString(payload.name, "Routine name", { max: 80 });
    if (payload.instruction !== undefined) routine.instruction = String(payload.instruction).slice(0, 2000);
    if (payload.agentId !== undefined) routine.agentId = payload.agentId || null;
    if (payload.cadenceMinutes !== undefined) routine.cadenceMinutes = optionalNumber(payload.cadenceMinutes, "cadenceMinutes", { min: 5, max: 525_600 });
    if (payload.enabled !== undefined) routine.enabled = Boolean(payload.enabled);
    routine.nextRunAt = new Date(Date.now() + routine.cadenceMinutes * 60_000).toISOString();
    store.saveCompany(company);
    return routine;
  }

  /* ------------------------------------------------------------ dashboard */

  function dashboard(companyId) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    recomputeCompany(company);
    const fourteenDaysAgo = Date.now() - 14 * 86_400_000;
    const runs = company.runs.filter((run) => new Date(run.startedAt ?? run.createdAt ?? 0).getTime() >= fourteenDaysAgo);
    const weekAgo = Date.now() - 7 * 86_400_000;
    const recentLedger = company.ledger.filter((row) => new Date(row.at).getTime() >= fourteenDaysAgo);
    const byDay = {};
    for (let index = 13; index >= 0; index -= 1) {
      const day = new Date(Date.now() - index * 86_400_000).toISOString().slice(0, 10);
      byDay[day] = { day, cents: 0, runs: 0, succeeded: 0, failed: 0 };
    }
    for (const row of recentLedger) {
      const day = row.at.slice(0, 10);
      if (byDay[day]) byDay[day].cents = Math.round((byDay[day].cents + row.costCents) * 100) / 100;
    }
    for (const run of runs) {
      const day = (run.startedAt ?? "").slice(0, 10);
      if (byDay[day]) {
        byDay[day].runs += 1;
        if (run.status === "succeeded") byDay[day].succeeded += 1;
        if (run.status === "failed") byDay[day].failed += 1;
      }
    }
    const finished = company.runs.filter((run) => run.status !== "running" && run.startedAt);
    const successRate = finished.length ? Math.round((finished.filter((run) => run.status === "succeeded").length / finished.length) * 100) : 0;
    const topAgentRows = company.agents
      .map((agent) => ({ agent, spend: agentSpend(company, agent.id) }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 5);
    return {
      stats: company.stats,
      agents: company.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        title: agent.title,
        accent: agent.accent,
        status: agent.status,
        model: agent.model,
        spend: agentSpendStatus(company, agent),
        lastRun: company.runs.find((run) => run.agentId === agent.id) ?? null,
      })),
      charts: {
        byDay: Object.values(byDay),
        byPriority: PRIORITIES.map((priority) => ({ priority, count: company.issues.filter((issue) => issue.priority === priority && OPEN_STATUSES.includes(issue.status)).length })),
        byStatus: ISSUE_STATUSES.map((status) => ({ status, count: company.issues.filter((issue) => issue.status === status).length })),
        successRate,
      },
      recentActivity: company.activity.slice(0, 12),
      recentIssues: issueFilters(company, { status: "open", limit: 8 }),
      spend: {
        totalCents: Math.round(company.ledger.reduce((sum, row) => sum + row.costCents, 0)),
        weekCents: Math.round(company.ledger.filter((row) => new Date(row.at).getTime() >= weekAgo).reduce((sum, row) => sum + row.costCents, 0)),
        capCents: company.settings.monthlyBudgetCents ?? 0,
        unlimited: !((company.settings.monthlyBudgetCents ?? 0) > 0),
        topAgents: topAgentRows.map(({ agent, spend: cents }) => ({ id: agent.id, name: agent.name, cents })),
      },
      cycles: (company.cycleHistory ?? []).slice(0, 5),
    };
  }

  function inbox(companyId) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    const items = [];
    for (const approval of company.approvals.filter((entry) => entry.status === "pending")) {
      const issue = findIssue(company, approval.issueId);
      items.push({
        id: `approval:${approval.id}`,
        kind: "approval",
        at: approval.createdAt,
        title: `Approval needed: ${approval.action}`,
        detail: approval.reason,
        issueKey: issue?.key ?? null,
        issueId: issue?.id ?? null,
        risk: approval.risk,
        actions: ["approve", "deny"],
        approvalId: approval.id,
      });
    }
    for (const issue of company.issues.filter((entry) => entry.status === "blocked")) {
      items.push({
        id: `blocked:${issue.id}`,
        kind: "blocked",
        at: issue.updatedAt,
        title: `${issue.key} is blocked`,
        detail: issue.blockedReason || "No reason recorded.",
        issueKey: issue.key,
        issueId: issue.id,
        actions: ["open"],
      });
    }
    for (const run of company.runs.filter((entry) => entry.status === "failed").slice(0, 6)) {
      const issue = findIssue(company, run.issueId);
      items.push({
        id: `run:${run.id}`,
        kind: "run_failed",
        at: run.endedAt ?? run.startedAt,
        title: `Run failed on ${issue?.key ?? "an issue"}`,
        detail: run.error ?? "Unknown error",
        issueKey: issue?.key ?? null,
        issueId: issue?.id ?? null,
        actions: ["open"],
      });
    }
    for (const agent of company.agents.filter((entry) => entry.status === "over_budget")) {
      items.push({
        id: `budget:${agent.id}`,
        kind: "over_budget",
        at: nowIso(),
        title: `${agent.name} is over budget`,
        detail: `Spent ${(agentSpendStatus(company, agent).spentCents / 100).toFixed(2)} of ${(agent.monthlyBudgetCents / 100).toFixed(2)}.`,
        actions: ["open_agent"],
        agentId: agent.id,
      });
    }
    const pending = company.approvals.filter((approval) => approval.status === "pending").length;
    return {
      items: items.sort((a, b) => String(b.at).localeCompare(String(a.at))),
      counts: { total: items.length, pending, blocked: company.issues.filter((issue) => issue.status === "blocked").length, overBudget: company.agents.filter((agent) => agent.status === "over_budget").length },
    };
  }

  function ledgerView(companyId) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    const byModel = new Map();
    const byAgent = new Map();
    for (const row of company.ledger) {
      const model = byModel.get(row.model) ?? { model: row.model, cents: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
      model.cents += row.costCents;
      model.calls += 1;
      model.inputTokens += row.inputTokens;
      model.outputTokens += row.outputTokens;
      byModel.set(row.model, model);
      const agent = byAgent.get(row.agentId) ?? { agentId: row.agentId, cents: 0, calls: 0 };
      agent.cents += row.costCents;
      agent.calls += 1;
      byAgent.set(row.agentId, agent);
    }
    return {
      totalCents: Math.round(company.ledger.reduce((sum, row) => sum + row.costCents, 0)),
      capCents: company.settings.monthlyBudgetCents ?? 0,
      unlimited: !((company.settings.monthlyBudgetCents ?? 0) > 0),
      rows: company.ledger.slice(0, 200),
      byModel: [...byModel.values()].sort((a, b) => b.cents - a.cents),
      byAgent: [...byAgent.values()]
        .map((row) => ({ ...row, name: findAgent(company, row.agentId)?.name ?? "system" }))
        .sort((a, b) => b.cents - a.cents),
      agents: company.agents.map((agent) => ({ id: agent.id, name: agent.name, ...agentSpendStatus(company, agent), model: agent.model })),
    };
  }

  function orgChart(companyId) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    return {
      agents: company.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        title: agent.title,
        role: agent.role,
        reportsTo: agent.reportsTo,
        accent: agent.accent,
        status: agent.status,
        model: agent.model,
        spend: agentSpendStatus(company, agent),
        openIssues: company.issues.filter((issue) => issue.assigneeId === agent.id && OPEN_STATUSES.includes(issue.status)).length,
        skills: agent.skills.length,
      })),
    };
  }

  function exportCompany(companyId) {
    const company = store.getCompany(companyId);
    if (!company) throw httpError("Company not found", 404, "not_found");
    return {
      format: "paperclip-nim/company@1",
      exportedAt: nowIso(),
      company: {
        ...company,
        knowledge: company.knowledge.map(({ embedding, ...doc }) => doc),
        threads: undefined,
      },
    };
  }

  function importCompany(document) {
    const raw = document?.company ?? document;
    if (!raw?.name || !Array.isArray(raw.agents)) throw httpError("Not a Paperclip × NIM company export.");
    const id = `co_${slugify(raw.name).replace(/-/g, "_")}_${Math.random().toString(36).slice(2, 5)}`;
    const company = {
      ...raw,
      id,
      slug: slugify(raw.name),
      createdAt: raw.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      threads: {},
      stats: {},
    };
    recomputeCompany(company);
    store.createCompany(company);
    store.setActive(company.id);
    return companyView(company.id);
  }

  function allSkills() {
    return loadSkills();
  }

  return {
    ensureSeed,
    removeBudgetLimits,
    bootstrap,
    companyView,
    createCompany,
    launchCompany,
    updateCompany,
    deployBlueprint,
    addAgent,
    updateAgent,
    removeAgent,
    agentDetail,
    setAgentSkills,
    listIssues,
    issueDetail,
    createIssue: createIssueFor,
    updateIssue,
    deleteIssue,
    addComment,
    upsertGoal,
    upsertProject,
    addKnowledge,
    updateKnowledge,
    deleteKnowledge,
    knowledgeSearch,
    upsertRoutine,
    dashboard,
    inbox,
    ledgerView,
    orgChart,
    exportCompany,
    importCompany,
    allSkills,
    searchSkills,
    suggestSkills,
    skillStats,
    estimateCost,
  };
}
