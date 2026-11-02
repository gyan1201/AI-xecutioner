import { AGENT_ROLES } from "./store.mjs";
import { extractJson } from "../nim.mjs";

/**
 * Org design: turn one company goal into a staffed, budgeted, roadmapped company.
 *
 * The strategist model proposes the org; `normalizeOrg` clamps it to the enums
 * Paperclip understands, so the result can be mirrored into a real Paperclip
 * instance. A deterministic blueprint is used when the model is unavailable or
 * its JSON cannot be parsed, so company creation never dead-ends.
 */

const MAX_AGENTS = 10;
const MAX_ISSUES = 16;

/** Employee role → capability archetype used to pick a NIM model. */
export const ROLE_ARCHETYPE = {
  ceo: "strategist",
  cto: "operator",
  cmo: "operator",
  cfo: "analyst",
  security: "safety",
  engineer: "operator",
  designer: "operator",
  pm: "strategist",
  qa: "critic",
  devops: "operator",
  researcher: "analyst",
  general: "operator",
};

/** Budget share per role, applied when the model does not allocate one. */
export const ROLE_BUDGET_SHARE = {
  ceo: 0.1,
  cto: 0.16,
  cmo: 0.1,
  cfo: 0.06,
  security: 0.06,
  engineer: 0.22,
  designer: 0.08,
  pm: 0.08,
  qa: 0.06,
  devops: 0.05,
  researcher: 0.03,
  general: 0.04,
};

const ORG_SYSTEM_PROMPT = `You design small, effective AI companies that run on NVIDIA NIM agents.
Given one company goal you return the org, the goals, the projects and the initial task backlog.
Return ONLY valid JSON with this shape:
{
  "mission": string,
  "departments": [{ "name": string, "mission": string }],
  "agents": [{
    "name": string,              // a human first name + surname
    "role": "ceo"|"cto"|"cmo"|"cfo"|"security"|"engineer"|"designer"|"pm"|"qa"|"devops"|"researcher"|"general",
    "title": string,
    "department": string,        // must match a department name
    "reportsToRole": string|null,// role of the manager, null for the CEO
    "capabilities": [string],
    "skills": [string],
    "instructions": string,      // how this agent should work, max 2 sentences
    "budgetShare": number        // 0..1, all agents sum to ~1
  }],
  "goals": [{
    "title": string,
    "description": string,
    "level": "company"|"team"|"agent",
    "kpis": [{ "name": string, "target": string, "current": string, "measure": string }]
  }],
  "projects": [{ "name": string, "description": string, "goalIndex": number }],
  "issues": [{
    "title": string,
    "description": string,
    "priority": "critical"|"high"|"medium"|"low",
    "assigneeRole": string,
    "projectIndex": number,
    "goalIndex": number,
    "acceptanceCriteria": [string],
    "estimate": "S"|"M"|"L",
    "needsApproval": boolean
  }]
}
Rules:
- Exactly one "ceo". 4 to 7 agents total. Only hire roles the goal needs.
- Every agent except the CEO has "reportsToRole".
- 3 to 8 issues, each concrete enough that an agent can finish it in one working session.
- Exactly one goal with level "company"; team goals may follow.
- Mark externally visible work (spend, publishing, legal, deleting data) as needsApproval true.
No prose outside the JSON.`;

function firstWords(text, count) {
  return String(text ?? "").replace(/\s+/g, " ").trim().split(" ").slice(0, count).join(" ");
}

