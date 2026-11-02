/**
 * Deterministic NIM simulator.
 *
 * With no API key (or FORCE_SIMULATION=1) every endpoint family is served
 * locally so the clone is fully explorable: agents plan, produce deliverables,
 * review each other, retrieve with real cosine similarity and burn budget in
 * the ledger. Embeddings are hashed bag-of-words vectors, so retrieval and
 * reranking behave like the real thing instead of returning noise.
 *
 * Nothing here pretends to be a language model. Outputs are marked
 * `simulated: true` and every surface in the UI labels them.
 */

/* ---------------------------------------------------------------- helpers */

function hash32(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function rng(seed) {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function pick(list, random) {
  return list[Math.floor(random() * list.length) % list.length];
}

const STOP = new Set(
  "a an and are as at be but by for from has have how i if in into is it its of on or our that the their then there these they this to was we were what when where which who will with you your".split(
    " ",
  ),
);

export function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

export function estimateTokens(text) {
  return Math.max(1, Math.round(String(text ?? "").length / 4));
}

function sentences(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 30);
}

/* ------------------------------------------------------------- embeddings */

const DIMS = 1024;

/** Hashed bag-of-words embedding: shared vocabulary ⇒ high cosine similarity. */
export function embedText(text, dims = DIMS) {
  const vector = new Array(dims).fill(0);
  const words = tokens(text);
  if (!words.length) {
    vector[0] = 1;
    return vector;
  }
  for (const word of words) {
    const base = hash32(word);
    // Two hashes per token (like a signed random projection) reduce collisions.
    const index = base % dims;
    const sign = (hash32(`${word}:sign`) & 1) === 0 ? 1 : -1;
    vector[index] += sign * (1 + Math.log(1 + word.length));
    vector[(base >>> 7) % dims] += sign * 0.5;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Math.round((value / norm) * 1e6) / 1e6);
}

export function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/* ------------------------------------------------------------ completion */

const DELIVERABLE_SECTIONS = [
  ["Objective", (ctx) => `Ship "${ctx.title}" for ${ctx.company}. ${ctx.criteria.length ? `Done means: ${ctx.criteria.join("; ")}.` : "Done means the artefact is reviewable and linked in this issue."}`],
  ["Approach", (ctx) => ctx.bullets.slice(0, 3).map((line, index) => `${index + 1}. ${line}`).join("\n")],
  ["What we did", (ctx) => ctx.bullets.slice(0, 5).map((line) => `- ${line}`).join("\n")],
  ["Numbers", (ctx) => `| Metric | Baseline | Now | Target |\n| --- | --- | --- | --- |\n| ${ctx.metrics[0]} | ${ctx.baseline[0]} | ${ctx.baseline[1]} | ${ctx.baseline[2]} |\n| ${ctx.metrics[1]} | ${ctx.baseline[3]} | ${ctx.baseline[4]} | ${ctx.baseline[5]} |`],
  ["Risks and open questions", (ctx) => ctx.bullets.slice(0, 3).map((line) => `- **${ctx.metrics[0]} risk:** ${line}`).join("\n")],
  ["Next step", (ctx) => `Hand to review with the ${ctx.reviewer} role. If accepted, open the follow-up: ${ctx.next}.`],
];

function contextFrom(prompt, fallback = {}) {
  const titleMatch = prompt.match(/Issue:\s*(.+)/i);
  const companyMatch = prompt.match(/Company:\s*(.+)/i);
  const agentMatch = prompt.match(/Agent:\s*(.+)/i);
  const criteria = [...prompt.matchAll(/^\s*[-*]\s*\[\s\]\s*(.+)$/gm)].map((match) => match[1].trim());
  const knowledge = prompt.match(/<knowledge>([\s\S]*?)<\/knowledge>/);
  const title = titleMatch?.[1]?.trim() ?? "this work item";
  const seed = hash32(title);
  const random = rng(seed);
  const knowledgeSentences = knowledge ? sentences(knowledge[1]) : [];
  const bullets = (knowledgeSentences.length ? knowledgeSentences : sentences(prompt))
    .filter((sentence) => !/^(issue|agent|company):/i.test(sentence))
    .slice(0, 6);
  const filler = [
    "Instrumented the happy path end to end and captured the trace for the review thread.",
    "Cut the manual step down to a single command with a dry-run mode.",
    "Wrote the runbook so on-call can repeat it without asking engineering.",
    "Backfilled the two weeks of missing history so the dashboard is trustworthy.",
    "Added the regression check that would have caught last month's miss.",
    "Documented the failure modes and the rollback path next to the code.",
  ];
  return {
    title,
    company: companyMatch?.[1]?.trim() ?? "the company",
    agent: agentMatch?.[1]?.trim() ?? "the assignee",
    reviewer: pick(["Quality Lead", "Staff Engineer", "Head of Ops"], random),
    criteria,
    next: pick(["a 2-week adoption follow-up", "a pricing test with 50 accounts", "a load test at 3× traffic", "an onboarding checklist update"], random),
    bullets: bullets.length >= 3 ? bullets : [...bullets, ...filler].slice(0, 6),
    metrics: pick(
      [
        ["activation", "cycle time"],
        ["p95 latency", "weekly retention"],
        ["ticket volume", "time to first value"],
        ["trial conversion", "gross margin"],
      ],
      random,
    ),
    baseline: ["18%", "31%", "45%"],
    ...fallback,
  };
}

function deliverable(prompt, random) {
  const ctx = contextFrom(prompt);
  const header = `## ${ctx.title}\n\n_Owner: ${ctx.agent} · Company: ${ctx.company}_.\n`;
  const body = DELIVERABLE_SECTIONS.map(([heading, render]) => `### ${heading}\n${render(ctx)}`).join("\n\n");
  const appendix = ctx.bullets.slice(0, 2).map((line) => `> ${line}`).join("\n");
  return `${header}\n${body}\n\n---\n${appendix}\n`;
}

function plan(prompt) {
  const goalMatch = prompt.match(/Goal:\s*(.+)/i);
  const goal = goalMatch?.[1]?.trim() ?? "Grow the business";
  const random = rng(hash32(goal));
  const open = [...prompt.matchAll(/^\s*\d+\.\s*(.+)$/gm)]
    .map((match) => match[1].trim())
    // Board lines look like "[todo/high] Title — Owner"; the model must echo the bare title.
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, "").replace(/\s+—\s+[^—]*$/, "").trim())
    .filter(Boolean)
    .slice(0, 8);
  const focus = pick(
    [
      "Unblock revenue: finish the two activation fixes and ship pricing this cycle.",
      "Cut cycle time in half before adding scope.",
      "Convert the strongest signal in the backlog into a measurable experiment.",
      "Protect quality: close the review debt, then take one bet.",
    ],
    random,
  );
  const assignments = (open.length ? open : ["Draft the plan", "Run the experiment", "Review the result"]).map((title, index) => ({
    title,
    owner: ["Strategist", "Operator", "Analyst", "Critic"][index % 4],
    why: pick(
      [
        "Highest expected impact on the goal and cheapest to validate.",
        "Removes a dependency that three other items are blocked on.",
        "Turns an ambiguous goal into something the board can accept.",
        "The evidence is already in the knowledge base — this is execution, not discovery.",
      ],
      random,
    ),
    priority: index === 0 ? "high" : index < 3 ? "medium" : "low",
  }));
  return JSON.stringify(
    {
      focus,
      rationale: `The goal "${goal}" is currently limited by unvalidated demand and review debt. This cycle converts both into evidence the board can act on, and keeps spend inside the monthly cap.`,
      assignments,
      risks: [
        "Model spend can outrun the monthly cap if every issue is retried twice.",
        "A quality gate that is too strict will stall the cycle on wording, not substance.",
        "Without a metric owner the results will not be trusted next cycle.",
      ],
      citations: ["knowledge/company-brief.md", "issues/backlog", "ledger/this-month"],
    },
    null,
    2,
  );
}

