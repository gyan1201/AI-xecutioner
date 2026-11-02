/**
 * NVIDIA NIM model catalog.
 *
 * Source of truth is the hosted API (`GET /v1/models`, 85 models at snapshot
 * time). That list is merged in at runtime by `mergeLive()`; the table below
 * carries what the API does not return — modality, capability family, context
 * window and list rates — so routing, costing and the UI work before (and
 * without) a network round-trip.
 *
 * Capability flags:
 *   c chat · v vision · r reasoning · t tool calling · o code · e embedding
 *   k rerank · i image generation · d video · s safety · p document parse
 *   x translate · b biomolecular · w reward · u tabular · z pose
 */

export const CAPABILITIES = {
  chat: { label: "Chat", flag: "c", endpoint: "/chat/completions", blurb: "Multi-turn text generation." },
  vision: { label: "Vision", flag: "v", endpoint: "/chat/completions", blurb: "Image + text in, text out." },
  reasoning: { label: "Reasoning", flag: "r", endpoint: "/chat/completions", blurb: "Deliberate thinking traces and plans." },
  tools: { label: "Tool calling", flag: "t", endpoint: "/chat/completions", blurb: "OpenAI-style function calling." },
  code: { label: "Code", flag: "o", endpoint: "/chat/completions", blurb: "Code generation and review." },
  embedding: { label: "Embeddings", flag: "e", endpoint: "/embeddings", blurb: "Dense vectors for retrieval, clustering." },
  rerank: { label: "Reranking", flag: "k", endpoint: "/ranking", blurb: "Cross-encoder ordering of candidates." },
  image: { label: "Image gen", flag: "i", endpoint: "/genai/{model}", blurb: "Text-to-image and image edits." },
  video: { label: "Video gen", flag: "d", endpoint: "/genai/{model}", blurb: "Text/image-to-video artifacts." },
  safety: { label: "Safety", flag: "s", endpoint: "/chat/completions", blurb: "Guardrail and content-safety verdicts." },
  parse: { label: "Doc parse", flag: "p", endpoint: "/chat/completions", blurb: "OCR, tables and layout from page images." },
  translate: { label: "Translation", flag: "x", endpoint: "/chat/completions", blurb: "Multilingual translation." },
  protein: { label: "Biomolecular", flag: "b", endpoint: "/biology/*", blurb: "Protein, DNA and molecule generation." },
  reward: { label: "Reward", flag: "w", endpoint: "/chat/completions", blurb: "Scores candidate responses." },
  tabular: { label: "Tabular", flag: "u", endpoint: "/chat/completions", blurb: "In-context learning over tables." },
  pose: { label: "Pose", flag: "z", endpoint: "/genai/{model}", blurb: "Body pose and skeleton estimation." },
};

export const FLAG_TO_CAPABILITY = Object.fromEntries(
  Object.entries(CAPABILITIES).map(([key, meta]) => [meta.flag, key]),
);

const RATE = {
  small: { in: 0.06, out: 0.22 },
  mid: { in: 0.2, out: 0.8 },
  large: { in: 0.9, out: 2.7 },
  ultra: { in: 1.8, out: 4.5 },
  embed: { in: 0.02, out: 0 },
  rerank: { in: 0.05, out: 0 },
  image: { in: 0, out: 0, perImage: 0.012 },
  video: { in: 0, out: 0, perImage: 0.09 },
};

function titleFromId(id) {
  const slug = id.split("/")[1] ?? id;
  return slug
    .replace(/-/g, " ")
    .replace(/\b(\d+(?:\.\d+)?[bmk])\b/gi, (m) => m.toUpperCase())
    .replace(/\b(gpt|oss|vlm|vl|asr|tts|ocr|moe|nim|llm)\b/gi, (m) => m.toUpperCase())
    .replace(/^./, (c) => c.toUpperCase());
}

/**
 * The snapshot. `caps` may omit flags the heuristics already infer.
 * `ctx` is thousands of tokens.
 */
