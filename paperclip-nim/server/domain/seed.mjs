/**
 * Demo company.
 *
 * A believable mid-stage startup with a staffed org, a real backlog, a spend
 * history and one thing blocked on a human — so every Paperclip surface has
 * something true to show on first boot. Deterministic: same company every time.
 */

import { estimateCost } from "../nim/catalog.mjs";
import { loadSkills } from "../nim/skills.mjs";
import { newId, nowIso } from "../store.mjs";
import {
  createAgent,
  createApproval,
  createComment,
  createGoal,
  createIssue,
  createKnowledge,
  createProject,
  createRoutine,
  recomputeCompany,
} from "./model.mjs";

const DAY = 86_400_000;
const at = (daysAgo, hour = 10, minute = 0) => {
  const date = new Date(Date.now() - daysAgo * DAY);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
};

function skillIds(patterns, limit = 3) {
  const skills = loadSkills().skills;
  const picked = [];
  for (const pattern of patterns) {
    const match = skills.find((skill) => pattern.test(skill.id) && !picked.includes(skill.id));
    if (match) picked.push(match.id);
    if (picked.length >= limit) break;
  }
  return picked;
}

const SKILLS = {
  rag: () => skillIds([/nvidia-rag|rag-blueprint|rag-perf/, /retriev/, /embed/], 3),
  agent: () => skillIds([/nemotron/, /agent/, /nemo-guardrails|guardrail/], 3),
  data: () => skillIds([/cudf/, /rapids|dali/, /cuopt/], 3),
  vision: () => skillIds([/deepstream/, /vision|vlm/, /cosmos/], 3),
  safety: () => skillIds([/guardrail|safety/, /nemoguard|garak/], 2),
  code: () => skillIds([/coding|developer/, /cuda/, /nim/], 3),
  ops: () => skillIds([/kubernetes|deploy/, /observab|telemetry/, /nim/], 3),
};