function review(prompt) {
  const ctx = contextFrom(prompt);
  const attempt = Number(prompt.match(/Review attempt:\s*(\d+)/i)?.[1] ?? 1);
  const random = rng(hash32(`${ctx.title}:review:${attempt}`));
  // First pass usually needs one round of evidence; a rework should pass.
  const score = attempt > 1 ? 80 + Math.floor(random() * 16) : 62 + Math.floor(random() * 33);
  const verdict = score >= 78 ? "accepted" : "changes_requested";
  return JSON.stringify(
    {
      verdict,
      score,
      summary:
        verdict === "accepted"
          ? `Meets the definition of done for "${ctx.title}". Evidence is specific and the numbers line up with the ledger.`
          : `Close, but "${ctx.title}" needs a tighter evidence trail before it can be accepted.`,
      findings: [
        {
          severity: "minor",
          finding: "Claims are correct but two of them lack a source link.",
          fix: "Link the dashboard and the experiment record inline.",
        },
        {
          severity: verdict === "accepted" ? "nit" : "major",
          finding: "The success metric is stated but no baseline is shown.",
          fix: `Add the pre-change value next to the target (baseline ${ctx.baseline[0]}).`,
        },
      ],
      follow_ups: [ctx.next],
    },
    null,
    2,
  );
}

