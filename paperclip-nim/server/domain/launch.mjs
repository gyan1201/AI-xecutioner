/**
 * Full-auto launch: turn two sentences into a staffed company.
 *
 * The user supplies a company name, a goal, and (optionally) model keys. This
 * module answers the question they never answer explicitly — *what kind of
 * company is this?* — and returns a plan the service can deploy in one shot:
 * a goal, a team with roles and models, and a backlog with acceptance criteria.
 *
 * Two planners:
 *   • `planForGoal` — deterministic. Ranks the 36 NVIDIA blueprints against the
 *     goal (see rankBlueprints) and rewrites the winner around the goal. Always
 *     available, always fast, and the reason a launch works with no key at all.
 *   • `planWithModel` — optional. When a live model is configured, the
 *     strategist is asked to design the org itself; the draft is validated hard
 *     and silently discarded if it is malformed, falling back to the blueprint.
 */

import { DEFAULT_BLUEPRINT_ID, getBlueprint, planBlueprint, rankBlueprints } from "../nim/blueprints.mjs";
import { suggestSkillsForRole } from "../nim/skills.mjs";

const ROLES = ["strategist", "operator", "analyst", "critic"];
const PRIORITIES = ["urgent", "high", "medium", "low"];

const clip = (text, max) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}…`;
};

/** The headline of a goal: its first sentence, short enough for a goal title. */
export function goalTitle(goal) {
  const first = String(goal ?? "").trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  return clip(first || goal, 132) || "Ship the first measurable win";
}

/* ------------------------------------------------------------- metrics */

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, half: 0.5,
};

const UNITS = [
  { test: /^(ms|msec|milliseconds?)$/, label: "ms", seconds: 0.001 },
  { test: /^(s|sec|secs|seconds?)$/, label: "sec", seconds: 1 },
  { test: /^(m|min|mins|minutes?)$/, label: "min", seconds: 60 },
  { test: /^(h|hr|hrs|hours?)$/, label: "h", seconds: 3600 },
  { test: /^(d|day|days?)$/, label: "d", seconds: 86_400 },
  { test: /^(w|wk|wks|weeks?)$/, label: "wk", seconds: 604_800 },
  { test: /^(mo|mos|months?)$/, label: "mo", seconds: 2_592_000 },
  { test: /^(%|pct|percent)$/, label: "%", seconds: null },
];

const unitFor = (token) => UNITS.find((unit) => unit.test.test(String(token ?? "").toLowerCase())) ?? null;

function numbersIn(text) {
  return String(text)
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|half)\b/gi,
      (word) => String(NUMBER_WORDS[word.toLowerCase()]))
    .replace(/\ba couple of\b/gi, "2");
}

const METRIC_STOP = new Set([
  "cut", "reduce", "lower", "bring", "get", "ship", "make", "drive", "take", "move", "improve", "increase", "decrease",
  "slash", "halve", "help", "keep", "keeping", "while", "so", "that", "which", "instead", "from", "to", "under", "below",
  "less", "than", "within", "in", "by", "per", "of", "for", "with", "and", "or", "a", "an", "the", "our", "their", "its",
  "at", "on", "into", "down", "up", "we", "us", "is", "are", "be", "can", "should", "must",
]);

/** The noun phrase immediately before the first number: "support response time". */
function metricName(text) {
  const words = numbersIn(String(text ?? "")).toLowerCase().replace(/[^a-z0-9%.\s]/g, " ").split(/\s+/).filter(Boolean);
  const index = words.findIndex((word) => /^\d/.test(word) || unitFor(word));
  if (index < 0) return "";
  const before = words
    .slice(Math.max(0, index - 5), index)
    .filter((word) => !METRIC_STOP.has(word) && !unitFor(word) && !/^\d/.test(word) && word.length > 1);
  return before.slice(-3).join(" ");
}

/**
 * Read a measurable goal out of the sentence a user typed.
 *
 * "Cut support response time to under five minutes" has no baseline, and
 * "from 6 weeks to 5 days" mixes units — both are common, and both are the
 * difference between a real metric and "accepted deliverables".
 */
export function deriveGoal(goalText) {
  const raw = String(goalText ?? "").trim();
  if (!raw) return null;
  const text = numbersIn(raw.toLowerCase().replace(/\s+/g, " "));
  const metric = metricName(raw);

  const pair = text.match(/from\s+(\d+(?:\.\d+)?)\s*([a-z%]+)?\s*(?:to|down to|into)\s*(?:under\s+|below\s+|less than\s+)?(\d+(?:\.\d+)?)\s*([a-z%]+)?/);
  const reversed = pair ? null : text.match(/(\d+(?:\.\d+)?)\s*([a-z%]+)\s+instead of\s+(\d+(?:\.\d+)?)\s*([a-z%]+)/);
  const percent = text.match(/(?:by|cut by|reduce by|lower by)\s+(\d+(?:\.\d+)?)\s*(?:%|percent|pct)/);
  const single = text.match(/(?:to|under|below|less than|within|in under|inside|at)\s+(\d+(?:\.\d+)?)\s*([a-z%]+)/);

  const finish = (values) => ({
    metric: metric || "time to result",
    ...values,
    note: values.baseline === null
      ? "target read from the goal sentence; the baseline is measured by the first issue"
      : "baseline and target read from the goal sentence",
  });

  if (pair || reversed) {
    const match = pair ?? reversed;
    const targetToken = pair ? { value: match[3], unit: match[4] ?? match[2] } : { value: match[1], unit: match[2] };
    const baselineToken = pair ? { value: match[1], unit: match[2] } : { value: match[3], unit: match[4] };
    const targetUnit = unitFor(targetToken.unit) ?? unitFor(baselineToken.unit);
    const baselineUnit = unitFor(baselineToken.unit) ?? targetUnit;
    const target = Number(targetToken.value);
    let baseline = Number(baselineToken.value);
    if (!targetUnit || !Number.isFinite(target) || target <= 0 || !Number.isFinite(baseline)) return null;
    if (targetUnit.seconds && baselineUnit?.seconds && targetUnit.label !== baselineUnit.label) {
      baseline = (baseline * baselineUnit.seconds) / targetUnit.seconds;
    }
    baseline = Math.round(baseline * 100) / 100;
    return finish({ unit: targetUnit.label, baseline, target, direction: target <= baseline ? "decrease" : "increase" });
  }

  // A percentage reduction wins when it is stated before any other target.
  if (percent && (!single || percent.index < single.index)) {
    const drop = Number(percent[1]);
    if (!Number.isFinite(drop) || drop <= 0 || drop >= 100) return null;
    return finish({ unit: "%", baseline: 100, target: Math.round((100 - drop) * 100) / 100, direction: "decrease" });
  }

  if (single) {
    const unit = unitFor(single[2]);
    const target = Number(single[1]);
    if (!unit || !Number.isFinite(target) || target <= 0) return null;
    return finish({ unit: unit.label, baseline: null, target, direction: unit.seconds ? "decrease" : "increase" });
  }

  return null;
}

export function issuePrefixFor(name) {
  const prefix = String(name ?? "")
    .split(/\s+/)
    .map((word) => word[0])
    .join("")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase()
    .slice(0, 3);
  return prefix || "CO";
}

/** Which blueprint fits this goal, with the runners-up as an explanation. */
export function matchBlueprint(goal) {
  const ranked = rankBlueprints(goal, { limit: 4 });
  const top = ranked[0];
  const hasSignal = Boolean(top && top.score > 0);
  const chosen = hasSignal ? top : { ...ranked[0], id: DEFAULT_BLUEPRINT_ID, score: 0 };
  return {
    blueprintId: chosen.id,
    score: chosen.score,
    reason: hasSignal ? "matched" : "default",
    matched: chosen.matched ?? [],
    alternatives: ranked.filter((entry) => entry.id !== chosen.id).slice(0, 3),
  };
}

/* People, not placeholders: several blueprints ship with "Blueprint Lead" and
 * "Builder", which reads like a template. A launched company gets real names —
 * deterministic per blueprint, so the same goal always yields the same team. */
const GENERIC_NAMES = new Set(["Blueprint Lead", "Builder", "Reviewer", "Agent", "Specialist", "Lead"]);
const NAME_POOL = [
  "Amara Okafor", "Diego Marín", "Sana Kapoor", "Noah Bergström", "Leila Haddad", "Mateo Rossi",
  "Yuki Tanaka", "Nadia Petrov", "Idris Bello", "Clara Fontaine", "Rafael Souza", "Mei Lin",
  "Oskar Lindqvist", "Aisha Rahman", "Tomás Herrera", "Priya Nair", "Elias Weber", "Zara Ahmed",
  "Hugo Almeida", "Ingrid Solberg", "Kofi Mensah", "Sofia Marino", "Arjun Mehta", "Elena Petrova",
  "Malik Johnson", "Hana Ito", "Lucas Ferreira", "Anika Sharma", "Omar Farouk", "Freya Nilsson",
  "Chen Wei", "Isabel Duarte", "Samir Khoury", "Nora Lindberg", "Júlia Costa", "Daniel Kim",
  "Rosa Delgado", "Viktor Novak", "Amina Diallo", "Jack Whitfield", "Sara Højgaard", "Ravi Iyer",
];

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return Math.abs(value);
}

function realName(blueprintId, index, taken) {
  const offset = hash(`${blueprintId}:${index}`);
  for (let attempt = 0; attempt < NAME_POOL.length; attempt += 1) {
    const candidate = NAME_POOL[(offset + attempt * 7) % NAME_POOL.length];
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  return NAME_POOL[offset % NAME_POOL.length];
}

/**
 * A complete plan for one blueprint, written around a company's own goal.
 *
 * Used by two callers, which is why it takes a blueprint rather than an id:
 * the full-auto launcher (goal → ranked blueprint → plan) and
 * `service.deployBlueprint` (a specific blueprint → plan), so deploying a
 * blueprint by hand produces the same real names, skills and goal-grounded
 * backlog as a launch instead of template placeholders.
 */
export function planFromBlueprint(blueprint, { companyName = "", goal = "", issuePrefix = "CO" } = {}) {
  if (!blueprint) {
    const error = new Error("Unknown blueprint");
    error.status = 404;
    error.code = "unknown_blueprint";
    throw error;
  }
  const plan = planBlueprint(blueprint.id, { issuePrefix });
  const brief = String(goal ?? "").trim();
  const title = brief ? goalTitle(brief) : plan.goal.title;
  const context = brief || blueprint.summary;
  const functions = (blueprint.functions ?? []).join(", ");

  // Team: keep the blueprint's roles/models, replace template names, and give
  // every agent two NVIDIA skills chosen for *its own* job — otherwise the whole
  // roster arrives carrying the same generic pair and reads like a template.
  const taken = new Set();
  const usedSkills = new Set();
  const domain = `${blueprint.name} ${blueprint.category} ${functions}`;
  const skillText = `${blueprint.summary} ${brief}`;
  const agents = plan.agents.map((agent, index) => {
    const named = GENERIC_NAMES.has(agent.name) ? realName(blueprint.id, index, taken) : agent.name;
    taken.add(named);
    return {
      ...agent,
      name: named,
      description: `${agent.title} at ${companyName || "this company"}.`,
      skills: suggestSkillsForRole({ title: agent.title, role: agent.role, domain, text: skillText, used: usedSkills, limit: 2 }),
      instructions: [
        agent.instructions,
        `Company goal: ${clip(context, 400)}`,
        "Every deliverable must move that goal, cite its evidence, and define how it is checked. If a request does not move the goal, say so and stop.",
      ].join("\n\n"),
    };
  });

  const strategist = agents.find((agent) => agent.role === "strategist") ?? agents[0];
  const operator = agents.find((agent) => agent.role === "operator") ?? agents[1] ?? agents[0];
  const critic = agents.find((agent) => agent.role === "critic") ?? agents[agents.length - 1];
  const indexOf = (agent) => Math.max(agents.indexOf(agent), 0);
  const goalLine = clip(context, 400);
  const goalPlan = buildGoal(plan.goal, { title, context, source: brief });
  const labels = [blueprint.category.toLowerCase().replace(/[^a-z0-9]+/g, "-"), "full-auto"];

  // Backlog: the decisions only the goal can settle, then the blueprint's own
  // concrete steps, then a review gate that defines done.
  const composed = [
    {
      title: `Lock the baseline for ${clip(goalPlan.metric || blueprint.name, 60)}`,
      priority: "urgent",
      description: `This team exists to ${goalLine ? `achieve this: ${goalLine}` : `deliver ${blueprint.name}`}. The target is ${goalPlan.metric} ${goalPlan.baseline === null || goalPlan.baseline === undefined ? "measured from today" : goalPlan.baseline} → ${goalPlan.target}${goalPlan.unit ? ` ${goalPlan.unit}` : ""}. Write down today's value with its source and how often it is measured.`,
      acceptance: ["Metric named with an exact definition", "Baseline value with a source and a date", "Owner and measurement cadence agreed"],
      labels: ["foundation", ...labels],
      ownerIndex: indexOf(strategist),
      source: "blueprint",
    },
    ...plan.issues
      // "scope and success metric" is the issue composed above.
      .filter((issue) => !/scope and success metric/i.test(issue.title))
      .slice(0, 5)
      .map((issue, index) => ({
        ...issue,
        title: clip(issue.title, 140),
        priority: issue.priority ?? (index === 0 ? "high" : "medium"),
        description: `${issue.description}\n\nGoal this serves: ${goalLine}`,
        labels: [...(issue.labels ?? []).slice(0, 2), ...labels],
        ownerIndex: issue.ownerIndex ?? indexOf(operator),
        source: issue.source ?? "blueprint",
      })),
    {
      title: `Wire the ${clip(functions || "NIM", 60)} calls behind one client`,
      priority: "high",
      description: `Stand up one OpenAI-compatible client for the ${blueprint.name} stack and prove each endpoint family works: ${functions || "chat"}. Record latency and cost per call so the ledger is real from the first run.`,
      acceptance: ["Model chosen per task with a written reason", "One smoke call per endpoint, logged with cost", "Failure path returns a usable error, not a silent retry"],
      labels: ["nim", ...labels],
      ownerIndex: indexOf(operator),
      source: "blueprint",
    },
    {
      title: `Ship the first end-to-end slice and review it`,
      priority: "high",
      description: `Run one real input through the ${blueprint.name} pipeline, capture the output, its cost and its latency, then have ${critic.name} accept or reject it against the acceptance criteria above. Accepted is the only definition of done.`,
      acceptance: ["One real input → output shown in the issue", "Cost and latency recorded on the run", "Reviewer verdict linked, with the next action named"],
      labels: ["delivery", ...labels],
      ownerIndex: indexOf(critic),
      source: "blueprint",
    },
  ];

  return {
    blueprint: {
      id: blueprint.id,
      name: blueprint.name,
      summary: blueprint.summary,
      category: blueprint.category,
      functions: blueprint.functions,
    },
    goal: goalPlan,
    agents,
    issues: composed,
  };
}


