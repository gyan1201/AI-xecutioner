/**
 * NVIDIA AI blueprints, localised.
 *
 * build.nvidia.com/blueprints ships 36 reference architectures. Each one here
 * is a runnable Paperclip recipe: a team, a goal, a backlog, and the NIM
 * endpoint calls the team will actually make. "Deploy" turns a blueprint into
 * agents + issues inside a company — the engine then executes it.
 */

import { CAPABILITIES } from "./catalog.mjs";

const M = {
  ultra: "nvidia/nemotron-3-ultra-550b-a55b",
  super: "nvidia/nemotron-3-super-120b-a12b",
  nano: "nvidia/nemotron-nano-3-30b-a3b",
  lightning: "nvidia/nemotron-3.5-lightning-30b-a3b",
  vl: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  parse: "nvidia/nemotron-parse-2.0",
  embed: "nvidia/nemotron-3.5-embed-8b",
  rerank: "nvidia/nv-rerankqa-mistral-4b-v3",
  safety: "nvidia/nemotron-3.5-content-safety",
  image: "google/diffusiongemma-26b-a4b-it",
  flux: "black-forest-labs/flux.1-dev",
  code: "mistralai/codestral-22b-instruct-v0.1",
  translate: "nvidia/riva-translate-4b-instruct-v2",
  protein: "nvidia/bionemo-boltz2",
  reward: "nvidia/nemotron-4-340b-reward",
  cosmos: "nvidia/cosmos-reason2-8b",
  video: "nvidia/cosmos-predict2-14b-text2world",
  rerankLite: "nvidia/llama-3.2-nv-rerankqa-1b-v2",
};

function bp(spec) {
  const functions = spec.functions ?? ["chat"];
  const team = spec.team ?? [
    { name: "Blueprint Lead", title: "Solution Architect", role: "strategist", model: M.ultra, budget: 2500 },
    { name: "Builder", title: "Implementation Engineer", role: "operator", model: M.super, budget: 2000 },
    { name: "Reviewer", title: "Quality Lead", role: "critic", model: M.super, budget: 800 },
  ];
  const steps = spec.steps ?? [
    `Brief the team on the ${spec.name} outcome and constraints.`,
    `Wire the NIM calls: ${functions.map((key) => CAPABILITIES[key]?.label ?? key).join(", ")}.`,
    "Produce the reference deliverable and link it to the board.",
    "Review against the definition of done and hand over.",
  ];
  return {
    id: spec.id,
    name: spec.name,
    category: spec.category ?? "Agentic AI",
    industry: spec.industry ?? "General",
    summary: spec.summary,
    models: [...new Set([...(spec.models ?? []), ...team.map((member) => member.model)])],
    functions,
    steps,
    team,
    goal: spec.goal ?? {
      title: spec.name,
      metric: "accepted deliverables",
      target: 3,
      baseline: 0,
    },
    backlog: spec.backlog ?? [
      { title: `${spec.name}: scope and success metric`, priority: "high" },
      { title: `${spec.name}: build the pipeline`, priority: "high" },
      { title: `${spec.name}: validate on real inputs`, priority: "medium" },
      { title: `${spec.name}: runbook and handover`, priority: "low" },
    ],
    links: spec.links ?? {},
  };
}

