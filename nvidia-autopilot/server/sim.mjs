/**
 * Offline NIM simulator.
 *
 * Lets the entire product — including auto mode — be exercised with no API key
 * and no GPU. Every response is deterministic for the same input so runs are
 * reproducible. Responses are clearly labelled as simulated by the server and
 * the UI; this file never claims to be a real model.
 */

const SIMULATED_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3-nano-30b-a3b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3.5-bolt-e4b",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
  "nvidia/llama-3.2-nv-embedqa-1b-v2",
  "nvidia/llama-nemotron-embed-1b-v2",
  "nvidia/llama-3.2-nv-rerankqa-1b-v2",
  "nvidia/llama-nemotron-rerank-1b-v2",
  "nvidia/llama-3.1-nemotron-safety-guard-8b-v3",
  "nvidia/llama-3.1-nemoguard-8b-content-safety",
  "nvidia/nemoguard-jailbreak-detect",
  "nvidia/gliner-pii",
  "meta/llama-3.3-70b-instruct",
  "deepseek-ai/deepseek-v4-pro",
  "deepseek-ai/deepseek-v4-flash",
  "qwen/qwen3-next-80b-a3b-instruct",
  "moonshotai/kimi-k2-instruct",
  "openai/gpt-oss-120b",
  "mistralai/mistral-nemotron",
  "stabilityai/stable-diffusion-3-medium",
  "black-forest-labs/flux.1-dev",
];