/**
 * A blueprint with a curated metric keeps it (the healthcare blueprints know
 * their own units). Everything else reads the metric out of the goal sentence,
 * and only falls back to the placeholder when the sentence has no number in it.
 */
export function buildGoal(blueprintGoal, { title, context, source }) {
  const derived = deriveGoal(source ?? context);
  // The number the user typed wins: it is the only target the company is
  // actually accountable to. A blueprint's curated metric is the fallback for
  // goals with no number in them, and the placeholder is the last resort.
  if (derived) {
    const unit = derived.unit ?? blueprintGoal?.unit ?? null;
    const direction =
      derived.direction ??
      (blueprintGoal?.unit === unit ? blueprintGoal?.direction : undefined) ??
      null;
    return { ...derived, unit, direction, title, description: context };
  }
  const curated = blueprintGoal?.metric && blueprintGoal.metric !== "accepted deliverables";
  if (curated) return { ...blueprintGoal, title, description: context };
  return {
    ...blueprintGoal,
    title,
    description: context,
    metric: blueprintGoal?.metric || "accepted deliverables",
  };
}

/** Goal → ranked blueprint → plan. The full-auto entry point. */
export function planForGoal({ name, goal, blueprintId = null } = {}) {
  const companyName = clip(name, 80) || "New company";
  const brief = String(goal ?? "").trim();
  const match = blueprintId
    ? {
        blueprintId,
        score: null,
        reason: "selected",
        matched: [],
        alternatives: rankBlueprints(brief, { limit: 3 }),
      }
    : matchBlueprint(brief);

  const blueprint = getBlueprint(match.blueprintId);
  if (!blueprint) {
    const error = new Error(`Unknown blueprint: ${match.blueprintId}`);
    error.status = 404;
    error.code = "unknown_blueprint";
    throw error;
  }

  return {
    ...planFromBlueprint(blueprint, { companyName, goal: brief, issuePrefix: issuePrefixFor(companyName) }),
    source: blueprintId ? "selected" : match.reason === "matched" ? "matched" : "default",
    match,
  };
}