export const BLUEPRINTS = [
  bp({
    id: "aiq-research",
    name: "AI-Q Research Assistant",
    category: "Agentic AI",
    summary:
      "Deep research agents that decompose a question, search, read, and return an answer with citations. Uses reasoning models for planning and rerankers to keep sources honest.",
    functions: ["reasoning", "chat", "embedding", "rerank", "safety"],
    models: [M.ultra, M.embed, M.rerank],
    team: [
      { name: "Quinn Reyes", title: "Research Director", role: "strategist", model: M.ultra, budget: 3000 },
      { name: "Iris Wu", title: "Research Analyst", role: "analyst", model: M.super, budget: 1800 },
      { name: "Theo Marsh", title: "Source Auditor", role: "critic", model: M.super, budget: 900 },
    ],
    goal: { title: "Answer board questions with cited research in under an hour", metric: "median hours", target: 1, baseline: 26 },
    backlog: [
      { title: "Decompose the brief into research sub-questions", priority: "high" },
      { title: "Retrieve and rerank 40 candidate sources", priority: "high" },
      { title: "Draft the cited answer with confidence levels", priority: "medium" },
      { title: "Audit three claims against primary sources", priority: "medium" },
    ],
  }),
  bp({
    id: "rag-pipeline",
    name: "RAG Blueprint (NeMo Retriever)",
    category: "RAG & Retrieval",
    summary:
      "The canonical enterprise RAG stack: parse documents, embed chunks, rerank candidates, answer only from context. Every turn is grounded, and unanswered questions are reported as gaps instead of invented.",
    functions: ["parse", "embedding", "rerank", "chat", "safety"],
    models: [M.parse, M.embed, M.rerank, M.super],
    team: [
      { name: "Nadia Osei", title: "Knowledge Engineer", role: "operator", model: M.super, budget: 2200 },
      { name: "Bram de Vries", title: "Retrieval Analyst", role: "analyst", model: M.nano, budget: 1200 },
      { name: "Kavya Rao", title: "Answer Reviewer", role: "critic", model: M.super, budget: 800 },
    ],
    goal: { title: "Answer 80% of internal questions from indexed knowledge", metric: "answer coverage", target: 80, baseline: 41 },
  }),
  bp({
    id: "agentic-rag",
    name: "Agentic Retrieval",
    category: "RAG & Retrieval",
    summary:
      "An agent decides when to search, rewrites its own queries, and loops until the evidence is sufficient. Adds query planning, tool use and a spend cap per question.",
    functions: ["reasoning", "chat", "tools", "embedding", "rerank"],
    models: [M.ultra, M.embed, M.rerank],
  }),
  bp({
    id: "vss-video-search",
    name: "Video Search & Summarization",
    category: "Vision",
    summary:
      "Index hours of video, then ask questions in plain language. Frames are captioned by a VLM, embedded, and retrieved; answers cite timestamps instead of vibes.",
    functions: ["vision", "embedding", "rerank", "chat"],
    models: [M.vl, M.embed, M.super],
    team: [
      { name: "Marco Silva", title: "Media Pipeline Engineer", role: "operator", model: M.super, budget: 2000 },
      { name: "Hana Ito", title: "Video Analyst", role: "analyst", model: M.vl, budget: 1600 },
      { name: "Priya Nair", title: "Evidence Reviewer", role: "critic", model: M.super, budget: 700 },
    ],
    goal: { title: "Find any moment in the archive in under 30 seconds", metric: "seconds to evidence", target: 30, baseline: 900 },
  }),
  bp({
    id: "digital-human",
    name: "Digital Human (Tokkio)",
    category: "Vision",
    summary:
      "A lifelike avatar that listens, understands and answers with lip-synced speech. The reasoning loop, ASR, TTS and guardrails are separate NIMs so each can be swapped.",
    functions: ["chat", "vision", "safety", "translate"],
    models: [M.super, M.vl, M.safety, M.translate],
  }),
  bp({
    id: "docs-fab",
    name: "DocsFab Documentation Agent",
    category: "Agentic AI",
    summary:
      "Reads the source repo, finds drifted docs, and opens reviewable patches with quality checks. The agent writes documentation the way a staff engineer would: from code, not from memory.",
    functions: ["code", "chat", "tools", "embedding"],
    models: [M.code, M.super, M.embed],
  }),
  bp({
    id: "agent-eval",
    name: "Agent Trace Evaluation",
    category: "Agentic AI",
    summary:
      "Mines agent traces for failure modes, builds task-specific evals, and validates harness changes before shipping. Uses a reward model as the judge and stores every score in the ledger.",
    functions: ["reasoning", "chat", "reward", "embedding"],
    models: [M.ultra, M.reward, M.embed],
  }),
  bp({
    id: "deep-agents-code",
    name: "Deep Agents Code",
    category: "Agentic AI",
    summary:
      "A sandboxed coding agent that plans, edits and tests code with enterprise governance. Every shell command is gated, and spend is visible per task.",
    functions: ["code", "tools", "reasoning", "safety"],
    models: [M.ultra, M.code, M.safety],
  }),
  bp({
    id: "guardrails",
    name: "NeMo Guardrails Deployment",
    category: "Security",
    summary:
      "Put content safety, topic control and jailbreak detection in front of every model call. Unsafe requests are blocked before they reach an agent, with a reason the UI can show.",
    functions: ["safety", "chat", "reasoning"],
    models: [M.safety, M.super],
    team: [
      { name: "Elena Petrova", title: "Trust & Safety Lead", role: "critic", model: M.super, budget: 1800 },
      { name: "Sam Okoye", title: "Policy Engineer", role: "operator", model: M.super, budget: 1600 },
    ],
    goal: { title: "Zero unsafe prompts reach a production agent", metric: "blocked before model", target: 100, baseline: 62 },
  }),
  bp({
    id: "drug-discovery",
    name: "Molecular Design Agent",
    category: "Biology",
    summary:
      "Coordinate molecular design: propose candidates, predict structure and affinity, and rank a shortlist. BioNeMo NIMs do the science; the agent team does the reasoning and the paperwork.",
    functions: ["protein", "reasoning", "chat", "embedding"],
    models: [M.protein, M.ultra, M.embed],
    team: [
      { name: "Dr. Amara Bello", title: "Computational Chemist", role: "analyst", model: M.ultra, budget: 3000 },
      { name: "Yuki Tanaka", title: "Protein Modeler", role: "operator", model: M.super, budget: 2200 },
      { name: "Dr. Luis Ortega", title: "Peer Reviewer", role: "critic", model: M.super, budget: 900 },
    ],
    goal: { title: "Shortlist 5 binders with predicted affinity under 10 nM", metric: "shortlisted binders", target: 5, baseline: 0 },
  }),
  bp({
    id: "genomics",
    name: "Genomics Workflow (Parabricks)",
    category: "Biology",
    summary:
      "Accelerate secondary analysis: align, call variants, and annotate with GPU-accelerated Parabricks, then have agents summarise findings for clinical review.",
    functions: ["reasoning", "chat", "embedding"],
    models: [M.ultra, M.embed],
  }),
  bp({
    id: "protein-structure",
    name: "Protein Structure Prediction",
    category: "Biology",
    summary:
      "Predict structures and complexes with Boltz2, score confidence, and compare against known folds. Failures are explained in plain language, not stack traces.",
    functions: ["protein", "reasoning", "vision"],
    models: [M.protein, M.ultra],
  }),
  bp({
    id: "cuopt-routing",
    name: "Route Optimization (cuOpt)",
    category: "Optimization",
    summary:
      "Solve vehicle routing, dispatching and scheduling at scale. Agents translate operations constraints into solver models and explain the trade-offs in the answer.",
    functions: ["reasoning", "tools", "chat"],
    models: [M.ultra, M.super],
    team: [
      { name: "Ravi Menon", title: "Operations Scientist", role: "analyst", model: M.ultra, budget: 2200 },
      { name: "Clara Nguyen", title: "Dispatcher", role: "operator", model: M.super, budget: 1600 },
    ],
    goal: { title: "Cut fleet miles 12% without missing a delivery window", metric: "miles saved %", target: 12, baseline: 0 },
  }),
  bp({
    id: "gqe-sql",
    name: "GPU SQL Engine (GQE)",
    category: "Data",
    summary:
      "A GPU-accelerated SQL path over lakehouse data. Agents profile queries, propose rewrites, and prove the plan is faster before anyone touches production.",
    functions: ["code", "reasoning", "chat"],
    models: [M.code, M.ultra],
  }),
  bp({
    id: "cudf-etl",
    name: "RAPIDS Data Processing",
    category: "Data",
    summary:
      "Turn pandas pipelines into GPU ETL with cuDF, verify parity on real slices, and keep the CPU path as a reference. Agents do the migration and the benchmark.",
    functions: ["code", "chat", "tools"],
    models: [M.code, M.super],
  }),
  bp({
    id: "sre-rca",
    name: "AI Factory SRE Agents",
    category: "Security",
    summary:
      "Investigate cluster incidents: correlate GPU telemetry, find the failing layer, and write the root-cause note. Triage agents run 24/7 with a human approval gate for any remediation.",
    functions: ["reasoning", "tools", "chat", "embedding"],
    models: [M.ultra, M.super, M.embed],
    team: [
      { name: "Jonas Weber", title: "SRE Lead", role: "strategist", model: M.ultra, budget: 2600 },
      { name: "Aisha Bello", title: "Incident Responder", role: "operator", model: M.super, budget: 2000 },
      { name: "Chen Yu", title: "Postmortem Reviewer", role: "critic", model: M.super, budget: 900 },
    ],
    goal: { title: "Median time-to-root-cause under 15 minutes", metric: "minutes", target: 15, baseline: 74 },
  }),
  bp({
    id: "cyber-vuln",
    name: "Vulnerability Analysis for Code",
    category: "Security",
    summary:
      "Scan a codebase, triage findings by exploitability, and propose patches. The agent explains risk in business terms and never invents a CVE.",
    functions: ["code", "reasoning", "tools", "safety"],
    models: [M.code, M.ultra, M.safety],
  }),
  bp({
    id: "trading-signals",
    name: "Trading Strategy Discovery",
    category: "Finance",
    summary:
      "Automate discovery, testing and refinement of trading signals with strict guardrails: every hypothesis gets a backtest, a cost model and a kill criterion.",
    functions: ["reasoning", "code", "tools", "chat"],
    models: [M.ultra, M.code],
    team: [
      { name: "Nora Haddad", title: "Quant Research Lead", role: "analyst", model: M.ultra, budget: 3000 },
      { name: "Ben Carter", title: "Backtest Engineer", role: "operator", model: M.code, budget: 2000 },
      { name: "Ivy Chen", title: "Risk Reviewer", role: "critic", model: M.ultra, budget: 1000 },
    ],
    goal: { title: "Find one signal with Sharpe > 1.5 after costs", metric: "validated signals", target: 1, baseline: 0 },
  }),
  bp({
    id: "shopping-assistant",
    name: "Retail Shopping Assistant",
    category: "Retail",
    summary:
      "A product expert that understands intent, compares SKUs, and cites the catalogue. Works from your merchandising data, not the open web.",
    functions: ["chat", "embedding", "rerank", "safety"],
    models: [M.super, M.embed, M.rerank],
  }),
  bp({
    id: "loss-prevention",
    name: "Retail Loss Prevention",
    category: "Vision",
    summary:
      "Detect shelf gaps, queue events and suspicious behaviour from existing cameras. Vision NIMs emit events; agents summarise the shift and flag what needs a human.",
    functions: ["vision", "chat", "safety"],
    models: [M.vl, M.super],
  }),
  bp({
    id: "smart-warehouse",
    name: "Intelligent Warehouse",
    category: "Robotics",
    summary:
      "A digital twin of the floor: simulate pick paths, spot bottlenecks and test layout changes before moving a single rack.",
    functions: ["reasoning", "vision", "tools"],
    models: [M.ultra, M.vl],
  }),
  bp({
    id: "manufacturing-vision",
    name: "Visual Inspection",
    category: "Vision",
    summary:
      "Train and operate defect detection on the line, then have agents write the shift report and escalate drift.",
    functions: ["vision", "chat", "embedding"],
    models: [M.vl, M.embed],
  }),
  bp({
    id: "telecom-ran",
    name: "RAN Optimization",
    category: "Telecom",
    summary:
      "Analyse cell performance, propose parameter changes, and simulate the impact before touching the radio.",
    functions: ["reasoning", "tools", "chat"],
    models: [M.ultra],
  }),
  bp({
    id: "automotive-perception",
    name: "Autonomous Perception",
    category: "Automotive",
    summary:
      "Evaluate perception stacks against scenario suites, find the frames that matter, and produce a safety case.",
    functions: ["vision", "reasoning", "embedding"],
    models: [M.vl, M.ultra],
  }),
  bp({
    id: "climate-forecast",
    name: "Earth-2 Climate Forecasting",
    category: "Climate",
    summary:
      "Downscale forecasts, compare runs, and explain uncertainty to non-specialists. Every claim carries a lead time and a confidence band.",
    functions: ["reasoning", "chat", "vision"],
    models: [M.ultra, M.super],
  }),
  bp({
    id: "ambient-clinical",
    name: "Ambient Clinical Scribe",
    category: "Healthcare",
    summary:
      "Listen to the visit, draft the note, and route it for clinician sign-off. PHI stays in the audit trail; nothing is written without approval.",
    functions: ["chat", "safety", "reasoning"],
    models: [M.super, M.safety, M.ultra],
  }),
  bp({
    id: "medical-imaging",
    name: "Medical Imaging Insights",
    category: "Healthcare",
    summary:
      "Triage studies, draft findings, and compare against priors. A radiologist approves every report before it leaves the system.",
    functions: ["vision", "reasoning", "chat"],
    models: [M.vl, M.ultra],
  }),
  bp({
    id: "content-factory",
    name: "Marketing Content Factory",
    category: "Retail",
    summary:
      "One brief becomes a campaign: copy, variants, images and a publishing checklist. A brand reviewer blocks anything off-voice.",
    functions: ["chat", "image", "safety"],
    models: [M.super, M.image, M.safety],
    team: [
      { name: "Jules Moreau", title: "Creative Director", role: "strategist", model: M.super, budget: 2200 },
      { name: "Robin Blake", title: "Copywriter", role: "operator", model: M.super, budget: 1800 },
      { name: "Dana Whitfield", title: "Brand Reviewer", role: "critic", model: M.nano, budget: 700 },
    ],
    goal: { title: "Ship 4 on-brand campaigns this month", metric: "campaigns shipped", target: 4, baseline: 0 },
  }),
  bp({
    id: "document-intelligence",
    name: "Document Intelligence",
    category: "Agentic AI",
    summary:
      "Parse invoices, contracts and forms into structured rows, with human review on anything below confidence. Nemotron Parse does the reading; the agent does the checking.",
    functions: ["parse", "chat", "embedding", "safety"],
    models: [M.parse, M.super, M.embed],
    team: [
      { name: "Farah Aziz", title: "Document Ops Lead", role: "operator", model: M.super, budget: 2200 },
      { name: "Tom Hale", title: "Data Reviewer", role: "critic", model: M.nano, budget: 800 },
    ],
    goal: { title: "Extract 1,000 documents with 98% field accuracy", metric: "field accuracy %", target: 98, baseline: 84 },
  }),
  bp({
    id: "contact-center",
    name: "Customer Service Voice Agent",
    category: "Agentic AI",
    summary:
      "Answer calls, resolve the top intents, and hand off to a human with full context. Guardrails keep promises inside policy.",
    functions: ["chat", "safety", "embedding", "translate"],
    models: [M.super, M.safety, M.translate],
  }),
  bp({
    id: "personalization",
    name: "Personalization & Recsys",
    category: "Retail",
    summary:
      "Embed the catalogue and the customer, retrieve candidates, rerank by intent, and explain why each recommendation was made.",
    functions: ["embedding", "rerank", "chat"],
    models: [M.embed, M.rerank, M.super],
  }),
  bp({
    id: "synthetic-data",
    name: "Synthetic Data Designer",
    category: "Data",
    summary:
      "Generate a labelled dataset that matches your schema and edge cases, then validate it statistically before anyone trains on it.",
    functions: ["chat", "reasoning", "code"],
    models: [M.super, M.ultra],
  }),
  bp({
    id: "realtime-translation",
    name: "Realtime Meeting Translation",
    category: "Agentic AI",
    summary:
      "Live multilingual notes: translate turns, keep names and numbers intact, and produce a summary in each participant's language.",
    functions: ["translate", "chat", "safety"],
    models: [M.translate, M.super, M.safety],
  }),
  bp({
    id: "pose-analytics",
    name: "Pose & Motion Analytics",
    category: "Vision",
    summary:
      "Estimate body pose from video, score movement quality, and generate a coaching report with frame-level evidence.",
    functions: ["pose", "vision", "chat"],
    models: [M.vl, M.super],
  }),
  bp({
    id: "research-copilot",
    name: "Enterprise Knowledge Copilot",
    category: "RAG & Retrieval",
    summary:
      "A copilot over every internal source: docs, tickets, decks, transcripts. Cites the source, flags staleness, and escalates when the answer is not there.",
    functions: ["embedding", "rerank", "chat", "parse", "safety"],
    models: [M.embed, M.rerank, M.super, M.parse],
  }),
  bp({
    id: "always-on-fleet",
    name: "Always-On Agent Fleet",
    category: "Agentic AI",
    summary:
      "Run agents continuously with governed egress, per-agent budgets and a hard stop. The fleet works the backlog while the board sleeps.",
    functions: ["chat", "tools", "reasoning", "safety"],
    models: [M.super, M.ultra, M.safety],
  }),
];