function triage(prompt) {
  const random = rng(hash32(prompt.slice(0, 120)));
  const titles = [...prompt.matchAll(/^\s*[-*]\s+(?:#?\d+\s+)?(.{8,90})$/gm)].map((m) => m[1].trim()).slice(0, 5);
  return JSON.stringify(
    {
      summary: pick(
        [
          "Two items are ready to start; one is blocked on access; the rest need a decision from the board.",
          "Nothing is on fire. The highest-leverage move is finishing the item already in progress.",
          "The queue is healthy but two items have drifted from their definition of done.",
        ],
        random,
      ),
      blockers: ["Need production read access for the operator", "Approval pending on the public announcement"],
      recommended: (titles.length ? titles : ["Close the review debt"]).map((title) => ({ title, why: "Closest to done with the smallest spend." })),
    },
    null,
    2,
  );
}

function genericChat(prompt, { system = "" } = {}) {
  const question = prompt.trim().split("\n").filter(Boolean).at(-1) ?? "your question";
  const random = rng(hash32(`${system}:${question}`));
  const knowledge = prompt.match(/<knowledge>([\s\S]*?)<\/knowledge>/);
  const cites = knowledge ? sentences(knowledge[1]).slice(0, 3) : [];
  const opener = pick(
    [
      `Short answer: yes — with one caveat worth writing down.`,
      `Here is the version I would put in front of the board.`,
      `I checked the material we already have on this before answering.`,
      `Two things matter here, and they pull in different directions.`,
    ],
    random,
  );
  const body = cites.length
    ? cites.map((sentence) => `- ${sentence}`).join("\n")
    : "- The evidence we have is directionally right but thin on the counterfactual.\n- The cheapest next step is a two-week test with a single success metric.\n- If the metric moves, fund the follow-up; if it does not, stop.";
  return `${opener}\n\n**What the record says**\n${body}\n\n**What I would do**\n1. Name the metric and the owner before spending another token.\n2. Ship the smallest version that can fail.\n3. Bring the number back to this thread, not a slide deck.\n\n_Answering "${question.replace(/\s+/g, " ").slice(0, 120)}"._`;
}

function standup(prompt) {
  const focus = prompt.match(/Focus:\s*(.+)/i)?.[1]?.trim() ?? "Keep the board moving.";
  const blockedMatch = prompt.match(/Open blocked:\s*(.+)/i);
  const blockedList = (blockedMatch?.[1] ?? "none")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry && entry !== "none");

  let results = [];
  const resultsStart = prompt.search(/Results:\s*/i);
  if (resultsStart !== -1) {
    const after = prompt.slice(resultsStart).replace(/^Results:\s*/i, "");
    const blockedAt = after.search(/\n\s*Open blocked:/i);
    const raw = (blockedAt === -1 ? after : after.slice(0, blockedAt)).trim();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) results = parsed;
    } catch {
      results = [];
    }
  }

  const accepted = results.filter((row) => row.verdict === "accepted" || (row.status === "done" && !row.verdict));
  const returned = results.filter((row) => row.verdict && row.verdict !== "accepted");
  const broken = results.filter((row) => row.error || row.blocked);
  const spent = results.reduce((sum, row) => sum + (Number(row.costCents) || 0), 0);

  const shippedLines = accepted.length
    ? accepted.map((row) => `- ${row.key ?? row.issueId} accepted${row.costCents != null ? ` ($${Number(row.costCents).toFixed(2)})` : ""}.`)
    : ["- Nothing cleared the quality gate this cycle."];
  const returnedLines = returned.length
    ? returned.map((row) => `- ${row.key ?? row.issueId} — the gate wants ${row.verdict === "changes_requested" ? "more evidence" : row.verdict}.`)
    : ["- Nothing came back for rework."];
  const blockedLines = blockedList.length ? blockedList.map((key) => `- ${key} is still blocked and needs a human.`) : ["- Nothing is blocked."];
  const next = returned.length
    ? `Re-run ${returned.map((row) => row.key ?? row.issueId).join(", ")} with the missing number in the body.`
    : accepted.length
      ? `Take the next item that moves “${focus.replace(/\.$/, "")}”.`
      : "Plan one smaller issue that can clear the gate in a single pass.";

  return [
    "## Cycle standup",
    "",
    `**Focus:** ${focus}`,
    "",
    "**Shipped**",
    ...shippedLines,
    "",
    "**Returned for evidence**",
    ...returnedLines,
    "",
    "**Blocked**",
    ...blockedLines,
    ...(broken.length ? ["", "**Errors**", ...broken.map((row) => `- ${row.key ?? row.issueId}: ${row.error ?? "blocked by policy"}.`)] : []),
    "",
    `**Cost:** $${spent.toFixed(2)} across ${results.length} run${results.length === 1 ? "" : "s"}.`,
    "",
    "**Next cycle**",
    `- ${next}`,
  ].join("\n");
}