const SNAPSHOT = [
  // ---- NVIDIA Nemotron family ----
  { id: "nvidia/nemotron-3-ultra-550b-a55b", caps: "crto", ctx: 1000, rate: "ultra", family: "Nemotron", note: "Flagship 550B MoE (55B active) for hard planning, long-horizon agentic work and deep reasoning." },
  { id: "nvidia/nemotron-3-super-120b-a12b", caps: "crto", ctx: 1000, rate: "large", family: "Nemotron", note: "120B MoE (12B active) — the default brain for agent runs: strong tools, cheap enough for every heartbeat." },
  { id: "nvidia/nemotron-nano-3-30b-a3b", caps: "crto", ctx: 256, rate: "mid", family: "Nemotron", note: "Compact 30B MoE for high-volume triage, classification and comment replies." },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", caps: "cvrto", ctx: 256, rate: "mid", family: "Nemotron", note: "Omni-modal nano: text, image and audio in with a reasoning loop." },
  { id: "nvidia/nemotron-3.5-super-vl-120b-a12b", caps: "cvrtop", ctx: 512, rate: "large", family: "Nemotron", note: "Vision-language flagship for screenshots, charts and document QA." },
  { id: "nvidia/nemotron-3.5-lightning-30b-a3b", caps: "crto", ctx: 256, rate: "small", family: "Nemotron", note: "Latency-optimised MoE for sub-second agent turns." },
  { id: "nvidia/nemotron-3.5-bolt-e4b", caps: "cto", ctx: 128, rate: "small", family: "Nemotron", note: "Edge/embedding-class workhorse for tiny tasks and drafts." },
  { id: "nvidia/nemotron-4-340b-instruct", caps: "ct", ctx: 128, rate: "large", family: "Nemotron", note: "Previous-gen 340B instruction model, still a solid long-form writer." },
  { id: "nvidia/nemotron-4-340b-reward", caps: "wt", ctx: 32, rate: "mid", family: "Nemotron", note: "Reward model: scores candidate answers for review gates and best-of-N." },
  { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1", caps: "crt", ctx: 128, rate: "large", family: "Nemotron", note: "253B reasoning model tuned for complex instruction following." },
  { id: "nvidia/llama-3.1-nemotron-70b-instruct", caps: "ct", ctx: 128, rate: "mid", family: "Nemotron", note: "Helpful-assistant alignment, good generalist for employee agents." },
  { id: "nvidia/llama-3.1-nemotron-51b-instruct", caps: "ct", ctx: 128, rate: "mid", family: "Nemotron", note: "Balanced 51B generalist; a solid second opinion when a run needs a second reviewer." },
  { id: "nvidia/llama3-chatqa-1.5-70b", caps: "c", ctx: 128, rate: "mid", family: "Nemotron", note: "RAG-tuned 70B: answers only from supplied context, cites sources." },

  // ---- Embeddings & retrieval (NeMo Retriever) ----
  { id: "nvidia/nemotron-3.5-embed-8b", caps: "e", ctx: 8, rate: "embed", family: "NeMo Retriever", note: "8B multimodal embedding: text and document images in one vector space." },
  { id: "nvidia/nemotron-3.5-embed-1b", caps: "e", ctx: 8, rate: "embed", family: "NeMo Retriever", note: "1B embedding model for high-throughput retrieval." },
  { id: "nvidia/nemotron-3-embed-1b", caps: "e", ctx: 8, rate: "embed", family: "NeMo Retriever", note: "Compact text embedding for semantic search." },
  { id: "nvidia/llama-3.2-nv-embedqa-1b-v1", caps: "e", ctx: 8, rate: "embed", family: "NeMo Retriever", note: "Question/answer embedding tuned for RAG corpora." },
  { id: "nvidia/nv-embedqa-mistral-7b-v2", caps: "e", ctx: 8, rate: "embed", family: "NeMo Retriever", note: "Mistral-based QA embedding, 4096-dim class quality." },
  { id: "nvidia/embed-qa-4", caps: "e", ctx: 4, rate: "embed", family: "NeMo Retriever", note: "Legacy 4B embedder, kept for existing indexes." },
  { id: "nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1", caps: "e", ctx: 8, rate: "embed", family: "NeMo Retriever", note: "Visual document embedding for page-image retrieval." },
  { id: "nvidia/llama-nemotron-embed-vl-1b-v2", caps: "e", ctx: 8, rate: "embed", family: "NeMo Retriever", note: "Multimodal embedder v2 for text + document images." },
  { id: "nvidia/nvclip", caps: "e", ctx: 1, rate: "embed", family: "NeMo Retriever", note: "CLIP-style joint image/text embedding for zero-shot media search." },
  { id: "snowflake/arctic-embed-l", caps: "e", ctx: 8, rate: "embed", family: "Community", note: "Snowflake Arctic large embedder, strong on enterprise search." },

  // ---- Vision / document understanding ----
  { id: "nvidia/nemotron-parse", caps: "pv", ctx: 32, rate: "mid", family: "Nemotron", note: "Extracts text, tables and layout from page images — OCR without the pipeline." },
  { id: "nvidia/nemotron-parse-2.0", caps: "pv", ctx: 32, rate: "mid", family: "Nemotron", note: "Parse v2: better tables, reading order and handwritten notes." },
  { id: "nvidia/neva-22b", caps: "cv", ctx: 8, rate: "mid", family: "NeMo", note: "Vision-language model for image Q&A and captioning." },
  { id: "nvidia/vila", caps: "cv", ctx: 8, rate: "mid", family: "NeMo", note: "VILA microservice for visual instruction tuning tasks." },
  { id: "meta/llama-3.2-11b-vision-instruct", caps: "cv", ctx: 128, rate: "small", family: "Community", note: "Lightweight vision model — cheap enough to check every screenshot." },
  { id: "meta/llama-3.2-90b-vision-instruct", caps: "cv", ctx: 128, rate: "large", family: "Community", note: "90B vision model for detailed chart and diagram reasoning." },
  { id: "microsoft/phi-3-vision-128k-instruct", caps: "cv", ctx: 128, rate: "small", family: "Community", note: "Small multimodal model with a 128k window." },
  { id: "microsoft/kosmos-2", caps: "cv", ctx: 4, rate: "small", family: "Community", note: "Grounded multimodal model: boxes + text for image entities." },
  { id: "adept/fuyu-8b", caps: "cv", ctx: 4, rate: "small", family: "Community", note: "8B multimodal model for charts, tables and UI screenshots." },
  { id: "google/deplot", caps: "cv", ctx: 2, rate: "small", family: "Community", note: "Chart-to-table extraction — turns a PNG plot into data." },
  { id: "google/diffusiongemma-26b-a4b-it", caps: "ci", ctx: 32, rate: "image", family: "Community", note: "Image generation + editing with instruction following and text rendering." },
  { id: "nvidia/ai-synthetic-video-detector", caps: "cv", ctx: 4, rate: "small", family: "NVIDIA AI", note: "Flags AI-generated or manipulated video frames." },
  { id: "nvidia/cosmos-reason2-8b", caps: "cvr", ctx: 128, rate: "mid", family: "Cosmos", note: "Physical-AI reasoning over video: what will happen next, and why." },

  // ---- Safety / guardrails ----
  { id: "nvidia/nemotron-3.5-content-safety", caps: "s", ctx: 32, rate: "small", family: "NeMo Guardrails", note: "Current content-safety classifier: safe/unsafe with category reasons." },
  { id: "nvidia/llama-3.1-nemoguard-8b-content-safety", caps: "s", ctx: 8, rate: "small", family: "NeMo Guardrails", note: "NemoGuard content safety, the long-standing guardrail default." },
  { id: "nvidia/llama-3.1-nemoguard-8b-topic-control", caps: "s", ctx: 8, rate: "small", family: "NeMo Guardrails", note: "Topic control: keeps agents inside an allowed subject area." },
  { id: "nvidia/llama-3.1-nemotron-safety-guard-8b-v3", caps: "s", ctx: 8, rate: "small", family: "NeMo Guardrails", note: "Safety guard v3 with jailbreak and harm taxonomies." },
  { id: "meta/llama-guard-4-12b", caps: "s", ctx: 128, rate: "small", family: "Community", note: "Llama Guard 4 — multimodal safety classification." },

  // ---- Code ----
  { id: "bigcode/starcoder2-15b", caps: "co", ctx: 16, rate: "small", family: "Community", note: "Fill-in-the-middle code model for repo-aware completion." },
  { id: "google/codegemma-1.1-7b", caps: "co", ctx: 8, rate: "small", family: "Community", note: "Fast 7B code model with a 1.1 refresh." },
  { id: "google/codegemma-7b", caps: "co", ctx: 8, rate: "small", family: "Community", note: "Original CodeGemma for completion and refactors." },
  { id: "ibm/granite-34b-code-instruct", caps: "cort", ctx: 32, rate: "mid", family: "Community", note: "Enterprise code instruction model, 20+ languages." },
  { id: "ibm/granite-8b-code-instruct", caps: "co", ctx: 32, rate: "small", family: "Community", note: "Small Granite code model for inline suggestions." },
  { id: "meta/codellama-70b", caps: "co", ctx: 16, rate: "large", family: "Community", note: "70B code model for whole-file generation." },
  { id: "mistralai/codestral-22b-instruct-v0.1", caps: "co", ctx: 32, rate: "mid", family: "Community", note: "Codestral: strong polyglot code generation and tests." },
  { id: "deepseek-ai/deepseek-coder-6.7b-instruct", caps: "co", ctx: 16, rate: "small", family: "Community", note: "Compact code specialist for review passes." },
  { id: "poolside/laguna-xs-2.1", caps: "co", ctx: 128, rate: "mid", family: "Community", note: "Agentic coding model tuned for repository-scale edits." },
  { id: "minimaxai/minimax-m3.1-flash", caps: "cortv", ctx: 512, rate: "mid", family: "Community", note: "Native multimodal MoE for coding, computer use and cybersecurity." },
  { id: "moonshotai/kimi-k2.6", caps: "crt", ctx: 256, rate: "mid", family: "Community", note: "Kimi K2.6: agentic tool use and long technical documents." },
  { id: "openai/gpt-oss-20b", caps: "crto", ctx: 128, rate: "small", family: "Community", note: "Open-weight GPT-OSS 20B with reasoning and tool calls." },

  // ---- General purpose / multi-vendor ----
  { id: "mistralai/mistral-large", caps: "ct", ctx: 128, rate: "large", family: "Community", note: "Mistral Large: reliable multilingual instruction following." },
  { id: "mistralai/mistral-large-2-instruct", caps: "ct", ctx: 128, rate: "large", family: "Community", note: "Mistral Large 2 with stronger code and function calling." },
  { id: "mistralai/mistral-large-4-1t-a52b", caps: "cvrt", ctx: 256, rate: "ultra", family: "Community", note: "1T-total / 52B-active MoE with reasoning, tools and structured outputs." },
  { id: "mistralai/mistral-7b-instruct-v0.3", caps: "c", ctx: 32, rate: "small", family: "Community", note: "Cheap generalist for drafts and summaries." },
  { id: "mistralai/mixtral-8x22b-v0.1", caps: "ct", ctx: 64, rate: "mid", family: "Community", note: "Sparse MoE generalist with a large working memory." },
  { id: "nv-mistralai/mistral-nemo-12b-instruct", caps: "ct", ctx: 128, rate: "small", family: "Community", note: "NVIDIA-tuned 12B Mistral Nemo, 128k context." },
  { id: "nvidia/mistral-nemo-minitron-8b-8k-instruct", caps: "c", ctx: 8, rate: "small", family: "Nemotron", note: "Minitron-pruned 8B model for edge deployments." },
  { id: "ai21labs/jamba-1.5-large-instruct", caps: "ct", ctx: 256, rate: "mid", family: "Community", note: "Hybrid SSM/attention model with a long window." },
  { id: "databricks/dbrx-instruct", caps: "ct", ctx: 32, rate: "mid", family: "Community", note: "DBRX 132B MoE generalist." },
  { id: "01-ai/yi-large", caps: "ct", ctx: 32, rate: "mid", family: "Community", note: "Yi Large: bilingual reasoning and writing." },
  { id: "aisingapore/sea-lion-7b-instruct", caps: "c", ctx: 8, rate: "small", family: "Community", note: "Southeast-Asian language specialist." },
  { id: "z-ai/glm-5.3-flash", caps: "crt", ctx: 200, rate: "small", family: "Community", note: "GLM 5.3 Flash: fast bilingual chat with reasoning." },
  { id: "zyphra/zamba2-7b-instruct", caps: "c", ctx: 32, rate: "small", family: "Community", note: "Zamba2 hybrid SSM, efficient at long-form chat." },
  { id: "meta/muse-glimmer-30b", caps: "crt", ctx: 128, rate: "mid", family: "Community", note: "30B creative and analytical writer." },
  { id: "meta/llama2-70b", caps: "c", ctx: 4, rate: "mid", family: "Community", note: "Legacy Llama 2 70B, kept for backwards compatibility." },
  { id: "google/gemma-4-31b-it", caps: "crt", ctx: 128, rate: "mid", family: "Community", note: "Gemma 4 31B instruction-tuned generalist." },
  { id: "google/gemma-3-12b-it", caps: "cv", ctx: 128, rate: "small", family: "Community", note: "Gemma 3 12B with multimodal input." },
  { id: "google/gemma-3-4b-it", caps: "c", ctx: 128, rate: "small", family: "Community", note: "Gemma 3 4B — tiny, fast summariser." },
  { id: "google/gemma-2b", caps: "c", ctx: 8, rate: "small", family: "Community", note: "Original Gemma 2B for cheap classification." },
  { id: "google/recurrentgemma-2b", caps: "c", ctx: 8, rate: "small", family: "Community", note: "Recurrent Gemma for streaming generation." },
  { id: "ibm/granite-3.0-8b-instruct", caps: "ct", ctx: 128, rate: "small", family: "Community", note: "Granite 3.0 8B enterprise assistant." },
  { id: "ibm/granite-3.0-3b-a800m-instruct", caps: "c", ctx: 128, rate: "small", family: "Community", note: "Granite 3.0 3B MoE, extremely cheap." },
  { id: "microsoft/phi-3.5-moe-instruct", caps: "ct", ctx: 128, rate: "small", family: "Community", note: "Phi-3.5 MoE: small model, strong instruction following." },
  { id: "writer/palmyra-creative-122b", caps: "c", ctx: 32, rate: "large", family: "Community", note: "Marketing and long-form creative writing." },
  { id: "writer/palmyra-fin-70b-32k", caps: "ct", ctx: 32, rate: "mid", family: "Community", note: "Finance-tuned 70B: filings, models, compliance prose." },
  { id: "writer/palmyra-med-70b", caps: "c", ctx: 8, rate: "mid", family: "Community", note: "Medical writing and patient-education text." },
  { id: "writer/palmyra-med-70b-32k", caps: "c", ctx: 32, rate: "mid", family: "Community", note: "Medical 70B with a 32k window for chart review." },
  { id: "nvidia/ising-calibration-1.5-31b", caps: "cr", ctx: 32, rate: "mid", family: "NVIDIA AI", note: "Calibration model for quantum/annealing and scientific workloads." },
  { id: "nvidia/riva-translate-4b-instruct", caps: "xct", ctx: 8, rate: "small", family: "Riva", note: "Riva translation: 30+ languages, preserves formatting." },
  { id: "nvidia/riva-translate-4b-instruct-v2", caps: "xct", ctx: 8, rate: "small", family: "Riva", note: "Translation v2 with better terminology control." },
  { id: "stepfun-ai/step-5-preview", caps: "crvt", ctx: 1000, rate: "ultra", family: "Community", note: "600B-total / 27B-active multimodal MoE with a 1M-token window." },

  // ---- Curated: endpoint families whose models rotate per account ----
  { id: "nvidia/llama-3.2-nv-rerankqa-1b-v2", caps: "k", ctx: 8, rate: "rerank", family: "NeMo Retriever", note: "Cross-encoder reranker for RAG QA pairs (POST /ranking).", curated: true },
  { id: "nvidia/nv-rerankqa-mistral-4b-v3", caps: "k", ctx: 8, rate: "rerank", family: "NeMo Retriever", note: "Mistral-based reranker, higher accuracy than the 1B model.", curated: true },
  { id: "black-forest-labs/flux.1-dev", caps: "i", ctx: 1, rate: "image", family: "Generative AI", note: "FLUX.1 dev text-to-image via the visual genai endpoint.", curated: true },
  { id: "stabilityai/stable-diffusion-3.5-large", caps: "i", ctx: 1, rate: "image", family: "Generative AI", note: "SD 3.5 Large — photorealistic and illustrated images.", curated: true },
  { id: "nvidia/cosmos-predict2-14b-text2world", caps: "d", ctx: 8, rate: "video", family: "Cosmos", note: "World-model video generation from text prompts.", curated: true },

  // ---- BioNeMo: biomolecular NIMs (POST /biology/{task}) ----
  { id: "nvidia/bionemo-boltz2", caps: "b", ctx: 4, rate: "large", family: "BioNeMo", note: "Structure prediction for proteins, ligands and complexes — the backbone of the molecular-design blueprint.", curated: true },
  { id: "nvidia/evo2-40b", caps: "b", ctx: 1024, rate: "mid", family: "BioNeMo", note: "Genomic foundation model: variant effect, long-context DNA reasoning.", curated: true },
  { id: "nvidia/esmfold", caps: "b", ctx: 2, rate: "small", family: "BioNeMo", note: "Fast single-sequence protein folding to 3D coordinates.", curated: true },
  { id: "nvidia/proteinmpnn", caps: "b", ctx: 2, rate: "small", family: "BioNeMo", note: "Inverse folding: proposes sequences that fold into a given backbone.", curated: true },
  { id: "nvidia/rfdiffusion", caps: "b", ctx: 2, rate: "small", family: "BioNeMo", note: "Backbone diffusion for de-novo protein design.", curated: true },
  { id: "nvidia/diffdock", caps: "b", ctx: 2, rate: "small", family: "BioNeMo", note: "Diffusion-based molecular docking: pose and confidence per ligand.", curated: true },
  { id: "nvidia/genmol", caps: "b", ctx: 4, rate: "small", family: "BioNeMo", note: "De-novo small-molecule generation with property conditioning.", curated: true },
  { id: "nvidia/megamolbart", caps: "be", ctx: 2, rate: "embed", family: "BioNeMo", note: "Chemical language embeddings over SMILES for similarity search.", curated: true },
];

const HEURISTIC_FAMILY = [
  [/nemoguard|content-safety|topic-control|safety-guard|guard/i, "NeMo Guardrails"],
  [/parse|deplot|ocr|kosmos|fuyu|neva|vila|vision|vl|nvclip|florence/i, "Vision"],
  [/embed|nvclip|arctic-embed/i, "NeMo Retriever"],
  [/nemotron|nvidia\//i, "Nemotron"],
  [/codestral|codellama|codegemma|starcoder|granite.*code|coder/i, "Code"],
];

function inferCaps(id, explicit = "") {
  const flags = new Set(explicit.split(""));
  const haystack = id.toLowerCase();
  if (/embed|nvclip|arctic-embed/.test(haystack)) flags.add("e");
  if (/rank|rerank/.test(haystack)) flags.add("k");
  if (/parse|deplot/.test(haystack)) flags.add("p");
  if (/safety|guard|guardrail/.test(haystack)) flags.add("s");
  if (/translate|riva-translate/.test(haystack)) flags.add("x");
  if (/vision|vl|vila|neva|fuyu|kosmos|nvclip|parse|cosmos-reason/.test(haystack)) flags.add("v");
  if (/reason|ultra|thinking|r1|glm|step-5|nemotron-3|kimi|gpt-oss|gemma-4|mistral-large-4|muse|ising/.test(haystack)) flags.add("r");
  if (!flags.size) flags.add("c");
  if (flags.has("c") && !flags.has("t") && !/embed|rank|safety|guard|parse/.test(haystack)) flags.add("t");
  return [...flags].filter((flag) => FLAG_TO_CAPABILITY[flag]).sort().join("");
}

function familyFor(id, explicit) {
  if (explicit) return explicit;
  for (const [pattern, family] of HEURISTIC_FAMILY) if (pattern.test(id)) return family;
  return "Community";
}

function rateFor(entry, caps) {
  if (entry.rate && RATE[entry.rate]) return RATE[entry.rate];
  if (caps.includes("e")) return RATE.embed;
  if (caps.includes("k")) return RATE.rerank;
  if (caps.includes("i")) return RATE.image;
  if (caps.includes("d")) return RATE.video;
  return RATE.mid;
}

function build(entry) {
  const caps = inferCaps(entry.id, entry.caps ?? "");
  const family = familyFor(entry.id, entry.family);
  return {
    id: entry.id,
    name: entry.name ?? titleFromId(entry.id),
    vendor: entry.id.split("/")[0],
    family,
    contextK: entry.ctx ?? 8,
    capabilities: [...caps].map((flag) => FLAG_TO_CAPABILITY[flag]).filter(Boolean),
    flags: caps,
    rate: rateFor(entry, caps),
    note: entry.note ?? "",
    status: "available",
    source: entry.curated ? "curated" : "snapshot",
    verified: false,
  };
}

export const MODEL_CATALOG = SNAPSHOT.map(build);

export const EMBEDDING_MODELS = MODEL_CATALOG.filter((model) => model.capabilities.includes("embedding"));
export const SAFETY_MODELS = MODEL_CATALOG.filter((model) => model.capabilities.includes("safety"));

export const DEFAULTS = {
  chat: "nvidia/nemotron-3-super-120b-a12b",
  reasoning: "nvidia/nemotron-3-ultra-550b-a55b",
  fast: "nvidia/nemotron-nano-3-30b-a3b",
  vision: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  code: "mistralai/codestral-22b-instruct-v0.1",
  embed: "nvidia/nemotron-3.5-embed-8b",
  rerank: "nvidia/nv-rerankqa-mistral-4b-v3",
  image: "google/diffusiongemma-26b-a4b-it",
  safety: "nvidia/nemotron-3.5-content-safety",
  parse: "nvidia/nemotron-parse-2.0",
  translate: "nvidia/riva-translate-4b-instruct-v2",
  reward: "nvidia/nemotron-4-340b-reward",
};

function envDefault(name, fallback) {
  const value = process.env[name];
  return value && MODEL_CATALOG.some((model) => model.id === value) ? value : fallback;
}

export function defaults() {
  return {
    chat: envDefault("NIM_DEFAULT_CHAT", DEFAULTS.chat),
    reasoning: envDefault("NIM_DEFAULT_REASONING", DEFAULTS.reasoning),
    fast: envDefault("NIM_DEFAULT_FAST", DEFAULTS.fast),
    vision: envDefault("NIM_DEFAULT_VISION", DEFAULTS.vision),
    code: envDefault("NIM_DEFAULT_CODE", DEFAULTS.code),
    embed: envDefault("NIM_DEFAULT_EMBED", DEFAULTS.embed),
    rerank: envDefault("NIM_DEFAULT_RERANK", DEFAULTS.rerank),
    image: envDefault("NIM_DEFAULT_IMAGE", DEFAULTS.image),
    safety: envDefault("NIM_DEFAULT_SAFETY", DEFAULTS.safety),
    parse: envDefault("NIM_DEFAULT_PARSE", DEFAULTS.parse),
    translate: envDefault("NIM_DEFAULT_TRANSLATE", DEFAULTS.translate),
    reward: envDefault("NIM_DEFAULT_REWARD", DEFAULTS.reward),
  };
}

export function findModel(id) {
  return MODEL_CATALOG.find((model) => model.id === id) ?? null;
}

export function requireModel(id) {
  const model = findModel(id);
  if (!model) {
    const error = new Error(`Unknown NVIDIA NIM model: ${id}`);
    error.status = 400;
    error.code = "unknown_model";
    throw error;
  }
  return model;
}

/** Pick a model for a capability, preferring the configured default. */
export function selectModel(capability, preferred) {
  const usable = (model) => model.status !== "retired" && model.capabilities.includes(capability);
  if (preferred && findModel(preferred) && usable(findModel(preferred))) return preferred;
  const configured = defaults()[capability];
  if (configured && findModel(configured) && usable(findModel(configured))) return configured;
  const candidate = MODEL_CATALOG.find(usable);
  return candidate?.id ?? MODEL_CATALOG[0].id;
}

/**
 * Merge a live `GET /v1/models` response into the snapshot.
 * Returns the merged catalog; unknown IDs are appended as `unverified` so new
 * NIM releases show up in the UI without a code change.
 */
export function mergeLive(liveModels, { now = new Date().toISOString() } = {}) {
  const liveIds = new Set(liveModels.map((model) => model.id));
  const merged = MODEL_CATALOG.map((model) =>
    liveIds.has(model.id)
      ? { ...model, status: "available", source: "live", verified: true }
      : { ...model, status: liveModels.length && model.source === "snapshot" ? "not-in-account" : "available", verified: false },
  );
  for (const live of liveModels) {
    if (MODEL_CATALOG.some((model) => model.id === live.id)) continue;
    const caps = inferCaps(live.id);
    merged.push({
      id: live.id,
      name: titleFromId(live.id),
      vendor: live.owned_by ?? live.id.split("/")[0],
      family: familyFor(live.id),
      contextK: /embed|rank/.test(live.id) ? 8 : 128,
      capabilities: [...caps].map((flag) => FLAG_TO_CAPABILITY[flag]),
      flags: caps,
      rate: rateFor({}, caps),
      note: "Discovered live from /v1/models — no curated metadata yet.",
      status: "available",
      source: "live",
      verified: true,
    });
  }
  merged.sort((a, b) => {
    const fam = a.family.localeCompare(b.family);
    return fam !== 0 ? fam : a.id.localeCompare(b.id);
  });
  return { models: merged, syncedAt: now, liveCount: liveModels.length };
}

export function catalogSummary(models = MODEL_CATALOG) {
  const families = new Map();
  const capabilityCounts = {};
  for (const model of models) {
    families.set(model.family, (families.get(model.family) ?? 0) + 1);
    for (const capability of model.capabilities) {
      capabilityCounts[capability] = (capabilityCounts[capability] ?? 0) + 1;
    }
  }
  return {
    total: models.length,
    families: [...families.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    capabilities: capabilityCounts,
  };
}

export function estimateCost({ model, usage }) {
  const meta = typeof model === "string" ? findModel(model) : model;
  const rate = meta?.rate ?? RATE.mid;
  const input = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0);
  const output = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0);
  const images = Number(usage?.images ?? 0);
  const dollars = (input / 1e6) * rate.in + (output / 1e6) * rate.out + images * (rate.perImage ?? 0);
  return {
    inputTokens: input,
    outputTokens: output,
    images,
    cents: Math.round(dollars * 10000) / 100, // cents, 2dp (sub-cent precision kept)
    dollars: Math.round(dollars * 1e6) / 1e6,
  };
}

export function searchModels(models, query = "") {
  const term = query.trim().toLowerCase();
  if (!term) return models;
  return models.filter((model) =>
    [model.id, model.name, model.family, model.note, ...model.capabilities].join(" ").toLowerCase().includes(term),
  );
}