export function listBlueprints({ category = "", query = "" } = {}) {
  const term = query.trim().toLowerCase();
  return BLUEPRINTS.filter((blueprint) => {
    if (category && blueprint.category !== category) return false;
    if (!term) return true;
    return `${blueprint.name} ${blueprint.summary} ${blueprint.category} ${blueprint.functions.join(" ")}`
      .toLowerCase()
      .includes(term);
  });
}

export function getBlueprint(id) {
  return BLUEPRINTS.find((blueprint) => blueprint.id === id) ?? null;
}

/**
 * Reading a plain-English company goal.
 *
 * "Full auto" has to answer one question the user never answers explicitly:
 * *which of the 36 blueprints is this company?* This ranks them by lexical
 * overlap with the goal, weighting the blueprint's name and category highest so
 * "build a support triage copilot" lands on Customer Support rather than a
 * random research blueprint. Pure + deterministic: no model call, same goal
 * always yields the same company.
 */
const GOAL_STOPWORDS = new Set(
  `a an and any are as at be build building built by can company companies create do does for from get give goal has have help how i in into is it its me my need needs of on or our out over that the their them then there these this to under up us use used using want we what when where which who why will with without you your business make making new one team idea please should would could`.split(
    /\s+/,
  ),
);

export function goalTokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((token) => token.length > 2 && !GOAL_STOPWORDS.has(token));
}