function sectionMode(system, prompt, wantsJson) {
  // Explicit markers win: substring matching on role descriptions is too eager
  // (a prompt that merely mentions "Ops Scribe" must not become a standup).
  const marker = system.match(/Task type:\s*(\w+)/i)?.[1]?.toLowerCase();
  if (marker === "plan") return plan;
  if (marker === "review") return review;
  if (marker === "standup") return standup;
  if (marker === "triage") return triage;
  if (marker === "deliverable") return deliverable;
  if (marker === "chat") return null;
  if (wantsJson || /json/i.test(system)) {
    if (/review|verdict/i.test(system)) return review;
    if (/plan|strateg|assign/i.test(system)) return plan;
    if (/triage|summary/i.test(system)) return triage;
  }
  if (/standup|scribe/i.test(system)) return standup;
  if (/deliverable/i.test(system) || /definition of done/i.test(prompt)) return deliverable;
  return null;
}

export function simChat({
  model,
  messages = [],
  responseFormat,
  temperature = 0.4,
  seed,
  tools,
  simulateToolCall = false,
  signal,
} = {}) {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const prompt = typeof lastUser?.content === "string"
    ? lastUser.content
    : (lastUser?.content ?? []).map((part) => part.text ?? "").join("\n");
  const wantsJson = responseFormat?.type === "json_object" || responseFormat?.type === "json_schema";
  const renderer = sectionMode(system, prompt, wantsJson);
  const random = rng(hash32(`${seed ?? ""}:${model}:${prompt.slice(0, 200)}`));
  let text = renderer ? renderer(prompt) : genericChat(prompt, { system });

  let toolCalls = [];
  if (tools?.length && simulateToolCall && !wantsJson) {
    // One deterministic tool hop: retrieval first, then a written answer.
    const tool = tools.find((entry) => /retriev|search|knowledge/i.test(entry.function?.name ?? "")) ?? tools[0];
    if (tool && !/TOOL_RESULT/.test(prompt)) {
      const name = tool.function?.name ?? "tool";
      const cleaned = prompt.replace(/<knowledge>[\s\S]*?<\/knowledge>/g, " ").replace(/\s+/g, " ").trim();
      const subject = cleaned.match(/Issue:[^—\n]*—\s*([^\n]{8,100})/)?.[1]?.trim();
      const args = /retriev|search|knowledge/.test(name)
        ? { query: subject || cleaned.slice(0, 140) || "company goals" }
        : {};
      toolCalls = [{ id: `call_${hash32(prompt).toString(16)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
      text = "";
    }
  }

  const reasoning = /reason|ultra|thinking/i.test(model) && !toolCalls.length
    ? `Considered ${1 + (hash32(prompt) % 3)} approaches. Rejected the broadest one because it cannot be validated this cycle; kept the option with an existing baseline.`
    : "";

  const promptTokens = estimateTokens(`${system}\n${prompt}`);
  const completionTokens = estimateTokens(`${text}${reasoning}`);
  return {
    simulated: true,
    model,
    text,
    reasoning,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
    latencyMs: 380 + (hash32(prompt) % 900),
  };
}

export function simStream(options, onDelta) {
  const result = simChat(options);
  const chunks = (result.text || result.reasoning || "").match(/\S+\s*/g) ?? [];
  for (const chunk of chunks) onDelta(chunk);
  return result;
}

export function simComplete({ model, prompt }) {
  const text = genericChat(prompt, { system: "complete" });
  return {
    simulated: true,
    model,
    text,
    usage: { prompt_tokens: estimateTokens(prompt), completion_tokens: estimateTokens(text) },
    latencyMs: 240,
  };
}

export function simEmbed({ model, inputs }) {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  return {
    simulated: true,
    model,
    vectors: list.map((text) => embedText(text)),
    usage: { prompt_tokens: list.reduce((sum, text) => sum + estimateTokens(text), 0) },
    latencyMs: 60 + list.length * 4,
  };
}

export function simRerank({ model, query, passages, topN }) {
  const queryWords = new Set(tokens(query));
  const scored = passages.map((passage, index) => {
    const words = tokens(passage);
    const overlap = words.filter((word) => queryWords.has(word)).length;
    const coverage = queryWords.size ? overlap / queryWords.size : 0;
    const density = words.length ? overlap / Math.sqrt(words.length) : 0;
    const score = Math.min(0.99, 0.15 + coverage * 0.6 + density * 0.12);
    return { index, score: Math.round(score * 1e4) / 1e4, passage };
  });
  scored.sort((a, b) => b.score - a.score);
  const rankings = scored.slice(0, topN ?? passages.length).map((row, rank) => ({ ...row, rank: rank + 1 }));
  return { simulated: true, model, rankings, usage: { prompt_tokens: estimateTokens(`${query}${passages.join(" ")}`) }, latencyMs: 90 };
}

/** A generated artifact that is real (viewable SVG), deterministic, and local. */
export function simImage({ model, prompt, width = 1024, height = 1024, seed }) {
  const random = rng(hash32(`${prompt}:${seed ?? ""}`));
  const hue = Math.floor(random() * 360);
  const hue2 = (hue + 40 + Math.floor(random() * 120)) % 360;
  const blobs = Array.from({ length: 7 }, (_, index) => {
    const cx = Math.floor(random() * width);
    const cy = Math.floor(random() * height);
    const r = Math.floor((0.08 + random() * 0.22) * Math.min(width, height));
    const opacity = (0.18 + random() * 0.4).toFixed(2);
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${(hue + index * 29) % 360} 82% ${52 + index * 3}%)" opacity="${opacity}"/>`;
  }).join("");
  const safe = String(prompt ?? "").replace(/[<>&]/g, "").slice(0, 140);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 68% 12%)"/><stop offset="1" stop-color="hsl(${hue2} 74% 28%)"/></linearGradient>
<filter id="blur"><feGaussianBlur stdDeviation="${Math.round(Math.min(width, height) / 26)}"/></filter></defs>
<rect width="${width}" height="${height}" fill="url(#bg)"/><g filter="url(#blur)">${blobs}</g>
<text x="${Math.round(width * 0.06)}" y="${Math.round(height * 0.9)}" font-family="system-ui,sans-serif" font-size="${Math.round(width / 30)}" fill="rgba(255,255,255,0.9)">${safe}</text>
</svg>`;
  return {
    simulated: true,
    model,
    artifacts: [
      {
        base64: Buffer.from(svg).toString("base64"),
        mimeType: "image/svg+xml",
        width,
        height,
        seed: seed ?? hash32(prompt) % 1e6,
      },
    ],
    usage: { images: 1 },
    latencyMs: 900,
  };
}

export function simSafety({ model, text }) {
  const risky = /(kill|weapon|exploit|malware|self-harm|suicide|bomb|leak the key|social security)/i.test(text);
  return {
    simulated: true,
    model,
    verdict: risky ? "unsafe" : "safe",
    categories: risky ? ["harm"] : [],
    score: risky ? 0.91 : 0.04,
    rationale: risky
      ? "Request contains language matching the harm taxonomy, so it is blocked before an agent sees it."
      : "No policy category matched at the configured threshold.",
    usage: { prompt_tokens: estimateTokens(text) },
    latencyMs: 70,
  };
}

export function simParse({ model, prompt }) {
  return {
    simulated: true,
    model,
    text: `# Extracted document\n\n## Page 1\n\n| Column A | Column B | Column C |\n| --- | --- | --- |\n| Invoice | 2026-04-02 | $18,400.00 |\n| Period | Q2 | Net 30 |\n\n> ${String(prompt ?? "Document text").slice(0, 160)}\n\n**Layout:** 2 columns, 1 table, 1 heading, 0 figures.`,
    usage: { prompt_tokens: 1024 },
    latencyMs: 640,
  };
}

export function simTranslate({ model, text, target = "es" }) {
  const translated = `[${target}] ${text}`;
  return {
    simulated: true,
    model,
    text: translated,
    usage: { prompt_tokens: estimateTokens(text), completion_tokens: estimateTokens(translated) },
    latencyMs: 260,
    note: "Simulator echoes the source text with a language tag; connect a key for real translation.",
  };
}

export function simBiology({ model, task }) {
  return {
    simulated: true,
    model,
    task,
    result: {
      sequences: [{ id: "sim-1", sequence: "MKTAYIAKQRQISFVKSHFSRQLEERLGLIEVQ", score: 0.87 }],
      metrics: { plddt: 88.4, ptm: 0.79 },
      note: "Deterministic placeholder structure. Real BioNeMo NIMs return PDB/mmCIF or embeddings.",
    },
    latencyMs: 1200,
  };
}

export function simModels() {
  return { object: "list", data: [] };
}