function sleepSync(ms) {
  // Only used by the simulator (tests / demos) to model real latency.
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

function hash(text) {
  let value = 2166136261;
  for (const char of String(text)) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function seeded(seed) {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
}

function lastUser(messages = []) {
  return [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
}

function asText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join(" ")
      .trim();
  }
  return "";
}

function sentences(text) {
  return asText(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => sentence.length > 24)
    .slice(0, 6);
}

function keywordList(text) {
  const stop = new Set(
    "the a an and or of to in for with on at by from that this it is are be as our we you your their".split(" "),
  );
  const counts = new Map();
  for (const word of asText(text).toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);
}

function readIntent(options = {}) {
  return options.intent || options.meta?.intent || "chat";
}

function jsonBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function planJson(prompt) {
  const goal = cleanGoal(prompt);
  const focus = keywordList(goal);
  const themes = focus.length ? focus : ["strategy", "delivery", "measurement"];
  const tasks = [
    {
      title: `Frame the problem: ${titleCase(themes[0] ?? "opportunity")} baseline and success metrics`,
      owner: "analyst",
      dependsOn: [],
      doneWhen: "A baseline memo with 3 quantified KPIs and named data sources exists.",
      risk: "low",
      effort: "S",
    },
    {
      title: `Design the ${titleCase(themes[1] ?? "delivery")} playbook`,
      owner: "operator",
      dependsOn: [1],
      doneWhen: "A step-by-step playbook with owners, timelines and required inputs is saved.",
      risk: "medium",
      effort: "M",
    },
    {
      title: `Produce the first ${titleCase(themes[2] ?? "execution")} deliverable`,
      owner: "operator",
      dependsOn: [2],
      doneWhen: "A customer-ready asset exists and passes the quality review rubric.",
      risk: "medium",
      effort: "M",
    },
    {
      title: "Quantify impact and cost envelope",
      owner: "analyst",
      dependsOn: [1],
      doneWhen: "Modelled base/upside scenarios with explicit assumptions and cost per outcome.",
      risk: "low",
      effort: "S",
    },
    {
      title: "Red-team the plan and record risks",
      owner: "critic",
      dependsOn: [3, 4],
      doneWhen: "Every high-risk item has a mitigation owner, and go/no-go criteria are written.",
      risk: "high",
      effort: "S",
    },
  ];
  return {
    objective: goal || "Execute the stated company goal",
    summary: `Plan for "${truncate(goal || "the company goal", 160)}" built from ${themes.join(", ")}.`,
    kpis: [
      { name: `Qualified pipeline attributed to ${themes[0] ?? "the initiative"}`, target: "+20% in 60 days", measure: "CRM attribution report" },
      { name: "Cycle time from brief to shipped asset", target: "<= 5 working days", measure: "Run timeline in Autopilot" },
      { name: "Cost per delivered outcome", target: "Down 15% vs. baseline", measure: "Token + labour cost ledger" },
    ],
    assumptions: [
      "Existing company knowledge is representative and up to date.",
      "No new headcount is available in the first cycle.",
      "Spend above the configured approval threshold needs a human decision.",
    ],
    tasks,
    successCriteria: "Every task's definition of done is met and the executive report is approved by a human reviewer.",
  };
}

function critiqueJson(prompt) {
  const text = asText(prompt);
  const weak = text.length < 400 || /todo|tbd|placeholder|lorem/i.test(text);
  return {
    verdict: weak ? "revise" : "pass",
    score: weak ? 58 : 86,
    strengths: weak
      ? ["Structure is present and scoped to the task."]
      : ["Directly addresses the definition of done.", "Concrete, actionable, and grounded in the provided context."],
    gaps: weak
      ? [
          "Deliverable is thin relative to the definition of done.",
          "Several sections read as placeholders rather than decisions.",
        ]
      : ["Minor: add an explicit owner and a review date to the hand-off section."],
    requiredChanges: weak
      ? ["Expand each section with specifics, numbers and owners.", "Remove all placeholder text."]
      : [],
  };
}

function safetyJson(prompt) {
  const text = asText(prompt).toLowerCase();
  const risky = /(bomb|weapon|malware|ransomware|credit card dump|kill|suicide|exploit code)/.test(text);
  return {
    "User Safety": risky ? "unsafe" : "safe",
    "Response Safety": risky ? "unsafe" : "safe",
    "Safety Categories": risky ? "Violence, Criminal Planning" : "",
    reason: risky ? "Request maps to a restricted safety category." : "No restricted content categories detected.",
    policy: "NVIDIA NeMo Guardrails (simulated)",
  };
}

function reportMarkdown(prompt) {
  const goal = cleanGoal(prompt);
  return [
    `# Executive report`,
    "",
    `**Goal:** ${goal || "Company goal"}`,
    "",
    "## Outcome",
    "The autopilot completed the planned work items, produced reviewable deliverables, and logged every model call, tool invocation and guardrail decision.",
    "",
    "## What shipped",
    "- A quantified baseline memo and success metrics.",
    "- A delivery playbook with owners and sequencing.",
    "- A customer-ready asset that passed quality review.",
    "- A risk register with mitigations and go/no-go criteria.",
    "",
    "## KPIs",
    "| KPI | Target | Status |",
    "| --- | --- | --- |",
    "| Qualified pipeline | +20% in 60 days | On track |",
    "| Brief-to-ship cycle time | <= 5 working days | On track |",
    "| Cost per outcome | -15% | Watch |",
    "",
    "## Decisions needed from a human",
    "1. Approve the budget envelope for cycle two.",
    "2. Confirm the owner for the risk register mitigations.",
    "",
    "## Next actions",
    "- Convert the playbook into dated work items with named owners.",
    "- Re-run this goal weekly; compare KPI movement against the baseline.",
    "",
    "> Generated in simulation mode. Connect an NVIDIA API key for real inference.",
  ].join("\n");
}

function operatorMarkdown(prompt) {
  const goal = cleanGoal(prompt);
  const focus = keywordList(goal);
  return [
    `## Deliverable: ${truncate(goal || "Work item", 90)}`,
    "",
    "### Context",
    `Grounded in the company knowledge base and the plan's definition of done. Primary themes: ${(focus.length ? focus : ["delivery", "measurement"]).join(", ")}.`,
    "",
    "### Decisions",
    "1. Ship the smallest complete asset that satisfies the definition of done.",
    "2. Instrument the outcome so the next cycle can compare against the baseline.",
    "3. Escalate anything requiring spend above the approval threshold.",
    "",
    "### Execution",
    "| Step | Owner | Output |",
    "| --- | --- | --- |",
    "| Scope | Operator | One-page brief |",
    "| Build | Operator | Asset draft |",
    "| Review | Critic | Pass with minor notes |",
    "",
    "### Definition of done check",
    "- [x] Asset exists and is saved to the run workspace.",
    "- [x] Metrics and owners are explicit.",
    "- [x] No restricted content flagged by guardrails.",
    "",
    "### Hand-off",
    "Owner: delivery lead · Review cadence: weekly · Next milestone: first outcome measurement.",
  ].join("\n");
}

function analystMarkdown(prompt) {
  const goal = cleanGoal(prompt);
  return [
    `## Research memo`,
    "",
    `**Question:** ${truncate(goal || "Baseline and metrics", 140)}`,
    "",
    "### What the knowledge base says",
    ...(sentences(goal).length
      ? sentences(goal).map((sentence) => `- ${sentence}`)
      : ["- No company documents matched; assumptions are stated explicitly below."]),
    "",
    "### Baseline",
    "| Metric | Current | Target | Source |",
    "| --- | --- | --- | --- |",
    "| Pipeline quality | Unmeasured | +20% | CRM (assumption) |",
    "| Cycle time | 9 days | <= 5 days | Run history |",
    "| Cost per outcome | Index 100 | 85 | Finance ledger |",
    "",
    "### Assumptions",
    "- Figures marked (assumption) require confirmation before external use.",
    "",
    "### Recommendation",
    "Proceed, but instrument the baseline this week so cycle two can be measured.",
  ].join("\n");
}

function strategistMarkdown(prompt) {
  const goal = cleanGoal(prompt);
  return [
    `## Strategy brief`,
    "",
    `**Goal:** ${truncate(goal, 160)}`,
    "",
    "1. **Where to play** — narrow to the segment with the shortest path to measurable proof.",
    "2. **How to win** — ship a complete, reviewable asset per cycle instead of a broad campaign.",
    "3. **What to measure** — pipeline quality, cycle time, cost per outcome.",
    "4. **What to stop** — work that cannot be tied to one of the three KPIs.",
    "",
    "Guardrails: escalate spend, legal claims and public announcements to a human.",
  ].join("\n");
}

function chatMarkdown(prompt, model) {
  const message = asText(prompt);
  const focus = keywordList(message);
  return [
    `**Simulated response** from \`${model}\` (no API key configured).`,
    "",
    message
      ? `You asked: "${truncate(message, 220)}".`
      : "Start a conversation by sending a message.",
    "",
    focus.length
      ? `Key concepts detected: ${focus.map((word) => `\`${word}\``).join(", ")}.`
      : "No distinctive concepts detected.",
    "",
    "With a real key this call hits `POST /v1/chat/completions` on `integrate.api.nvidia.com`, streams tokens back over SSE, and reports usage for cost tracking.",
  ].join("\n");
}

function titleCase(text) {
  return String(text).replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

function cleanGoal(prompt) {
  const raw = asText(prompt);
  const match = raw.match(/(?:goal|objective)\s*:\s*([\s\S]{3,600})/i);
  const value = (match?.[1] ?? raw).replace(/\s+/g, " ").trim();
  return truncate(value, 300);
}

function truncate(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 1))}…` : value;
}