/**
 * What a goal is *about*, in the vocabulary people actually type.
 *
 * Lexical overlap alone puts "cut customer support response time" on the
 * knowledge-copilot blueprint because it contains the word "copilot". These
 * hand-curated intents carry the domain signal that word-matching misses, so a
 * full-auto launch lands on a team that fits the brief.
 */
const INTENTS = [
  { blueprint: "contact-center", match: ["support", "helpdesk", "help desk", "ticket", "tickets", "call center", "call centre", "contact center", "customer service", "customer", "deflection", "response time", "voice agent", "csat"] },
  { blueprint: "research-copilot", match: ["knowledge", "copilot", "internal docs", "wiki", "confluence", "citations", "cited", "source of truth", "ask questions", "expert"] },
  { blueprint: "rag-pipeline", match: ["rag", "retrieval", "embedding", "vector", "chunking", "rerank", "semantic search", "search over", "index our"] },
  { blueprint: "aiq-research", match: ["research", "deep research", "literature", "competitive", "market research", "sources", "brief", "report"] },
  { blueprint: "content-factory", match: ["content", "marketing", "copy", "blog", "seo", "social", "campaign", "newsletter", "brand", "product description", "ads"] },
  { blueprint: "loss-prevention", match: ["fraud", "fraud detection", "shrink", "shrinkage", "theft", "loss prevention", "return fraud", "chargeback", "self-checkout"] },
  { blueprint: "shopping-assistant", match: ["shopping", "ecommerce", "e-commerce", "online store", "product catalog", "product recommendations", "add to cart", "shopper"] },
  { blueprint: "personalization", match: ["recommendation", "recommender", "personalization", "personalisation", "recsys", "segment", "churn", "ltv", "sales", "leads", "lead scoring", "crm", "outreach", "upsell", "cross-sell", "revenue"] },
  { blueprint: "deep-agents-code", match: ["code", "coding", "software", "engineering", "developer", "refactor", "pull request", "repo", "typescript", "python", "migration", "bugs"] },
  { blueprint: "cyber-vuln", match: ["security", "vulnerability", "vulnerabilities", "cve", "pentest", "sast", "audit", "threat"] },
  { blueprint: "guardrails", match: ["guardrail", "guardrails", "safety", "moderation", "compliance", "policy", "jailbreak", "red team"] },
  { blueprint: "agent-eval", match: ["evaluation", "evals", "quality", "benchmark", "trace", "accuracy", "regression tests"] },
  { blueprint: "sre-rca", match: ["sre", "incident", "on-call", "outage", "root cause", "observability", "devops", "uptime", "reliability"] },
  { blueprint: "cudf-etl", match: ["etl", "data pipeline", "pipeline", "analytics", "warehouse", "parquet", "spark", "pandas"] },
  { blueprint: "gqe-sql", match: ["sql", "database", "query", "bi", "reporting", "dashboards", "lakehouse"] },
  { blueprint: "document-intelligence", match: ["document", "documents", "invoice", "contract", "pdf", "ocr", "parse", "extraction", "claims", "forms"] },
  { blueprint: "docs-fab", match: ["documentation", "docs", "api docs", "readme", "tech writing", "release notes"] },
  { blueprint: "ambient-clinical", match: ["clinical", "clinician", "patient", "soap note", "scribe", "medical record", "ehr"] },
  { blueprint: "medical-imaging", match: ["imaging", "radiology", "x-ray", "mri", "ct scan", "pathology", "diagnosis"] },
  { blueprint: "drug-discovery", match: ["drug", "molecule", "molecular", "pharma", "compound", "protein ligand", "chemistry", "candidate"] },
  { blueprint: "genomics", match: ["genome", "genomic", "dna", "rna", "sequencing", "variant", "bioinformatics"] },
  { blueprint: "protein-structure", match: ["protein", "structure prediction", "folding", "alphafold", "antibody"] },
  { blueprint: "cuopt-routing", match: ["route", "routing", "logistics", "delivery", "fleet", "dispatch", "drivers", "supply chain", "scheduling"] },
  { blueprint: "smart-warehouse", match: ["warehouse", "inventory", "robotics", "pick", "pack", "fulfillment", "forklift", "stock"] },
  { blueprint: "manufacturing-vision", match: ["manufactur", "factory", "defect", "inspection", "assembly", "quality control", "production line"] },
  { blueprint: "telecom-ran", match: ["telecom", "ran", "5g", "network slicing", "cell tower", "spectrum"] },
  { blueprint: "automotive-perception", match: ["automotive", "vehicle", "autonomous", "adas", "lidar", "driving", "perception"] },
  { blueprint: "climate-forecast", match: ["climate", "weather", "forecast", "storm", "flood", "renewable", "energy", "grid"] },
  { blueprint: "pose-analytics", match: ["pose", "motion", "fitness", "ergonomics", "sports", "safety monitoring", "gesture"] },
  { blueprint: "vss-video-search", match: ["video", "surveillance", "camera", "footage", "cctv", "summarization of video"] },
  { blueprint: "digital-human", match: ["avatar", "digital human", "virtual assistant", "talking head", "tokkio", "virtual agent"] },
  { blueprint: "realtime-translation", match: ["translation", "translate", "multilingual", "meeting notes", "transcription", "subtitles", "language"] },
  { blueprint: "synthetic-data", match: ["synthetic", "data generation", "training data", "augmentation", "privacy", "redaction"] },
  { blueprint: "always-on-fleet", match: ["fleet", "monitoring", "agents at scale", "24/7", "always on", "iot", "telemetry"] },
  { blueprint: "agentic-rag", match: ["agentic", "multi-agent", "orchestration", "tool calls", "planner"] },
];