function titleCase(text) {
  return String(text ?? "").replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

/**
 * Deterministic org blueprint. Also serves as the shape contract for the model.
 * Keyword routing keeps it relevant: growth goals hire a CMO, product goals a
 * PM/engineer/designer, cost goals a CFO, and so on.
 */
export function buildBlueprint(goal, { companyName = "the company", size } = {}) {
  const text = String(goal ?? "").toLowerCase();
  const wants = (...terms) => terms.some((term) => text.includes(term));

  const roster = [
    {
      name: "Avery Chen",
      role: "ceo",
      title: "Chief Executive Officer",
      department: "Executive",
      reportsToRole: null,
      capabilities: ["strategy", "goal setting", "prioritisation", "budgeting"],
      skills: ["planning", "executive reporting"],
      instructions: "Set the operating focus each cycle, resolve conflicts between leads, and keep spend inside budget.",
      budgetShare: 0.1,
    },
    {
      name: "Priya Raman",
      role: "cto",
      title: "Chief Technology Officer",
      department: "Product & Engineering",
      reportsToRole: "ceo",
      capabilities: ["architecture", "delivery", "technical review"],
      skills: ["system design", "code review"],
      instructions: "Own delivery feasibility. Cut scope instead of quality, and escalate anything that needs procurement.",
      budgetShare: 0.16,
    },
  ];

  if (wants("product", "app", "platform", "software", "saas", "build", "launch", "onboarding", "feature")) {
    roster.push(
      {
        name: "Marco Silva",
        role: "pm",
        title: "Product Manager",
        department: "Product & Engineering",
        reportsToRole: "cto",
        capabilities: ["discovery", "specification", "prioritisation"],
        skills: ["user stories", "acceptance criteria"],
        instructions: "Write specs with testable acceptance criteria and defend the smallest shippable slice.",
        budgetShare: 0.08,
      },
      {
        name: "Lena Okafor",
        role: "engineer",
        title: "Senior Engineer",
        department: "Product & Engineering",
        reportsToRole: "cto",
        capabilities: ["implementation", "testing", "debugging"],
        skills: ["typescript", "api design"],
        instructions: "Ship working code with tests. State assumptions explicitly and never invent API contracts.",
        budgetShare: 0.2,
      },
      {
        name: "Sofia Almeida",
        role: "designer",
        title: "Product Designer",
        department: "Product & Engineering",
        reportsToRole: "cto",
        capabilities: ["ux", "prototyping", "copy"],
        skills: ["flows", "wireframes"],
        instructions: "Design for the smallest complete user journey and hand off precise states.",
        budgetShare: 0.08,
      },
    );
  }

  if (wants("growth", "market", "revenue", "sales", "launch", "brand", "customer", "activation", "pipeline", "mrr")) {
    roster.push({
      name: "Noah Bergström",
      role: "cmo",
      title: "Head of Growth",
      department: "Go-to-market",
      reportsToRole: "ceo",
      capabilities: ["positioning", "campaigns", "funnel analysis"],
      skills: ["messaging", "experimentation"],
      instructions: "Tie every campaign to a measurable activation or pipeline outcome. No vanity metrics.",
      budgetShare: 0.12,
    });
  }

  if (wants("cost", "margin", "pricing", "finance", "budget", "profit", "runway")) {
    roster.push({
      name: "Hana Sato",
      role: "cfo",
      title: "Chief Financial Officer",
      department: "Finance",
      reportsToRole: "ceo",
      capabilities: ["unit economics", "forecasting", "pricing"],
      skills: ["modelling", "scenario analysis"],
      instructions: "Model base and downside cases with explicit assumptions. Never present a forecast as a fact.",
      budgetShare: 0.08,
    });
  }

  roster.push(
    {
      name: "Iris Novak",
      role: "researcher",
      title: "Research Lead",
      department: "Insights",
      reportsToRole: "ceo",
      capabilities: ["market research", "synthesis", "evidence"],
      skills: ["competitive analysis", "interviews"],
      instructions: "Ground claims in retrieved context and label every estimate as an assumption.",
      budgetShare: 0.08,
    },
    {
      name: "Dev Kapoor",
      role: "qa",
      title: "Quality Lead",
      department: "Product & Engineering",
      reportsToRole: "cto",
      capabilities: ["review", "risk assessment", "acceptance"],
      skills: ["test plans", "root cause analysis"],
      instructions: "Review every deliverable against its acceptance criteria. Send back anything vague.",
      budgetShare: 0.08,
    },
  );

  const trimmed = roster.slice(0, size && size > 3 ? Math.max(4, Math.min(size, MAX_AGENTS)) : roster.length);
  if (!trimmed.some((agent) => agent.role === "ceo")) trimmed.unshift(roster[0]);
  // Re-balance shares after trimming so budgets still sum to 1.
  const shareTotal = trimmed.reduce((sum, agent) => sum + agent.budgetShare, 0) || 1;
  for (const agent of trimmed) agent.budgetShare = Number((agent.budgetShare / shareTotal).toFixed(4));

  const departments = [...new Set(trimmed.map((agent) => agent.department))].map((name) => ({
    name,
    mission:
      name === "Executive"
        ? "Set direction, allocate budget and keep the company honest about outcomes."
        : name === "Go-to-market"
          ? "Turn the product into measurable demand and revenue."
          : name === "Finance"
            ? "Protect margin and make the economics explicit."
            : name === "Insights"
              ? "Supply evidence the rest of the company can act on."
              : "Build and ship the thing customers pay for.",
  }));

  const engineers = trimmed.filter((agent) => ["engineer", "designer", "pm"].includes(agent.role));
  const growth = trimmed.find((agent) => agent.role === "cmo");
  const scope = firstWords(goal, 14) || "the company goal";

  return {
    mission: String(goal ?? "").trim() || `${companyName} mission`,
    departments,
    agents: trimmed,
    goals: [
      {
        title: titleCase(firstWords(goal, 10) || "Reach the company goal"),
        description: String(goal ?? "").trim(),
        level: "company",
        kpis: [
          { name: "Primary outcome", target: "Defined and tracked this cycle", current: "baseline pending", measure: "Company dashboard" },
          { name: "Cycle time", target: "Shipped work every cycle", current: "0 cycles", measure: "Company activity log" },
          { name: "Cost per outcome", target: "Inside monthly budget", current: "tracking", measure: "Cost ledger" },
        ],
      },
      {
        title: "Prove the delivery loop",
        description: `Produce a reviewed, customer-ready deliverable for: ${scope}`,
        level: "team",
        kpis: [
          { name: "Deliverables accepted", target: "1 per cycle", current: "0", measure: "Issue review outcomes" },
        ],
      },
    ],
    projects: [
      {
        name: titleCase(firstWords(goal, 5) || "Company plan"),
        description: `Execution project for ${scope}.`,
        goalIndex: 0,
      },
    ],
    issues: [
      {
        title: "Write the strategy memo and success metrics",
        description: `Turn the goal into a decision-ready memo: segments, wedge, sequencing, risks and 3 measurable KPIs.\n\nGoal: ${scope}`,
        priority: "critical",
        assigneeRole: engineers.length ? "pm" : "ceo",
        projectIndex: 0,
        goalIndex: 0,
        acceptanceCriteria: ["Names a target segment and wedge", "Defines 3 KPIs with current and target values", "Lists the top 3 risks with mitigations"],
        estimate: "M",
        needsApproval: false,
      },
      {
        title: "Ship the first working slice",
        description: "Implement the smallest complete slice that a customer could use end to end. Document assumptions and how to verify it.",
        priority: "high",
        assigneeRole: engineers.some((agent) => agent.role === "engineer") ? "engineer" : "cto",
        projectIndex: 0,
        goalIndex: 1,
        acceptanceCriteria: ["Scope is explicitly bounded", "Verification steps are written down", "Known gaps are listed"],
        estimate: "L",
        needsApproval: false,
      },
      {
        title: "Design the end-to-end user journey",
        description: "Map the first-run experience from landing to first value, including empty, error and success states.",
        priority: "medium",
        assigneeRole: engineers.some((agent) => agent.role === "designer") ? "designer" : "pm",
        projectIndex: 0,
        goalIndex: 1,
        acceptanceCriteria: ["Journey covers first value in under 5 steps", "Empty/error/success states are specified"],
        estimate: "M",
        needsApproval: false,
      },
      {
        title: "Quantify the economics of the plan",
        description: "Model cost per outcome and expected return over 60 days. Show base and downside cases with assumptions.",
        priority: "high",
        assigneeRole: trimmed.some((agent) => agent.role === "cfo") ? "cfo" : "researcher",
        projectIndex: 0,
        goalIndex: 0,
        acceptanceCriteria: ["Base and downside cases shown", "Every assumption labelled", "Cost per outcome computed"],
        estimate: "M",
        needsApproval: false,
      },
      {
        title: "Draft the launch announcement",
        description: "Write the customer-facing launch copy and internal enablement note. Public publishing needs approval.",
        priority: "medium",
        assigneeRole: growth ? "cmo" : "ceo",
        projectIndex: 0,
        goalIndex: 0,
        acceptanceCriteria: ["Copy makes one concrete promise", "Internal note explains how to sell it"],
        estimate: "S",
        needsApproval: true,
      },
      {
        title: "Run an acceptance review of the cycle",
        description: "Review each deliverable against its acceptance criteria and record what must change next cycle.",
        priority: "low",
        assigneeRole: trimmed.some((agent) => agent.role === "qa") ? "qa" : "ceo",
        projectIndex: 0,
        goalIndex: 1,
        acceptanceCriteria: ["Every deliverable is marked pass or rework", "Next-cycle changes are listed"],
        estimate: "S",
        needsApproval: false,
      },
    ],
  };
}

function clampAgents(agents, blueprint) {
  const seen = new Set();
  const cleaned = [];
  for (const agent of agents) {
    const role = AGENT_ROLES.includes(agent?.role) ? agent.role : "general";
    if (role === "ceo" && seen.has("ceo")) continue;
    seen.add(role + (cleaned.length === 0 ? 0 : 1));
    cleaned.push({
      name: String(agent?.name ?? `Agent ${cleaned.length + 1}`).slice(0, 80),
      role,
      title: String(agent?.title ?? role.toUpperCase()).slice(0, 120),
      department: String(agent?.department ?? "General").slice(0, 80),
      reportsToRole: AGENT_ROLES.includes(agent?.reportsToRole) ? agent.reportsToRole : role === "ceo" ? null : "ceo",
      capabilities: Array.isArray(agent?.capabilities) ? agent.capabilities.slice(0, 8).map(String) : [],
      skills: Array.isArray(agent?.skills) ? agent.skills.slice(0, 8).map(String) : [],
      instructions: String(agent?.instructions ?? "").slice(0, 600),
      budgetShare: Math.max(0.01, Math.min(Number(agent?.budgetShare) || 0.1, 0.6)),
    });
    if (cleaned.length >= MAX_AGENTS) break;
  }
  if (!cleaned.length) return blueprint.agents;
  if (!cleaned.some((agent) => agent.role === "ceo")) {
    cleaned.unshift(blueprint.agents.find((agent) => agent.role === "ceo") ?? blueprint.agents[0]);
  }
  const total = cleaned.reduce((sum, agent) => sum + agent.budgetShare, 0) || 1;
  for (const agent of cleaned) agent.budgetShare = Number((agent.budgetShare / total).toFixed(4));
  return cleaned;
}

/** Normalise any (possibly messy) org proposal into the shape the store accepts. */
export function normalizeOrg(proposal, { goal, companyName, fallback = buildBlueprint(goal, { companyName }) }) {
  const source = proposal && typeof proposal === "object" ? proposal : {};
  const agents = clampAgents(Array.isArray(source.agents) ? source.agents : [], fallback);
  const departmentNames = new Set(agents.map((agent) => agent.department));
  const departments = (Array.isArray(source.departments) ? source.departments : fallback.departments)
    .filter((department) => department && department.name)
    .slice(0, 6)
    .map((department) => ({ name: String(department.name).slice(0, 80), mission: String(department.mission ?? "").slice(0, 300) }));
  for (const name of departmentNames) {
    if (!departments.some((department) => department.name === name)) departments.push({ name, mission: "" });
  }

  const goals = (Array.isArray(source.goals) ? source.goals : fallback.goals)
    .slice(0, 6)
    .map((goal_, index) => ({
      title: String(goal_?.title ?? `Goal ${index + 1}`).slice(0, 200),
      description: String(goal_?.description ?? "").slice(0, 2000),
      level: ["company", "team", "agent"].includes(goal_?.level) ? goal_.level : index === 0 ? "company" : "team",
      kpis: (Array.isArray(goal_?.kpis) ? goal_.kpis : []).slice(0, 4).map((kpi) => ({
        name: String(kpi?.name ?? "KPI").slice(0, 120),
        target: String(kpi?.target ?? "").slice(0, 80),
        current: String(kpi?.current ?? "0").slice(0, 40),
        measure: String(kpi?.measure ?? "").slice(0, 200),
      })),
    }));
  if (!goals.length) goals.push(...fallback.goals);

  const projects = (Array.isArray(source.projects) ? source.projects : fallback.projects)
    .slice(0, 4)
    .map((project, index) => ({
      name: String(project?.name ?? `Project ${index + 1}`).slice(0, 120),
      description: String(project?.description ?? "").slice(0, 600),
      goalIndex: Number.isInteger(project?.goalIndex) ? Math.min(Math.max(project.goalIndex, 0), goals.length - 1) : 0,
    }));
  if (!projects.length) projects.push(...fallback.projects);

  const issues = (Array.isArray(source.issues) ? source.issues : fallback.issues)
    .filter((issue) => issue && issue.title)
    .slice(0, MAX_ISSUES)
    .map((issue) => ({
      title: String(issue.title).slice(0, 240),
      description: String(issue.description ?? "").slice(0, 4000),
      priority: ["critical", "high", "medium", "low"].includes(issue.priority) ? issue.priority : "medium",
      assigneeRole: AGENT_ROLES.includes(issue.assigneeRole) ? issue.assigneeRole : "general",
      projectIndex: Number.isInteger(issue.projectIndex) ? Math.min(Math.max(issue.projectIndex, 0), projects.length - 1) : 0,
      goalIndex: Number.isInteger(issue.goalIndex) ? Math.min(Math.max(issue.goalIndex, 0), goals.length - 1) : 0,
      acceptanceCriteria: (Array.isArray(issue.acceptanceCriteria) ? issue.acceptanceCriteria : []).slice(0, 6).map(String),
      estimate: ["S", "M", "L"].includes(issue.estimate) ? issue.estimate : "M",
      needsApproval: Boolean(issue.needsApproval),
    }));
  if (!issues.length) issues.push(...fallback.issues);

  return {
    mission: String(source.mission ?? fallback.mission ?? goal).slice(0, 400),
    departments,
    agents,
    goals,
    projects,
    issues,
  };
}

/**
 * Ask the strategist model for an org; fall back to the blueprint.
 * @returns {Promise<{ org: ReturnType<typeof normalizeOrg>, source: "model"|"blueprint", usage: object|null, raw?: string }>}
 */
export async function designOrg({ nim, role, goal, companyName, constraints, size, signal }) {
  const fallback = buildBlueprint(goal, { companyName, size });
  if (!nim || !role?.model) return { org: normalizeOrg(fallback, { goal, companyName, fallback }), source: "blueprint", usage: null };
  try {
    const response = await nim.chat({
      model: role.model,
      temperature: 0.35,
      maxTokens: 2600,
      intent: "org",
      signal,
      messages: [
        { role: "system", content: ORG_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Company name: ${companyName || "a new company"}`,
            `Company goal: ${goal}`,
            constraints ? `Constraints: ${constraints}` : "",
            size ? `Target team size: ${size}` : "",
            "Design the company now and return the JSON.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    });
    const parsed = extractJson(response.content);
    if (!parsed || !Array.isArray(parsed.agents) || !parsed.agents.length) {
      return { org: normalizeOrg(fallback, { goal, companyName, fallback }), source: "blueprint", usage: response.usage, raw: response.content };
    }
    return { org: normalizeOrg(parsed, { goal, companyName, fallback }), source: "model", usage: response.usage };
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { org: normalizeOrg(fallback, { goal, companyName, fallback }), source: "blueprint", usage: null, error: error?.message };
  }
}