function simulatedContent({ messages, model, options }) {
  const intent = readIntent(options);
  const prompt = asText(lastUser(messages));
  switch (intent) {
    case "plan":
      return jsonBlock(planJson(prompt));
    case "critique":
      return jsonBlock(critiqueJson(prompt));
    case "safety":
      return JSON.stringify(safetyJson(prompt));
    case "report":
      return reportMarkdown(prompt);
    case "operator":
      return operatorMarkdown(prompt);
    case "analyst":
      return analystMarkdown(prompt);
    case "strategist":
      return strategistMarkdown(prompt);
    default:
      if (/reply with json|respond with json|json only/i.test(prompt)) {
        return jsonBlock({ simulated: true, intent, summary: truncate(prompt, 200) });
      }
      return chatMarkdown(prompt, model);
  }
}

function estimateTokens(text) {
  return Math.max(1, Math.round(String(text ?? "").length / 4));
}

export const simulatedModels = SIMULATED_MODELS;

export function simChat({ model, messages = [], tools = [], options = {} }) {
  const content = simulatedContent({ messages, model, options });
  const delay = Number(process.env.NIM_SIM_DELAY_MS ?? 0);
  if (delay > 0) sleepSync(delay);
  const promptTokens = estimateTokens(messages.map((message) => asText(message.content)).join(" "));
  const completionTokens = estimateTokens(content);
  const alreadyUsedTools = messages.some((message) => message.role === "tool" || message.role === "assistant" && Array.isArray(message.tool_calls));
  const wantsTools =
    tools.length > 0 && options.intent === "operator" && options.allowToolCalls !== false && !alreadyUsedTools;
  const toolCall = wantsTools
    ? {
        id: `call_${hash(content).toString(16).slice(0, 8)}`,
        type: "function",
        function: {
          name: options.simToolName ?? "search_knowledge",
          arguments: JSON.stringify({ query: cleanGoal(asText(lastUser(messages))) || "company context" }),
        },
      }
    : null;
  const message = toolCall
    ? { role: "assistant", content: "", tool_calls: [toolCall] }
    : { role: "assistant", content };
  return {
    id: `chatcmpl-sim-${hash(content).toString(16)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    simulated: true,
    choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export function simEmbed({ model, input }) {
  const inputs = Array.isArray(input) ? input : [input];
  const data = inputs.map((text, index) => {
    const random = seeded(hash(`${model}:${text}`));
    const dimensions = 1024;
    const vector = Array.from({ length: dimensions }, () => Number((random() * 2 - 1).toFixed(4)));
    return { object: "embedding", index, embedding: vector };
  });
  const tokens = inputs.reduce((sum, text) => sum + estimateTokens(text), 0);
  return {
    object: "list",
    data,
    model,
    simulated: true,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
}

export function simRerank({ model, query, passages }) {
  const terms = new Set(keywordList(query));
  const rankings = passages
    .map((passage, index) => {
      const text = typeof passage === "string" ? passage : passage?.text ?? "";
      const words = keywordList(text);
      const overlap = words.filter((word) => terms.has(word)).length;
      const density = words.length ? overlap / Math.max(1, words.length) : 0;
      return { index, logit: Number((overlap * 0.75 + density).toFixed(4)) };
    })
    .sort((a, b) => b.logit - a.logit);
  return { model, simulated: true, rankings, usage: { prompt_tokens: estimateTokens(query), total_tokens: estimateTokens(query) } };
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function simImage({ prompt, width = 1024, height = 1024, model }) {
  const safe = escapeXml(truncate(prompt || "NVIDIA autopilot generated visual", 180));
  const words = String(prompt || "visual").split(/\s+/).slice(0, 8);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#07130a"/>
      <stop offset="55%" stop-color="#0b1f12"/>
      <stop offset="100%" stop-color="#050807"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="42%" r="55%">
      <stop offset="0%" stop-color="#76b900" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#76b900" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect width="100%" height="100%" fill="url(#glow)"/>
  <g fill="none" stroke="#76b900" stroke-opacity="0.35" stroke-width="2">
    <circle cx="${width / 2}" cy="${height * 0.42}" r="${width * 0.18}"/>
    <circle cx="${width / 2}" cy="${height * 0.42}" r="${width * 0.28}"/>
    <circle cx="${width / 2}" cy="${height * 0.42}" r="${width * 0.38}"/>
  </g>
  <text x="50%" y="${height * 0.42}" fill="#eaffd0" font-family="ui-sans-serif, system-ui" font-size="${Math.round(width * 0.045)}" text-anchor="middle" font-weight="700">SIMULATED IMAGE</text>
  <text x="50%" y="${height * 0.5}" fill="#9dc46a" font-family="ui-monospace, monospace" font-size="${Math.round(width * 0.022)}" text-anchor="middle">${escapeXml(model ?? "nvidia image model")}</text>
  <foreignObject x="${width * 0.1}" y="${height * 0.56}" width="${width * 0.8}" height="${height * 0.3}">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:ui-sans-serif,system-ui;font-size:${Math.round(width * 0.026)}px;line-height:1.4;color:#cfe6b0;text-align:center;">${escapeXml(safe)}<br/><span style="opacity:.6;font-size:${Math.round(width * 0.02)}px;">words: ${escapeXml(words.join(" · "))}</span></div>
  </foreignObject>
</svg>`;
  return {
    model,
    simulated: true,
    artifacts: [{ base64: Buffer.from(svg, "utf8").toString("base64"), mimeType: "image/svg+xml" }],
  };
}

export function simModels() {
  return {
    object: "list",
    simulated: true,
    data: SIMULATED_MODELS.map((id) => ({
      id,
      object: "model",
      owned_by: id.split("/")[0],
      created: 1_700_000_000,
    })),
  };
}

/** Deterministic pseudo-stream used to exercise SSE plumbing offline. */
export async function* simChatStream({ model, messages = [], options = {} }) {
  const content = simulatedContent({ messages, model, options });
  for (const chunk of content.match(/[\s\S]{1,18}/g) ?? []) {
    yield { type: "delta", content: chunk };
    await new Promise((resolve) => setTimeout(resolve, 8));
  }
  const response = simChat({ model, messages: [{ role: "user", content: "" }], tools: [], options: { intent: "none" } });
  yield { type: "usage", usage: response.usage };
  yield { type: "done", finishReason: "stop" };
}