/* ------------------------------------------------------------ model drafts */

const DRAFT_SYSTEM = `You design small, effective AI companies.
Return ONLY a JSON object, no prose, no markdown fences, with this shape:
{
  "mission": "one sentence",
  "goal": { "title": "measurable goal", "metric": "unit of progress", "target": 5, "baseline": 0 },
  "team": [
    { "name": "Full Name", "title": "Role title", "role": "strategist|operator|analyst|critic",
      "model": "one of the allowed model ids", "instructions": "how this agent works, 1-3 sentences" }
  ],
  "issues": [
    { "title": "concrete deliverable", "priority": "urgent|high|medium|low",
      "description": "what to produce and why", "acceptance": ["check 1", "check 2"],
      "owner": 0 }
  ]
}
Rules: 3-5 team members, exactly one strategist, 4-6 issues, each issue's "owner" is an index into team,
every issue has at least two acceptance checks, and every model id must come from the allowed list.`;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * Validate a model-authored draft. Anything missing, malformed or hallucinated
 * is repaired from the deterministic plan; if the shape is unusable, return null
 * and the caller keeps the blueprint plan.
 */
export function normalizeDraft(raw, fallback, { models = [] } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const allowed = new Set(models.filter(Boolean));
  const fallbackModels = fallback.agents.map((agent) => agent.model).filter(Boolean);
  const modelFor = (value, index) => {
    if (typeof value === "string" && value.trim() && (!allowed.size || allowed.has(value.trim()))) return value.trim();
    return fallbackModels[index % Math.max(fallbackModels.length, 1)] ?? null;
  };

  const team = asArray(raw.team)
    .slice(0, 6)
    .map((member, index) => {
      if (!member || typeof member !== "object") return null;
      const name = clip(member.name, 60);
      const title = clip(member.title, 60);
      const role = ROLES.includes(String(member.role ?? "").toLowerCase()) ? String(member.role).toLowerCase() : index === 0 ? "strategist" : "operator";
      if (!name || !title) return null;
      return {
        name,
        title,
        role,
        model: modelFor(member.model, index),
        monthlyBudgetCents: 0,
        description: clip(member.description ?? `${title}.`, 220),
        capabilities: asArray(member.capabilities).filter((entry) => typeof entry === "string").slice(0, 6),
        instructions: clip(member.instructions, 1200) || fallback.agents[index % fallback.agents.length]?.instructions || "Do the work on the board and show your evidence.",
      };
    })
    .filter(Boolean);

  if (team.length < 2) return null;
  if (!team.some((member) => member.role === "strategist")) team[0].role = "strategist";

  const issues = asArray(raw.issues)
    .slice(0, 8)
    .map((issue, index) => {
      if (!issue || typeof issue !== "object") return null;
      const title = clip(issue.title, 140);
      if (!title) return null;
      const owner = Number.isInteger(issue.owner) && team[issue.owner] ? issue.owner : index % team.length;
      const acceptance = asArray(issue.acceptance)
        .map((entry) => clip(entry, 160))
        .filter(Boolean)
        .slice(0, 5);
      return {
        title,
        priority: PRIORITIES.includes(String(issue.priority ?? "").toLowerCase()) ? String(issue.priority).toLowerCase() : index === 0 ? "urgent" : "medium",
        description: clip(issue.description, 1200) || fallback.issues[index % fallback.issues.length]?.description || title,
        labels: asArray(issue.labels).filter((entry) => typeof entry === "string").slice(0, 3),
        acceptance: acceptance.length >= 2 ? acceptance : ["Deliverable linked in the issue", "Reviewed and accepted by the quality lead"],
        source: "full-auto",
        ownerIndex: owner,
      };
    })
    .filter(Boolean);

  if (issues.length < 3) return null;

  const goal = raw.goal && typeof raw.goal === "object" ? raw.goal : {};
  const target = Number(goal.target);
  return {
    source: "model",
    blueprint: fallback.blueprint,
    match: fallback.match,
    mission: clip(raw.mission, 600) || undefined,
    goal: {
      ...fallback.goal,
      title: clip(goal.title, 132) || fallback.goal.title,
      description: clip(raw.mission, 1200) || fallback.goal.description,
      metric: clip(goal.metric, 80) || fallback.goal.metric,
      target: Number.isFinite(target) && target > 0 ? target : fallback.goal.target,
      baseline: Number.isFinite(Number(goal.baseline)) ? Number(goal.baseline) : fallback.goal.baseline,
      unit: clip(goal.unit, 24) || fallback.goal.unit,
    },
    agents: team,
    issues,
  };
}

/** The strategist's briefing message for a full-auto draft. */
export function draftMessages({ name, goal, blueprint }) {
  return [
    { role: "system", content: DRAFT_SYSTEM },
    {
      role: "user",
      content: [
        `Company name: ${name}`,
        `Company goal: ${goal}`,
        blueprint
          ? `A close NVIDIA blueprint for reference (do not copy its demo names): ${blueprint.name} — ${blueprint.summary}`
          : "",
        "Design the smallest team that can actually hit this goal, and a backlog that starts delivering this week.",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ];
}