export function buildSeedCompany() {
  const created = at(64, 9);
  const company = {
    id: "co_northwind",
    name: "Northwind Labs",
    slug: "northwind-labs",
    mission:
      "Make the fastest self-serve onboarding in analytics — a new team should see their first real insight in under ten minutes.",
    issuePrefix: "NW",
    nextIssueNumber: 124,
    createdAt: created,
    updatedAt: nowIso(),
    settings: {
      approvalPolicy: "high",
      autoMode: false,
      cycleMinutes: 60,
      maxCycles: 3,
      reworkLimit: 1,
      monthlyBudgetCents: 2_400,
      guardrails: { safetyCheck: true, blockUnsafe: true, redactSecrets: true },
      defaultModels: {
        strategist: "nvidia/nemotron-3-ultra-550b-a55b",
        operator: "nvidia/nemotron-3-super-120b-a12b",
        analyst: "nvidia/nemotron-nano-3-30b-a3b",
        critic: "nvidia/nemotron-3-super-120b-a12b",
        embedding: "nvidia/nemotron-3.5-embed-8b",
        rerank: "nvidia/nv-rerankqa-mistral-4b-v3",
        image: "google/diffusiongemma-26b-a4b-it",
        safety: "nvidia/nemotron-3.5-content-safety",
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
    stats: {},
  };

  const ada = createAgent({
    id: "agt_ada",
    name: "Ada Chen",
    role: "strategist",
    title: "Chief Executive",
    description: "Sets the cycle focus, owns the goal, and refuses to add scope until the metric moves.",
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    fallbackModel: "nvidia/nemotron-3-super-120b-a12b",
    temperature: 0.35,
    monthlyBudgetCents: 300,
    reportsTo: null,
    accent: "#76b900",
    capabilities: ["reasoning", "chat", "tools"],
    skills: SKILLS.agent(),
    instructions:
      "You are the CEO of Northwind Labs. You turn goals into a ranked, dependency-aware plan. Be specific about what changes this cycle, what it costs, and how it will be measured. Never assign work without a definition of done.",
    createdAt: at(64, 9),
  });
  const priya = createAgent({
    id: "agt_priya",
    name: "Priya Raman",
    role: "operator",
    title: "Head of Product",
    description: "Owns activation. Ships the smallest version that can produce a real number.",
    model: "nvidia/nemotron-3-super-120b-a12b",
    temperature: 0.45,
    monthlyBudgetCents: 240,
    reportsTo: ada.id,
    accent: "#4ec9b0",
    capabilities: ["chat", "tools", "vision"],
    skills: SKILLS.rag(),
    instructions:
      "You are Head of Product. Every deliverable must include the change, the metric it moves, and the rollback path. Prefer two-week tests over roadmaps.",
    createdAt: at(62, 11),
  });
  const marcus = createAgent({
    id: "agt_marcus",
    name: "Marcus Webb",
    role: "operator",
    title: "Chief Technology Officer",
    description: "Builds the platform and keeps the p95 honest.",
    model: "nvidia/nemotron-3-super-120b-a12b",
    temperature: 0.4,
    monthlyBudgetCents: 260,
    reportsTo: ada.id,
    accent: "#6995ff",
    capabilities: ["chat", "tools", "code"],
    skills: SKILLS.code(),
    instructions:
      "You are the CTO. Produce designs an on-call engineer can run at 3am: explicit rollback, explicit failure modes, no hand-waving about scale.",
    createdAt: at(61, 10),
  });
  const sofia = createAgent({
    id: "agt_sofia",
    name: "Sofia Almeida",
    role: "analyst",
    title: "Research Lead",
    description: "Turns interviews and market data into decisions with citations.",
    model: "nvidia/nemotron-nano-3-30b-a3b",
    temperature: 0.5,
    monthlyBudgetCents: 180,
    reportsTo: ada.id,
    accent: "#e3b341",
    capabilities: ["chat", "embedding", "rerank", "vision"],
    skills: SKILLS.agent(),
    instructions:
      "You are the research lead. Ground every claim in the knowledge base with a citation. If the evidence is thin, say so and propose the cheapest experiment that would settle it.",
    createdAt: at(58, 14),
  });
  const dev = createAgent({
    id: "agt_dev",
    name: "Dev Patel",
    role: "operator",
    title: "Platform Engineer",
    description: "Instruments the funnel and keeps the event pipeline trustworthy.",
    model: "mistralai/codestral-22b-instruct-v0.1",
    temperature: 0.3,
    monthlyBudgetCents: 160,
    reportsTo: marcus.id,
    accent: "#c678dd",
    capabilities: ["code", "chat", "tools"],
    skills: SKILLS.data(),
    instructions:
      "You are a platform engineer. Write code, SQL and runbooks. Show the diff, the test, and the blast radius. Do not invent dashboards that do not exist.",
    createdAt: at(57, 16),
  });
  const lena = createAgent({
    id: "agt_lena",
    name: "Lena Fischer",
    role: "critic",
    title: "Quality Lead",
    description: "Accepts work or sends it back with the exact fix. Never rewrites it herself.",
    model: "nvidia/nemotron-3-super-120b-a12b",
    temperature: 0.2,
    monthlyBudgetCents: 140,
    reportsTo: ada.id,
    accent: "#ff7b72",
    capabilities: ["reasoning", "chat", "vision"],
    skills: SKILLS.safety(),
    instructions:
      "You are the quality lead. Judge against the acceptance criteria only. Reply with JSON: verdict, score 0-100, findings with severity and fix, follow_ups. Be hard to impress and specific.",
    createdAt: at(55, 12),
  });
  const noah = createAgent({
    id: "agt_noah",
    name: "Noah Kim",
    role: "operator",
    title: "Growth Marketer",
    description: "Runs the pricing page, the lifecycle emails and the launch narrative.",
    model: "mistralai/mistral-large-2-instruct",
    temperature: 0.6,
    monthlyBudgetCents: 180,
    reportsTo: ada.id,
    accent: "#ffa657",
    capabilities: ["chat", "image", "safety"],
    skills: SKILLS.vision(),
    instructions:
      "You are a growth marketer. Write copy a busy operator would read twice. Every campaign needs one metric and one kill criterion. Never promise a feature that is not shipped.",
    createdAt: at(50, 9),
  });
  const aria = createAgent({
    id: "agt_aria",
    name: "Aria Singh",
    role: "operator",
    title: "Ops Scribe",
    description: "Keeps the board honest: standups, decisions, and the trail behind them.",
    model: "nvidia/nemotron-3.5-lightning-30b-a3b",
    temperature: 0.4,
    monthlyBudgetCents: 90,
    reportsTo: ada.id,
    accent: "#8b949e",
    capabilities: ["chat"],
    skills: SKILLS.ops(),
    instructions:
      "You are the ops scribe. Summarise cycles in plain language: what shipped, what is blocked, what it cost, who owns the next step. No adjectives you cannot defend.",
    createdAt: at(49, 10),
  });

  company.agents = [ada, priya, marcus, sofia, dev, lena, noah, aria];

  company.goals = [
    createGoal({
      id: "goal_mrr",
      title: "Reach $20k MRR in 90 days",
      description: "Self-serve only. No new headcount, no enterprise sales motion before the activation fix ships.",
      metric: "MRR",
      unit: "USD",
      baseline: 8200,
      current: 12_400,
      target: 20_000,
      ownerId: ada.id,
      dueAt: at(-26, 17),
      status: "active",
    }),
    createGoal({
      id: "goal_ttfv",
      title: "Time-to-first-value under 10 minutes",
      description: "Measured from signup to the first saved insight, p50 across new workspaces.",
      metric: "median minutes",
      unit: "min",
      baseline: 24,
      current: 17,
      target: 10,
      ownerId: priya.id,
      dueAt: at(-40, 17),
      status: "active",
    }),
    createGoal({
      id: "goal_sso",
      title: "Ship enterprise SSO",
      description: "SAML + SCIM behind a flag. Two design partners must pass the checklist before GA.",
      metric: "checklist %",
      unit: "%",
      baseline: 0,
      current: 45,
      target: 100,
      ownerId: marcus.id,
      dueAt: at(-55, 17),
      status: "active",
    }),
  ];

  company.projects = [
    createProject({ id: "proj_activation", name: "Activation", description: "Signup → first insight in under ten minutes.", color: "#76b900", createdAt: at(60, 9) }),
    createProject({ id: "proj_pricing", name: "Pricing & Packaging", description: "Usage-based pricing that survives the margin test.", color: "#6995ff", createdAt: at(54, 9) }),
    createProject({ id: "proj_platform", name: "Data Platform", description: "Event pipeline, warehouse models, p95 latency.", color: "#4ec9b0", createdAt: at(48, 9) }),
    createProject({ id: "proj_growth", name: "Website & Content", description: "The public face: pricing page, docs, launch.", color: "#ffa657", createdAt: at(40, 9) }),
  ];

  const issueSpecs = [
    {
      title: "Instrument the signup funnel end to end",
      status: "in_review",
      priority: "urgent",
      assigneeId: dev.id,
      projectId: "proj_activation",
      goalId: "goal_ttfv",
      description:
        "We cannot shorten a funnel we cannot see. Add events for workspace_created, source_connected, first_query, first_saved_insight. One schema, one owner, no client-side gaps.",
      acceptance: ["All four events visible in the warehouse within 60s", "Schema documented in knowledge/activation-metrics.md", "Backfill covers the last 14 days"],
      labels: ["instrumentation", "activation"],
      createdAt: at(9, 11),
    },
    {
      title: "Write the lifecycle email sequence for week one",
      status: "in_progress",
      priority: "high",
      assigneeId: noah.id,
      projectId: "proj_growth",
      goalId: "goal_ttfv",
      description:
        "Three emails, one job each: connect a source, run the first query, save an insight. Copy must survive a skeptical operator reading it on a phone.",
      acceptance: ["Three emails with subject, preview, body", "One metric and one kill criterion", "No feature claims that are not live"],
      labels: ["content", "activation"],
      createdAt: at(7, 15),
    },
    {
      title: "Cut cold-start query time from 24s to under 8s",
      status: "in_progress",
      priority: "urgent",
      assigneeId: marcus.id,
      projectId: "proj_platform",
      goalId: "goal_ttfv",
      description:
        "First query after connecting a source is dominated by cache warmup. Profile it, fix the worst contributor, and show the p50/p95 before and after.",
      acceptance: ["p50 under 8s on a cold workspace", "Before/after numbers with a source", "Rollback path documented"],
      labels: ["performance", "infra"],
      createdAt: at(6, 9),
    },
    {
      title: "Pricing page experiment: usage tiers vs seats",
      status: "todo",
      priority: "high",
      assigneeId: noah.id,
      projectId: "proj_pricing",
      goalId: "goal_mrr",
      description:
        "Two variants, 50 accounts each. The question is not which page converts better this week — it is which model produces better expansion at month three.",
      acceptance: ["Experiment definition with hypothesis", "Variant copy for both models", "Decision rule written before launch"],
      labels: ["experiment", "pricing"],
      createdAt: at(5, 13),
    },
    {
      title: "Answer: why do trials stall on day 3?",
      status: "todo",
      priority: "high",
      assigneeId: sofia.id,
      projectId: "proj_activation",
      goalId: "goal_ttfv",
      description:
        "Sixteen interviews, three dashboards and one guess. Find the actual drop-off moment, cite what we know, and name the cheapest experiment that would confirm it.",
      acceptance: ["At least 3 cited sources", "A single named failure mode", "Cheapest confirming experiment"],
      labels: ["research", "activation"],
      createdAt: at(4, 10),
    },
    {
      title: "Publish the incident postmortem for the 2026-09 outage",
      status: "blocked",
      priority: "medium",
      assigneeId: aria.id,
      projectId: "proj_platform",
      description:
        "Customers already have the summary email. The public postmortem needs legal sign-off before it goes on the status page.",
      acceptance: ["Timeline with UTC timestamps", "Customer impact quantified", "Two prevention actions with owners"],
      labels: ["public", "incident"],
      blockedReason: "Waiting on legal review of the customer-impact paragraph.",
      createdAt: at(12, 8),
    },
    {
      title: "SAML metadata exchange with design partner Acme",
      status: "todo",
      priority: "medium",
      assigneeId: marcus.id,
      projectId: "proj_platform",
      goalId: "goal_sso",
      description: "Get Acme through the SAML checklist, document every stumble, and fix the worst two before the second partner starts.",
      acceptance: ["Acme login succeeds end to end", "Stumble list captured", "Two fixes merged"],
      labels: ["sso", "enterprise"],
      createdAt: at(11, 14),
    },
    {
      title: "Warehouse cost review: kill the three worst queries",
      status: "backlog",
      priority: "low",
      assigneeId: dev.id,
      projectId: "proj_platform",
      description: "Margin is fine until a customer runs a dashboard refresh every minute. Find the three most expensive query shapes and cap them.",
      acceptance: ["Top three shapes named with cost", "A cap or cache for each", "No visible regression for normal use"],
      labels: ["cost", "infra"],
      createdAt: at(10, 16),
    },
    {
      title: "Launch checklist for the self-serve GA",
      status: "backlog",
      priority: "medium",
      assigneeId: aria.id,
      projectId: "proj_pricing",
      goalId: "goal_mrr",
      description: "One page, every dependency, one owner per line. If it is not on the checklist it does not ship.",
      acceptance: ["Owner per line", "Go/no-go call date", "Rollback and comms plan"],
      labels: ["launch", "process"],
      createdAt: at(8, 12),
    },
    {
      title: "Turn interview notes into a searchable knowledge base",
      status: "done",
      priority: "medium",
      assigneeId: sofia.id,
      projectId: "proj_activation",
      description: "Index the 16 interviews so every future question can be answered from evidence instead of memory.",
      acceptance: ["Interview corpus indexed", "Retrieval returns the right quote", "Sources cited in answers"],
      labels: ["knowledge", "rag"],
      createdAt: at(16, 10),
      completedAt: at(3, 16),
    },
    {
      title: "Daily standup routine with per-agent spend",
      status: "done",
      priority: "low",
      assigneeId: aria.id,
      projectId: "proj_activation",
      description: "A short standup every morning that names what shipped, what is blocked and what it cost.",
      acceptance: ["Runs every morning", "Names the blocked item", "Spend shown per agent"],
      labels: ["process", "routine"],
      createdAt: at(15, 9),
      completedAt: at(5, 9),
    },
    {
      title: "Fix the empty state on the sources page",
      status: "done",
      priority: "high",
      assigneeId: priya.id,
      projectId: "proj_activation",
      goalId: "goal_ttfv",
      description: "New workspaces land on a blank page with no next action. Give them one obvious button and a reason to press it.",
      acceptance: ["One primary action", "Copy explains the value", "Tracked as an event"],
      labels: ["ux", "activation"],
      createdAt: at(14, 11),
      completedAt: at(2, 15),
    },
    {
      title: "Usage-based pricing model, v1",
      status: "done",
      priority: "medium",
      assigneeId: noah.id,
      projectId: "proj_pricing",
      goalId: "goal_mrr",
      description: "Model the unit economics at 10/100/1000 seats and pick a structure we can defend to the board.",
      acceptance: ["Margin at each tier", "Comparison to two competitors", "Recommendation with a risk"],
      labels: ["pricing", "analysis"],
      createdAt: at(21, 10),
      completedAt: at(6, 17),
    },
    {
      title: "Board update for October",
      status: "done",
      priority: "medium",
      assigneeId: ada.id,
      projectId: "proj_pricing",
      goalId: "goal_mrr",
      description: "One page: the metric, the miss, the plan. No theatre.",
      acceptance: ["Numbers match the ledger", "One explicit ask", "Two-line risk section"],
      labels: ["board", "reporting"],
      createdAt: at(20, 9),
      completedAt: at(8, 18),
    },
    {
      title: "Docs: connect your first warehouse source",
      status: "todo",
      priority: "low",
      assigneeId: sofia.id,
      projectId: "proj_growth",
      description: "The current doc assumes a data engineer. Rewrite it for the operator who just signed up.",
      acceptance: ["Under 600 words", "One screenshot per step", "Tested on a clean workspace"],
      labels: ["docs", "activation"],
      createdAt: at(3, 11),
    },
    {
      title: "Add guardrail checks to every public-facing agent",
      status: "todo",
      priority: "high",
      assigneeId: lena.id,
      projectId: "proj_growth",
      description: "Noah and Aria can publish. Put the NeMo Guardrail in front of anything that leaves the building, and log the verdict on the run.",
      acceptance: ["Block path tested with a known-bad prompt", "Verdict stored on the run", "False-positive rate noted"],
      labels: ["safety", "risk"],
      createdAt: at(2, 9),
    },
  ];

  for (const spec of issueSpecs) {
    const issue = createIssue(company, {
      ...spec,
      createdBy: spec.assigneeId === ada.id ? "human" : "agent",
      updatedAt: spec.createdAt ?? at(1, 12),
    });
    if (spec.completedAt) issue.updatedAt = spec.completedAt;
    company.issues.push(issue);
  }
  const issueByTitle = (fragment) => company.issues.find((issue) => issue.title.includes(fragment));

  const funnel = issueByTitle("Instrument the signup funnel");
  const emails = issueByTitle("lifecycle email");
  const coldStart = issueByTitle("Cut cold-start");
  const postmortem = issueByTitle("postmortem");
  const board = issueByTitle("Board update");
  const pricing = issueByTitle("Usage-based pricing");

  /* ---------------------------------------------------------- discussion */

  company.comments = [
    createComment({
      issueId: funnel.id,
      authorType: "agent",
      authorId: dev.id,
      kind: "deliverable",
      body:
        "## Funnel instrumentation\n\n**Events** — `workspace_created`, `source_connected`, `first_query`, `first_saved_insight`, all with `workspace_id`, `plan` and `source_kind`.\n\n**Numbers** — warehouse latency for the new events: p50 41s, p95 58s (target 60s). Backfill covers 14 days: 21,884 events.\n\n**Rollback** — flag `funnel_v2`; flipping it off restores the old client shim without dropping events.",
      createdAt: at(2, 14),
      meta: { model: "mistralai/codestral-22b-instruct-v0.1", costCents: 4 },
    }),
    createComment({
      issueId: funnel.id,
      authorType: "agent",
      authorId: lena.id,
      kind: "review",
      body:
        "**Verdict: accepted (86)**\n\n- Events, backfill and rollback are all evidenced. Good.\n- One nit: the dashboard link is missing next to the p95 claim. Add it before we cite this in the board update.\n- Follow-up: alert if `first_saved_insight` drops below 40/day for two days.",
      createdAt: at(2, 15),
      meta: { model: "nvidia/nemotron-3-super-120b-a12b", costCents: 3 },
    }),
    createComment({
      issueId: coldStart.id,
      authorType: "agent",
      authorId: marcus.id,
      kind: "comment",
      body:
        "Profiled the cold path. 71% of the 24s is the first warehouse metadata fetch; the cache warms in parallel today but starts *after* auth. Moving warmup to the workspace-created webhook is a ~2s win without touching query planning.",
      createdAt: at(1, 11),
      meta: { model: "nvidia/nemotron-3-super-120b-a12b", costCents: 2 },
    }),
    createComment({
      issueId: postmortem.id,
      authorType: "human",
      authorId: "you",
      kind: "comment",
      body: "Holding this until legal clears the customer-impact paragraph. Everything else is ready.",
      createdAt: at(4, 9),
    }),
    createComment({
      issueId: emails.id,
      authorType: "agent",
      authorId: noah.id,
      kind: "comment",
      body:
        "Draft of email 1 is in the artifacts panel. Subject A: “Your first insight is two clicks away.” Subject B: “Datasets are ready — here's the 90-second version.” Running both with a 50/50 split.",
      createdAt: at(1, 16),
      meta: { model: "mistralai/mistral-large-2-instruct", costCents: 2 },
    }),
    createComment({
      issueId: board.id,
      authorType: "agent",
      authorId: ada.id,
      kind: "comment",
      body: "October update sent. $12.4k MRR, activation p50 down to 17 minutes, one ask: hold hiring until time-to-value is under 10.",
      createdAt: at(8, 18),
      meta: { model: "nvidia/nemotron-3-ultra-550b-a55b", costCents: 6 },
    }),
    createComment({
      issueId: pricing.id,
      authorType: "agent",
      authorId: noah.id,
      kind: "comment",
      body: "Recommendation: usage tiers with a seat floor. Margin 78% at 100 seats, 71% at 1,000. The risk is a bill-shock moment at month two — we need a spend cap in the UI before launch.",
      createdAt: at(6, 17),
      meta: { model: "mistralai/mistral-large-2-instruct", costCents: 4 },
    }),
  ];

  /* ------------------------------------------------------------- knowledge */

  company.knowledge = [
    createKnowledge({
      id: "doc_brief",
      title: "Company brief — Northwind Labs",
      tags: ["company", "goals"],
      source: "human",
      createdAt: at(60, 9),
      body:
        "Northwind Labs sells a self-serve analytics workspace for operations teams at 20–200 person companies. Wedge: connect a warehouse source and get one trustworthy insight in under ten minutes — no data engineer, no implementation project. Current MRR $12.4k across 63 accounts, gross margin 74%. The bottleneck is not acquisition: trials start fast and stall on day three, before the first saved insight. Strategy for the next 90 days is to fix activation and let pricing follow usage, not seats. Headcount is frozen. Every cycle must name one metric and one owner.",
    }),
    createKnowledge({
      id: "doc_interviews",
      title: "Trial interviews — 16 notes (synthesis)",
      tags: ["research", "activation"],
      source: "agent",
      createdAt: at(6, 12),
      body:
        "Sixteen trial accounts were interviewed. The recurring failure is the same in 11 of 16: the user connects a source, waits for the first query, and leaves before it finishes. Median first-query wait was 24 seconds; the longest was 71 seconds. Nine said some version of “I did not know if it was broken.” Only two ever found the saved-insight feature. The empty sources page came up unprompted in seven interviews. Price sensitivity is low at this stage — nobody churned over price, four churned over time-to-value. Recommended: instrument the funnel, cut cold-start latency, and put one obvious next action on the empty state.",
    }),
    createKnowledge({
      id: "doc_metrics",
      title: "Activation metrics and definitions",
      tags: ["metrics", "activation"],
      source: "human",
      createdAt: at(9, 10),
      body:
        "Definitions used by the board. Signup: workspace_created. Activation: first_saved_insight within 7 days. Time-to-first-value: minutes between workspace_created and first_saved_insight, p50 across workspaces created that week. Trial stall: no event for 72 hours. MRR counts committed subscription revenue, not usage overages. Data comes from the warehouse models `fct_activation` and `fct_events`, refreshed every 15 minutes; p95 latency target for the pipeline is 60 seconds. Any number quoted in a board update must link to one of these models.",
    }),
    createKnowledge({
      id: "doc_pricing",
      title: "Pricing research — usage vs seats",
      tags: ["pricing", "finance"],
      source: "agent",
      createdAt: at(6, 16),
      body:
        "Model comparison at 10, 100 and 1,000 seats. Seat pricing is simple to sell and produces predictable revenue, but expansion stalls because one power user can serve a whole team. Usage pricing tracks value and expands naturally, at the cost of month-two bill shock. Blended model (usage tiers with a seat floor) produces 78% margin at 100 seats and 71% at 1,000, versus 81% and 69% for pure seats. Two competitors publish usage pricing with a hard spend cap; three do not. Recommendation: usage tiers with a seat floor and a visible spend cap before launch.",
    }),
    createKnowledge({
      id: "doc_incident",
      title: "2026-09-14 outage — internal timeline",
      tags: ["incident", "infra"],
      source: "human",
      createdAt: at(12, 8),
      body:
        "On 2026-09-14 the query service failed for 2h14m (09:41–11:55 UTC). Trigger: a warehouse metadata migration doubled cold-start latency, which exhausted the connection pool at peak signup traffic. 312 workspaces were affected; 41 trial accounts never returned. Detection came from a customer tweet 19 minutes before our own alert fired. Prevention actions: pool saturation alerting at 70%, warmup moved off the request path, and a synthetic signup probe every 5 minutes. Customer-impact paragraph is pending legal review before the public postmortem.",
    }),
  ];

  /* ----------------------------------------------------------------- runs */

  const runSpecs = [
    {
      issueId: funnel.id,
      agentId: dev.id,
      kind: "work",
      status: "succeeded",
      model: "mistralai/codestral-22b-instruct-v0.1",
      startedAt: at(2, 13),
      endedAt: at(2, 14),
      usage: { prompt_tokens: 3260, completion_tokens: 1180 },
      steps: [
        { label: "Retrieved 4 knowledge chunks", detail: "activation-metrics.md · interviews synthesis", ms: 320 },
        { label: "Called tool: knowledge_search", detail: "funnel event schema", ms: 180 },
        { label: "Drafted deliverable", detail: "1,180 tokens", ms: 4200 },
        { label: "Safety check", detail: "safe (0.04)", ms: 240 },
      ],
      output: "Funnel instrumentation delivered with events, backfill and rollback.",
      review: { verdict: "accepted", score: 86 },
    },
    {
      issueId: postmortem.id,
      agentId: aria.id,
      kind: "work",
      status: "succeeded",
      model: "nvidia/nemotron-3.5-lightning-30b-a3b",
      startedAt: at(3, 10),
      endedAt: at(3, 10),
      usage: { prompt_tokens: 1810, completion_tokens: 640 },
      steps: [
        { label: "Retrieved 3 knowledge chunks", detail: "incident timeline", ms: 210 },
        { label: "Drafted deliverable", detail: "640 tokens", ms: 1800 },
      ],
      output: "Postmortem drafted, parked for legal review.",
      review: { verdict: "accepted", score: 79 },
    },
    {
      issueId: coldStart.id,
      agentId: marcus.id,
      kind: "work",
      status: "running",
      model: "nvidia/nemotron-3-super-120b-a12b",
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      usage: { prompt_tokens: 2440, completion_tokens: 320 },
      steps: [
        { label: "Retrieved 2 knowledge chunks", detail: "activation-metrics.md", ms: 280 },
        { label: "Profiled cold path", detail: "metadata fetch = 71%", ms: 1200 },
      ],
      output: "",
      review: null,
    },
    {
      issueId: board.id,
      agentId: ada.id,
      kind: "plan",
      status: "succeeded",
      model: "nvidia/nemotron-3-ultra-550b-a55b",
      startedAt: at(8, 16),
      endedAt: at(8, 18),
      usage: { prompt_tokens: 4100, completion_tokens: 900 },
      steps: [
        { label: "Read board + ledger", detail: "18 issues · 41 ledger rows", ms: 300 },
        { label: "Wrote cycle focus", detail: "activate before price", ms: 5200 },
      ],
      output: "October update: $12.4k MRR, activation p50 17m, one ask.",
      review: null,
    },
  ];

  company.runs = runSpecs.map((spec) => {
    const cost = estimateCost({ model: spec.model, usage: spec.usage });
    return {
      id: newId("run"),
      issueId: spec.issueId,
      agentId: spec.agentId,
      kind: spec.kind,
      status: spec.status,
      model: spec.model,
      simulated: true,
      startedAt: spec.startedAt,
      endedAt: spec.endedAt,
      usage: spec.usage,
      costCents: cost.cents,
      steps: spec.steps,
      output: spec.output,
      review: spec.review,
      error: null,
    };
  });

  for (const run of company.runs) {
    if (run.status !== "running") {
      company.ledger.push({
        id: newId("led"),
        at: run.endedAt ?? run.startedAt,
        runId: run.id,
        agentId: run.agentId,
        model: run.model,
        inputTokens: run.usage.prompt_tokens,
        outputTokens: run.usage.completion_tokens,
        images: 0,
        costCents: run.costCents,
        costDollars: run.costCents / 100,
        endpoint: "chat",
      });
    }
  }

  /* --------------------------------------------------------------- ledger */

  const ledgerModels = [
    ["nvidia/nemotron-3-super-120b-a12b", 14_000, 2_400],
    ["nvidia/nemotron-3-ultra-550b-a55b", 22_000, 3_200],
    ["nvidia/nemotron-nano-3-30b-a3b", 9_000, 1_400],
    ["nvidia/nemotron-3.5-embed-8b", 26_000, 0],
    ["nvidia/nv-rerankqa-mistral-4b-v3", 12_000, 0],
    ["mistralai/codestral-22b-instruct-v0.1", 18_000, 2_800],
    ["mistralai/mistral-large-2-instruct", 6_000, 1_200],
    ["nvidia/nemotron-3.5-content-safety", 1_200, 60],
  ];
  let seedState = 42;
  const next = () => {
    seedState = (seedState * 1103515245 + 12345) % 2147483648;
    return seedState / 2147483648;
  };
  for (let day = 13; day >= 0; day -= 1) {
    const rows = 2 + Math.floor(next() * 4);
    for (let row = 0; row < rows; row += 1) {
      const [model, inBase, outBase] = ledgerModels[Math.floor(next() * ledgerModels.length)];
      const agent = company.agents[Math.floor(next() * company.agents.length)];
      const usage = {
        prompt_tokens: Math.round(inBase * (0.6 + next() * 0.9)),
        completion_tokens: Math.round(outBase * (0.5 + next())),
      };
      const cost = estimateCost({ model, usage });
      company.ledger.push({
        id: newId("led"),
        at: at(day, 8 + Math.floor(next() * 10), Math.floor(next() * 60)),
        runId: newId("run"),
        agentId: agent.id,
        model,
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        images: 0,
        costCents: cost.cents,
        costDollars: cost.dollars,
        endpoint: model.includes("embed") ? "embeddings" : model.includes("rerank") ? "ranking" : "chat",
      });
    }
  }
  company.ledger.sort((a, b) => b.at.localeCompare(a.at));

  /* ------------------------------------------------------------- approvals */

  company.approvals = [
    createApproval({
      issueId: postmortem.id,
      requestedBy: aria.id,
      reason: "Publishing a customer-facing postmortem is an external action and needs a human decision.",
      risk: "high",
      action: "Publish postmortem to status.northwind.dev",
      status: "pending",
      createdAt: at(2, 11),
    }),
    (() => {
      const approval = createApproval({
        issueId: pricing.id,
        requestedBy: noah.id,
        reason: "Move pricing page traffic 100% to the usage-tier variant.",
        risk: "medium",
        action: "Flip pricing experiment to 100%",
        status: "approved",
        decidedBy: "you",
        createdAt: at(5, 14),
      });
      approval.decidedAt = at(5, 15);
      approval.note = "Approved for 50 accounts only, not 100%.";
      return approval;
    })(),
    (() => {
      const approval = createApproval({
        issueId: funnel.id,
        requestedBy: dev.id,
        reason: "Backfill writes 21k rows into the production warehouse.",
        risk: "medium",
        action: "Run 14-day backfill",
        status: "approved",
        decidedBy: "you",
        createdAt: at(3, 9),
      });
      approval.decidedAt = at(3, 10);
      approval.note = "Approved. Off-peak only.";
      return approval;
    })(),
  ];

  /* -------------------------------------------------------------- routines */

  company.routines = [
    createRoutine({
      id: "routine_standup",
      name: "Morning standup",
      instruction: "Summarise what shipped, what is blocked and what it cost. Name the single most valuable next action.",
      agentId: aria.id,
      cadenceMinutes: 1440,
      lastRunAt: at(1, 8),
      nextRunAt: new Date(Date.now() + 7 * 3600_000).toISOString(),
      runs: 18,
      createdAt: at(15, 9),
    }),
    createRoutine({
      id: "routine_triage",
      name: "Backlog triage",
      instruction: "Re-rank the backlog against the current goal. Reassign anything without an owner.",
      agentId: ada.id,
      cadenceMinutes: 4320,
      lastRunAt: at(2, 8),
      nextRunAt: new Date(Date.now() + 26 * 3600_000).toISOString(),
      runs: 6,
      createdAt: at(14, 9),
    }),
    createRoutine({
      id: "routine_quality",
      name: "Quality sweep",
      instruction: "Re-check every deliverable from the last cycle against its acceptance criteria and report drift.",
      agentId: lena.id,
      cadenceMinutes: 10080,
      lastRunAt: at(5, 8),
      nextRunAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      runs: 3,
      createdAt: at(13, 9),
    }),
  ];

  /* -------------------------------------------------------------- activity */

  const activitySpecs = [
    { kind: "run.succeeded", actorId: dev.id, subject: funnel.key, detail: "Delivered funnel instrumentation", issueId: funnel.id, at: at(2, 14) },
    { kind: "review.accepted", actorId: lena.id, subject: funnel.key, detail: "Accepted with score 86", issueId: funnel.id, at: at(2, 15) },
    { kind: "run.started", actorId: marcus.id, subject: coldStart.key, detail: "Profiling cold-start query path", issueId: coldStart.id, at: at(1, 11) },
    { kind: "issue.blocked", actorId: aria.id, subject: postmortem.key, detail: "Parked pending legal review", issueId: postmortem.id, at: at(4, 9) },
    { kind: "approval.requested", actorId: aria.id, subject: postmortem.key, detail: "Publish postmortem to status page", issueId: postmortem.id, at: at(2, 11) },
    { kind: "issue.completed", actorId: priya.id, subject: issueByTitle("empty state").key, detail: "Empty state shipped with one primary action", at: at(2, 15) },
    { kind: "budget.threshold", actorId: sofia.id, subject: "Research", detail: "Sofia at 62% of monthly cap", at: at(3, 12) },
    { kind: "run.succeeded", actorId: ada.id, subject: board.key, detail: "October board update written", issueId: board.id, at: at(8, 18) },
    { kind: "knowledge.indexed", actorId: sofia.id, subject: "Trial interviews", detail: "16 interview notes indexed for retrieval", at: at(6, 12) },
  ];
  company.activity = activitySpecs.map((entry) => ({
    id: newId("act"),
    at: entry.at,
    kind: entry.kind,
    actorId: entry.actorId,
    subject: entry.subject,
    detail: entry.detail,
    issueId: entry.issueId ?? null,
    meta: {},
  }));

  company.artifacts = [
    {
      id: newId("art"),
      issueId: funnel.id,
      runId: company.runs[0]?.id ?? null,
      title: "funnel-instrumentation.md",
      kind: "markdown",
      createdAt: at(2, 14),
      body: "# Funnel instrumentation\n\n```sql\nselect date_trunc('day', occurred_at) as day,\n       count(*) filter (where event = 'workspace_created') as workspaces,\n       count(*) filter (where event = 'first_saved_insight') as activated\nfrom fct_events\ngroup by 1\norder by 1 desc;\n```\n\nBackfill covers 21,884 events over 14 days. Flag: `funnel_v2`.",
    },
    {
      id: newId("art"),
      issueId: emails.id,
      runId: null,
      title: "lifecycle-email-1.md",
      kind: "markdown",
      createdAt: at(1, 16),
      body: "# Email 1 — “Your first insight is two clicks away”\n\n**Preview:** Connect a source, ask one question, save the answer.\n\nHi {{first_name}},\n\nYou signed up yesterday but haven't connected a source yet. That's the step that makes Northwind useful — everything else is waiting on it.\n\n[Connect your first source →]\n\nIt takes about two minutes, and we'll ask you one question afterwards to prove it worked.\n\n— Noah, Northwind Labs\n\n_Kill criterion: if connect-rate on this cohort does not improve by 8 points in 14 days, we retire the sequence._",
    },
  ];

  /* ---------------------------------------------------------- cycle history */

  company.cycleHistory = [
    {
      id: newId("cycle"),
      startedAt: at(2, 13),
      endedAt: at(2, 16),
      focus: "Unblock activation: finish instrumentation and cut cold-start latency.",
      ran: 3,
      accepted: 1,
      changesRequested: 1,
      blocked: 0,
      costCents: company.ledger.slice(0, 12).reduce((sum, row) => sum + row.costCents, 0),
      reason: "maxCycles reached",
    },
  ];

  return recomputeCompany(company);
}