function intentHits(goal, blueprintId) {
  const text = ` ${String(goal ?? "").toLowerCase().replace(/[^a-z0-9&+.\s-]/g, " ").replace(/\s+/g, " ")} `;
  const hits = [];
  for (const intent of INTENTS) {
    if (intent.blueprint !== blueprintId) continue;
    for (const phrase of intent.match) {
      const needle = ` ${phrase.toLowerCase()} `;
      if (text.includes(needle) || (phrase.length > 5 && text.includes(phrase.toLowerCase()))) hits.push(phrase);
    }
  }
  return [...new Set(hits)];
}

/** When a goal says nothing a blueprint recognises, start from the generalist ops team. */
export const DEFAULT_BLUEPRINT_ID = "always-on-fleet";

export function rankBlueprints(goal, { limit = 6 } = {}) {
  const wanted = new Set(goalTokens(goal));
  const scored = BLUEPRINTS.map((blueprint) => {
    const fields = [
      [3, blueprint.name],
      [2.5, blueprint.category],
      [2.5, (blueprint.functions ?? []).join(" ")],
      [2, blueprint.summary],
      [1.2, blueprint.goal?.title ?? ""],
      [1, (blueprint.backlog ?? []).map((item) => item.title).join(" ")],
      [1, (blueprint.steps ?? []).join(" ")],
    ];
    const perToken = new Map();
    for (const [weight, text] of fields) {
      for (const token of new Set(goalTokens(text))) {
        if (!wanted.has(token)) continue;
        // Cap one token's contribution so a keyword repeated in prose cannot
        // outvote a domain match on the name.
        perToken.set(token, Math.min((perToken.get(token) ?? 0) + weight, 4.5));
      }
    }
    let lexical = 0;
    for (const value of perToken.values()) lexical += value;
    const hits = intentHits(goal, blueprint.id);
    const intentScore = Math.min(hits.length * 7, 14);
    const matched = [...new Set([...perToken.keys(), ...hits])].slice(0, 6);
    return {
      id: blueprint.id,
      name: blueprint.name,
      category: blueprint.category,
      summary: blueprint.summary,
      functions: blueprint.functions ?? [],
      score: Math.round((lexical + intentScore) * 10) / 10,
      matched,
    };
  });
  return scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

export function blueprintCategories() {
  return [...new Set(BLUEPRINTS.map((blueprint) => blueprint.category))].sort();
}

/** Expand a blueprint into agents/goal/backlog specs for a company. */
export function planBlueprint(id, { issuePrefix = "NW" } = {}) {
  const blueprint = getBlueprint(id);
  if (!blueprint) {
    const error = new Error(`Unknown blueprint: ${id}`);
    error.status = 404;
    throw error;
  }
  return {
    blueprint: { id: blueprint.id, name: blueprint.name, summary: blueprint.summary, functions: blueprint.functions },
    goal: { ...blueprint.goal, description: blueprint.summary },
    agents: blueprint.team.map((member) => ({
      name: member.name,
      title: member.title,
      role: member.role,
      model: member.model,
      monthlyBudgetCents: 0, // unlimited by default; member.budget is kept as guidance only
      description: `${blueprint.name} team.`,
      capabilities: blueprint.functions,
      instructions: `You are part of the ${blueprint.name} delivery team. ${blueprint.summary} Work the board, cite evidence, and keep spend inside your cap.`,
    })),
    issues: blueprint.backlog.map((item, index) => ({
      title: item.title,
      priority: item.priority ?? (index === 0 ? "high" : "medium"),
      description: `${blueprint.name} · step ${index + 1}. ${blueprint.steps[index] ?? "Deliver and review."}`,
      labels: [blueprint.category.toLowerCase().replace(/\s+/g, "-"), "blueprint"],
      acceptance: ["Deliverable linked in the issue", "Reviewed by the quality lead", "Numbers shown with a source"],
      source: `blueprint:${blueprint.id}`,
      ownerIndex: index % blueprint.team.length,
      key: `${issuePrefix}-BP${blueprint.id.slice(0, 3).toUpperCase()}${index + 1}`,
    })),
  };
}

export function blueprintStats() {
  const byCategory = {};
  for (const blueprint of BLUEPRINTS) byCategory[blueprint.category] = (byCategory[blueprint.category] ?? 0) + 1;
  return { count: BLUEPRINTS.length, byCategory, categories: blueprintCategories() };
}
