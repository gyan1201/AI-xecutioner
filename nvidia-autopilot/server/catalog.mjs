/**
 * NVIDIA NIM model catalog intelligence.
 *
 * `build.nvidia.com` is the source of truth for what is deployed, so the live
 * `/v1/models` response always wins. These presets exist to (a) route agent
 * roles to a sensible model before discovery finishes, (b) work offline in
 * simulation, and (c) label capability families so the UI can group models.
 */

export const ROLE_DEFINITIONS = {
  strategist: {
    label: "Strategist",
    title: "Chief of Staff",
    description: "Turns a company goal into a dependency-aware plan with measurable outcomes.",
    capability: "reasoning",
    candidates: [
      "nvidia/nemotron-3-super-120b-a12b",
      "nvidia/nemotron-3-ultra-550b-a55b",
      "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      "deepseek-ai/deepseek-v4-pro",
      "openai/gpt-oss-120b",
      "meta/llama-3.3-70b-instruct",
    ],
    temperature: 0.3,
    maxTokens: 2400,
  },
  analyst: {
    label: "Analyst",
    title: "Research Lead",
    description: "Researches each work item and grounds answers in retrieved company context.",
    capability: "reasoning",
    candidates: [
      "nvidia/nemotron-3-nano-30b-a3b",
      "nvidia/llama-3.3-nemotron-super-49b-v1.5",
      "deepseek-ai/deepseek-v4-flash",
      "qwen/qwen3-next-80b-a3b-instruct",
      "meta/llama-3.3-70b-instruct",
    ],
    temperature: 0.4,
    maxTokens: 1600,
  },
  operator: {
    label: "Operator",
    title: "Delivery Lead",
    description: "Produces the actual deliverable, calling tools (retrieval, calculation, assets) as needed.",
    capability: "tool_use",
    candidates: [
      "nvidia/nemotron-3-super-120b-a12b",
      "moonshotai/kimi-k2-instruct",
      "mistralai/mistral-nemotron",
      "openai/gpt-oss-120b",
      "meta/llama-3.3-70b-instruct",
    ],
    temperature: 0.5,
    maxTokens: 2200,
  },
  critic: {
    label: "Critic",
    title: "Quality Reviewer",
    description: "Checks every deliverable against its definition of done and sends it back if it fails.",
    capability: "reasoning",
    candidates: [
      "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      "nvidia/nemotron-3-super-120b-a12b",
      "deepseek-ai/deepseek-v4-pro",
      "qwen/qwq-32b",
      "meta/llama-3.3-70b-instruct",
    ],
    temperature: 0.1,
    maxTokens: 1200,
  },
  safety: {
    label: "Safety",
    title: "Trust & Safety",
    description: "Screens goals, work items and outputs before anything is executed or shipped.",
    capability: "safety",
    candidates: [
      "nvidia/llama-3.1-nemotron-safety-guard-8b-v3",
      "nvidia/llama-3.1-nemoguard-8b-content-safety",
      "nvidia/nemotron-content-safety-reasoning-4b",
      "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    ],
    temperature: 0,
    maxTokens: 400,
  },
  scribe: {
    label: "Scribe",
    title: "Executive Reporter",
    description: "Packages the run into an executive report with KPIs, spend and recommended next actions.",
    capability: "reasoning",
    candidates: [
      "nvidia/nemotron-3-super-120b-a12b",
      "meta/llama-3.3-70b-instruct",
      "qwen/qwen3-next-80b-a3b-instruct",
    ],
    temperature: 0.35,
    maxTokens: 2000,
  },
  embedder: {
    label: "Embedder",
    title: "Retrieval Index",
    description: "Converts company knowledge into vectors for retrieval-augmented work.",
    capability: "embedding",
    candidates: [
      "nvidia/llama-3.2-nv-embedqa-1b-v2",
      "nvidia/llama-nemotron-embed-1b-v2",
      "nvidia/nv-embedqa-e5-v5",
      "baai/bge-m3",
    ],
  },
  reranker: {
    label: "Reranker",
    title: "Retrieval Precision",
    description: "Re-orders retrieved passages so only the most relevant context reaches the model.",
    capability: "rerank",
    candidates: [
      "nvidia/llama-3.2-nv-rerankqa-1b-v2",
      "nvidia/llama-nemotron-rerank-1b-v2",
      "nvidia/nv-rerankqa-mistral-4b-v3",
    ],
  },
  artist: {
    label: "Artist",
    title: "Visual Production",
    description: "Generates campaign and product visuals with NVIDIA-hosted diffusion models.",
    capability: "image",
    candidates: [
      "stabilityai/stable-diffusion-3-medium",
      "black-forest-labs/flux.1-dev",
      "stabilityai/sdxl-turbo",
    ],
  },
};

export const CAPABILITY_LABELS = {
  chat: "Chat",
  reasoning: "Reasoning",
  tool_use: "Tool use",
  vision: "Vision",
  code: "Code",
  embedding: "Embedding",
  rerank: "Rerank",
  safety: "Safety",
  image: "Image generation",
  long_context: "Long context",
  audio: "Audio / speech",
  biology: "Biology / chemistry",
};

/** Curated presets — used for offline labelling and as role fallbacks. */
export const MODEL_PRESETS = [
  { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B", publisher: "nvidia", capabilities: ["chat", "reasoning", "tool_use", "long_context"], contextWindow: 1_000_000 },
  { id: "nvidia/nemotron-3-nano-30b-a3b", label: "Nemotron 3 Nano 30B", publisher: "nvidia", capabilities: ["chat", "reasoning", "tool_use"], contextWindow: 1_000_000 },
  { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning 30B", publisher: "nvidia", capabilities: ["chat", "reasoning", "tool_use"], contextWindow: 256_000 },
  { id: "nvidia/nemotron-3.5-bolt-e4b", label: "Nemotron 3.5 Bolt E4B", publisher: "nvidia", capabilities: ["chat", "reasoning"], contextWindow: 128_000 },
  { id: "nvidia/nemotron-3-ultra-550b-a55b", label: "Nemotron 3 Ultra 550B", publisher: "nvidia", capabilities: ["chat", "reasoning", "tool_use", "vision", "long_context"], contextWindow: 1_000_000 },
  { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5", label: "Llama 3.3 Nemotron Super 49B", publisher: "nvidia", capabilities: ["chat", "reasoning", "tool_use", "long_context"], contextWindow: 131_072 },
  { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1", label: "Llama 3.1 Nemotron Ultra 253B", publisher: "nvidia", capabilities: ["chat", "reasoning", "tool_use"], contextWindow: 131_072 },
  { id: "nvidia/nemotron-content-safety-reasoning-4b", label: "Nemotron Content Safety Reasoning 4B", publisher: "nvidia", capabilities: ["safety", "reasoning"], contextWindow: 128_000 },
  { id: "nvidia/llama-3.1-nemotron-safety-guard-8b-v3", label: "Nemotron Safety Guard 8B", publisher: "nvidia", capabilities: ["safety"], contextWindow: 128_000 },
  { id: "nvidia/llama-3.1-nemoguard-8b-content-safety", label: "NeMoGuard Content Safety 8B", publisher: "nvidia", capabilities: ["safety"], contextWindow: 128_000 },
  { id: "nvidia/nemoguard-jailbreak-detect", label: "NeMoGuard Jailbreak Detect", publisher: "nvidia", capabilities: ["safety"], contextWindow: 128_000 },
  { id: "nvidia/gliner-pii", label: "GLiNER PII", publisher: "nvidia", capabilities: ["safety"], contextWindow: 8_192 },
  { id: "nvidia/llama-3.2-nv-embedqa-1b-v2", label: "NV EmbedQA 1B v2", publisher: "nvidia", capabilities: ["embedding"], contextWindow: 4_096 },
  { id: "nvidia/nv-embedqa-e5-v5", label: "NV EmbedQA E5", publisher: "nvidia", capabilities: ["embedding"], contextWindow: 512 },
  { id: "nvidia/llama-nemotron-embed-1b-v2", label: "Nemotron Embed 1B v2", publisher: "nvidia", capabilities: ["embedding"], contextWindow: 8_192 },
  { id: "baai/bge-m3", label: "BGE M3", publisher: "baai", capabilities: ["embedding"], contextWindow: 8_192 },
  { id: "nvidia/llama-3.2-nv-rerankqa-1b-v2", label: "NV RerankQA 1B v2", publisher: "nvidia", capabilities: ["rerank"], contextWindow: 8_192 },
  { id: "nvidia/llama-nemotron-rerank-1b-v2", label: "Nemotron Rerank 1B v2", publisher: "nvidia", capabilities: ["rerank"], contextWindow: 8_192 },
  { id: "nvidia/nv-rerankqa-mistral-4b-v3", label: "NV RerankQA Mistral 4B", publisher: "nvidia", capabilities: ["rerank"], contextWindow: 8_192 },
  { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct", publisher: "meta", capabilities: ["chat", "tool_use"], contextWindow: 128_000 },
  { id: "meta/llama-3.2-90b-vision-instruct", label: "Llama 3.2 90B Vision", publisher: "meta", capabilities: ["chat", "vision"], contextWindow: 128_000 },
  { id: "nvidia/llama-3.1-nemotron-nano-vl-8b-v1", label: "Nemotron Nano VL 8B", publisher: "nvidia", capabilities: ["chat", "vision"], contextWindow: 32_768 },
  { id: "deepseek-ai/deepseek-v4-pro", label: "DeepSeek V4 Pro", publisher: "deepseek-ai", capabilities: ["chat", "reasoning", "tool_use", "long_context"], contextWindow: 256_000 },
  { id: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash", publisher: "deepseek-ai", capabilities: ["chat", "reasoning", "tool_use"], contextWindow: 128_000 },
  { id: "qwen/qwen3-next-80b-a3b-instruct", label: "Qwen3 Next 80B", publisher: "qwen", capabilities: ["chat", "tool_use"], contextWindow: 262_144 },
  { id: "qwen/qwen3-next-80b-a3b-thinking", label: "Qwen3 Next 80B Thinking", publisher: "qwen", capabilities: ["chat", "reasoning"], contextWindow: 262_144 },
  { id: "qwen/qwen2.5-coder-32b-instruct", label: "Qwen2.5 Coder 32B", publisher: "qwen", capabilities: ["chat", "code", "tool_use"], contextWindow: 131_072 },
  { id: "qwen/qwq-32b", label: "QwQ 32B", publisher: "qwen", capabilities: ["chat", "reasoning"], contextWindow: 131_072 },
  { id: "moonshotai/kimi-k2-instruct", label: "Kimi K2 Instruct", publisher: "moonshotai", capabilities: ["chat", "tool_use", "long_context"], contextWindow: 256_000 },
  { id: "moonshotai/kimi-k2-thinking", label: "Kimi K2 Thinking", publisher: "moonshotai", capabilities: ["chat", "reasoning"], contextWindow: 256_000 },
  { id: "mistralai/mistral-nemotron", label: "Mistral Nemotron", publisher: "mistralai", capabilities: ["chat", "tool_use"], contextWindow: 128_000 },
  { id: "mistralai/mixtral-8x22b-instruct", label: "Mixtral 8x22B", publisher: "mistralai", capabilities: ["chat"], contextWindow: 65_536 },
  { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", publisher: "openai", capabilities: ["chat", "reasoning", "tool_use"], contextWindow: 131_072 },
  { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B", publisher: "openai", capabilities: ["chat", "reasoning"], contextWindow: 131_072 },
  { id: "microsoft/phi-4-mini-instruct", label: "Phi-4 Mini", publisher: "microsoft", capabilities: ["chat"], contextWindow: 131_072 },
  { id: "stabilityai/stable-diffusion-3-medium", label: "Stable Diffusion 3 Medium", publisher: "stabilityai", capabilities: ["image"] },
  { id: "stabilityai/sdxl-turbo", label: "SDXL Turbo", publisher: "stabilityai", capabilities: ["image"] },
  { id: "black-forest-labs/flux.1-dev", label: "FLUX.1 Dev", publisher: "black-forest-labs", capabilities: ["image"] },
  { id: "black-forest-labs/flux.2-klein", label: "FLUX.2 Klein", publisher: "black-forest-labs", capabilities: ["image"] },
];


/**
 * The rest of the hosted catalog. `build.nvidia.com/models` lists ~100 NIMs;
 * these entries cover the families this app can drive (chat, reasoning, vision,
 * embeddings, rerank, safety, image, audio, biology). Live discovery still wins —
 * anything returned by `/v1/models` is labelled `live`, and anything here that
 * the account cannot see is labelled `catalog`.
 */
export const EXTRA_CATALOG = [
  { "id": "meta/llama-3.1-8b-instruct", "label": "Llama 3.1 8B Instruct", "publisher": "meta", "capabilities": ["chat", "tool_use"], "contextWindow": 131072},
  { "id": "meta/llama-3.1-70b-instruct", "label": "Llama 3.1 70B Instruct", "publisher": "meta", "capabilities": ["chat", "tool_use"], "contextWindow": 131072},
  { "id": "meta/llama-3.1-405b-instruct", "label": "Llama 3.1 405B Instruct", "publisher": "meta", "capabilities": ["chat", "tool_use", "long_context"], "contextWindow": 131072},
  { "id": "meta/llama-3.2-1b-instruct", "label": "Llama 3.2 1B Instruct", "publisher": "meta", "capabilities": ["chat"], "contextWindow": 131072},
  { "id": "meta/llama-3.2-3b-instruct", "label": "Llama 3.2 3B Instruct", "publisher": "meta", "capabilities": ["chat"], "contextWindow": 131072},
  { "id": "meta/llama-3.2-11b-vision-instruct", "label": "Llama 3.2 11B Vision", "publisher": "meta", "capabilities": ["chat", "vision"], "contextWindow": 131072},
  { "id": "meta/llama-4-maverick-17b-128e-instruct", "label": "Llama 4 Maverick 17B", "publisher": "meta", "capabilities": ["chat", "vision", "tool_use", "long_context"], "contextWindow": 1000000},
  { "id": "meta/llama-4-scout-17b-16e-instruct", "label": "Llama 4 Scout 17B", "publisher": "meta", "capabilities": ["chat", "vision", "tool_use", "long_context"], "contextWindow": 1000000},
  { "id": "meta/codellama-70b", "label": "CodeLlama 70B", "publisher": "meta", "capabilities": ["chat", "code"], "contextWindow": 16384},
  { "id": "nvidia/llama-3.1-nemotron-70b-instruct", "label": "Llama 3.1 Nemotron 70B", "publisher": "nvidia", "capabilities": ["chat", "tool_use"], "contextWindow": 131072},
  { "id": "nvidia/llama-3.3-nemotron-super-49b-v1", "label": "Llama 3.3 Nemotron Super 49B v1", "publisher": "nvidia", "capabilities": ["chat", "reasoning", "tool_use"], "contextWindow": 131072},
  { "id": "nvidia/nvidia-nemotron-nano-9b-v2", "label": "Nemotron Nano 9B v2", "publisher": "nvidia", "capabilities": ["chat", "reasoning"], "contextWindow": 131072},
  { "id": "nvidia/nemotron-nano-12b-v2-vl", "label": "Nemotron Nano 12B v2 VL", "publisher": "nvidia", "capabilities": ["chat", "vision", "reasoning"], "contextWindow": 131072},
  { "id": "nvidia/nemotron-mini-4b-instruct", "label": "Nemotron Mini 4B", "publisher": "nvidia", "capabilities": ["chat"], "contextWindow": 4096},
  { "id": "nvidia/mistral-nemo-minitron-8b-8k-instruct", "label": "Mistral NeMo Minitron 8B", "publisher": "nvidia", "capabilities": ["chat"], "contextWindow": 8192},
  { "id": "nvidia/nemotron-4-340b-instruct", "label": "Nemotron-4 340B Instruct", "publisher": "nvidia", "capabilities": ["chat", "tool_use"], "contextWindow": 4096},
  { "id": "nvidia/nemotron-4-340b-reward", "label": "Nemotron-4 340B Reward", "publisher": "nvidia", "capabilities": ["chat"], "contextWindow": 4096},
  { "id": "mistralai/mistral-large-2-instruct", "label": "Mistral Large 2", "publisher": "mistralai", "capabilities": ["chat", "tool_use"], "contextWindow": 131072},
  { "id": "mistralai/mistral-small-3.1-24b-instruct-2503", "label": "Mistral Small 3.1 24B", "publisher": "mistralai", "capabilities": ["chat", "vision", "tool_use"], "contextWindow": 131072},
  { "id": "mistralai/mixtral-8x7b-instruct", "label": "Mixtral 8x7B", "publisher": "mistralai", "capabilities": ["chat"], "contextWindow": 32768},
  { "id": "mistralai/mistral-7b-instruct-v0.3", "label": "Mistral 7B Instruct v0.3", "publisher": "mistralai", "capabilities": ["chat"], "contextWindow": 32768},
  { "id": "mistralai/codestral-22b-instruct-v0.1", "label": "Codestral 22B", "publisher": "mistralai", "capabilities": ["chat", "code"], "contextWindow": 32768},
  { "id": "mistralai/mamba-codestral-7b-v0.1", "label": "Mamba Codestral 7B", "publisher": "mistralai", "capabilities": ["chat", "code"], "contextWindow": 32768},
  { "id": "deepseek-ai/deepseek-r1", "label": "DeepSeek R1", "publisher": "deepseek-ai", "capabilities": ["chat", "reasoning"], "contextWindow": 131072},
  { "id": "deepseek-ai/deepseek-r1-distill-qwen-32b", "label": "DeepSeek R1 Distill Qwen 32B", "publisher": "deepseek-ai", "capabilities": ["chat", "reasoning"], "contextWindow": 131072},
  { "id": "deepseek-ai/deepseek-r1-distill-llama-8b", "label": "DeepSeek R1 Distill Llama 8B", "publisher": "deepseek-ai", "capabilities": ["chat", "reasoning"], "contextWindow": 131072},
  { "id": "deepseek-ai/deepseek-coder-6.7b-instruct", "label": "DeepSeek Coder 6.7B", "publisher": "deepseek-ai", "capabilities": ["chat", "code"], "contextWindow": 16384},
  { "id": "qwen/qwen2.5-7b-instruct", "label": "Qwen2.5 7B", "publisher": "qwen", "capabilities": ["chat", "tool_use"], "contextWindow": 32768},
  { "id": "qwen/qwen2.5-coder-7b-instruct", "label": "Qwen2.5 Coder 7B", "publisher": "qwen", "capabilities": ["chat", "code"], "contextWindow": 32768},
  { "id": "qwen/qwen3-235b-a22b", "label": "Qwen3 235B A22B", "publisher": "qwen", "capabilities": ["chat", "reasoning", "tool_use", "long_context"], "contextWindow": 131072},
  { "id": "qwen/qwen2-vl-7b-instruct", "label": "Qwen2 VL 7B", "publisher": "qwen", "capabilities": ["chat", "vision"], "contextWindow": 32768},
  { "id": "qwen/qwen2.5-vl-7b-instruct", "label": "Qwen2.5 VL 7B", "publisher": "qwen", "capabilities": ["chat", "vision"], "contextWindow": 32768},
  { "id": "qwen/qwen-image", "label": "Qwen Image", "publisher": "qwen", "capabilities": ["image"]},
  { "id": "google/gemma-2-27b-it", "label": "Gemma 2 27B", "publisher": "google", "capabilities": ["chat"], "contextWindow": 8192},
  { "id": "google/gemma-2-9b-it", "label": "Gemma 2 9B", "publisher": "google", "capabilities": ["chat"], "contextWindow": 8192},
  { "id": "google/gemma-2b", "label": "Gemma 2B", "publisher": "google", "capabilities": ["chat"], "contextWindow": 8192},
  { "id": "google/codegemma-7b", "label": "CodeGemma 7B", "publisher": "google", "capabilities": ["chat", "code"], "contextWindow": 8192},
  { "id": "google/recurrentgemma-2b", "label": "RecurrentGemma 2B", "publisher": "google", "capabilities": ["chat"], "contextWindow": 8192},
  { "id": "google/shieldgemma-9b", "label": "ShieldGemma 9B", "publisher": "google", "capabilities": ["safety"], "contextWindow": 8192},
  { "id": "google/paligemma", "label": "PaliGemma", "publisher": "google", "capabilities": ["vision"], "contextWindow": 8192},
  { "id": "google/deplot", "label": "DePlot", "publisher": "google", "capabilities": ["vision"], "contextWindow": 4096},
  { "id": "microsoft/phi-3-medium-128k-instruct", "label": "Phi-3 Medium 128K", "publisher": "microsoft", "capabilities": ["chat"], "contextWindow": 131072},
  { "id": "microsoft/phi-3-mini-128k-instruct", "label": "Phi-3 Mini 128K", "publisher": "microsoft", "capabilities": ["chat"], "contextWindow": 131072},
  { "id": "microsoft/phi-3.5-vision-instruct", "label": "Phi-3.5 Vision", "publisher": "microsoft", "capabilities": ["chat", "vision"], "contextWindow": 131072},
  { "id": "microsoft/phi-4-multimodal-instruct", "label": "Phi-4 Multimodal", "publisher": "microsoft", "capabilities": ["chat", "vision"], "contextWindow": 131072},
  { "id": "moonshotai/kimi-k2-instruct-0905", "label": "Kimi K2 Instruct 0905", "publisher": "moonshotai", "capabilities": ["chat", "tool_use", "long_context"], "contextWindow": 262144},
  { "id": "minimaxai/minimax-m2", "label": "MiniMax M2", "publisher": "minimaxai", "capabilities": ["chat", "reasoning", "tool_use"], "contextWindow": 204800},
  { "id": "minimaxai/minimax-m1-40k", "label": "MiniMax M1 40K", "publisher": "minimaxai", "capabilities": ["chat", "reasoning"], "contextWindow": 40960},
  { "id": "ibm-granite/granite-3.3-8b-instruct", "label": "Granite 3.3 8B", "publisher": "ibm-granite", "capabilities": ["chat"], "contextWindow": 131072},
  { "id": "ibm-granite/granite-34b-code-instruct", "label": "Granite 34B Code", "publisher": "ibm-granite", "capabilities": ["chat", "code"], "contextWindow": 131072},
  { "id": "ibm-granite/granite-vision-3.2-2b", "label": "Granite Vision 3.2 2B", "publisher": "ibm-granite", "capabilities": ["chat", "vision"], "contextWindow": 131072},
  { "id": "bytedance/seed-oss-36b-instruct", "label": "Seed OSS 36B", "publisher": "bytedance", "capabilities": ["chat", "reasoning"], "contextWindow": 262144},
  { "id": "stepfun-ai/step-3.5-flash", "label": "Step 3.5 Flash", "publisher": "stepfun-ai", "capabilities": ["chat", "reasoning"], "contextWindow": 131072},
  { "id": "poolside/laguna-xs-2", "label": "Laguna XS.2", "publisher": "poolside", "capabilities": ["chat", "code"], "contextWindow": 131072},
  { "id": "sarvamai/sarvam-m", "label": "Sarvam M", "publisher": "sarvamai", "capabilities": ["chat"], "contextWindow": 32768},
  { "id": "stockmark/stockmark-2-100b-instruct", "label": "Stockmark 2 100B", "publisher": "stockmark", "capabilities": ["chat"], "contextWindow": 32768},
  { "id": "upstage/solar-10.7b-instruct", "label": "SOLAR 10.7B", "publisher": "upstage", "capabilities": ["chat"], "contextWindow": 4096},
  { "id": "writer/palmyra-med-70b", "label": "Palmyra Med 70B", "publisher": "writer", "capabilities": ["chat"], "contextWindow": 32768},
  { "id": "adept/fuyu-8b", "label": "Fuyu 8B", "publisher": "adept", "capabilities": ["vision"], "contextWindow": 4096},
  { "id": "01-ai/yi-large", "label": "Yi Large", "publisher": "01-ai", "capabilities": ["chat"], "contextWindow": 32768},
  { "id": "nvidia/nv-embedqa-mistral-7b-v2", "label": "NV EmbedQA Mistral 7B v2", "publisher": "nvidia", "capabilities": ["embedding"], "contextWindow": 4096},
  { "id": "nvidia/llama-3.2-nemoretriever-300m-embed-v1", "label": "NeMo Retriever Embed 300M", "publisher": "nvidia", "capabilities": ["embedding"], "contextWindow": 8192},
  { "id": "nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1", "label": "NeMo Retriever VLM Embed 1B", "publisher": "nvidia", "capabilities": ["embedding", "vision"], "contextWindow": 8192},
  { "id": "snowflake/arctic-embed-l", "label": "Arctic Embed L", "publisher": "snowflake", "capabilities": ["embedding"], "contextWindow": 512},
  { "id": "nvidia/nvclip", "label": "NVCLIP", "publisher": "nvidia", "capabilities": ["embedding", "vision"], "contextWindow": 77},
  { "id": "nvidia/llama-nemotron-rerank-vl-1b-v2", "label": "Nemotron Rerank VL 1B v2", "publisher": "nvidia", "capabilities": ["rerank", "vision"], "contextWindow": 8192},
  { "id": "nvidia/llama-3.1-nemoguard-8b-topic-control", "label": "NeMoGuard Topic Control 8B", "publisher": "nvidia", "capabilities": ["safety"], "contextWindow": 128000},
  { "id": "nvidia/nemoretriever-parse", "label": "NeMo Retriever Parse", "publisher": "nvidia", "capabilities": ["vision"], "contextWindow": 32768},
  { "id": "nvidia/nemoretriever-ocr-v1", "label": "NeMo Retriever OCR", "publisher": "nvidia", "capabilities": ["vision"], "contextWindow": 8192},
  { "id": "nvidia/parakeet-tdt-0.6b-v2", "label": "Parakeet TDT 0.6B v2", "publisher": "nvidia", "capabilities": ["audio"]},
  { "id": "nvidia/canary-1b", "label": "Canary 1B", "publisher": "nvidia", "capabilities": ["audio"]},
  { "id": "openai/whisper-large-v3", "label": "Whisper Large v3", "publisher": "openai", "capabilities": ["audio"]},
  { "id": "nvidia/esm2-650m", "label": "ESM2 650M", "publisher": "nvidia", "capabilities": ["biology"]},
  { "id": "nvidia/esmfold", "label": "ESMFold", "publisher": "nvidia", "capabilities": ["biology"]},
  { "id": "nvidia/molmim", "label": "MolMIM", "publisher": "nvidia", "capabilities": ["biology"]},
  { "id": "black-forest-labs/flux.1-schnell", "label": "FLUX.1 Schnell", "publisher": "black-forest-labs", "capabilities": ["image"]},
  { "id": "black-forest-labs/flux.1-kontext-dev", "label": "FLUX.1 Kontext Dev", "publisher": "black-forest-labs", "capabilities": ["image"]},
  { "id": "stabilityai/stable-diffusion-xl", "label": "Stable Diffusion XL", "publisher": "stabilityai", "capabilities": ["image"]},
  { "id": "nvidia/sana", "label": "SANA", "publisher": "nvidia", "capabilities": ["image"]},
];

/** Everything this app knows about, curated presets first. */
export const MODEL_CATALOG = [...MODEL_PRESETS, ...EXTRA_CATALOG];

const PATTERNS = [
  ["embedding", /(^|[\/-])(embed|embedqa|bge-m3|nvclip|arctic-embed)/],
  ["rerank", /(^|[\/-])(rerank|ranking)/],
  ["safety", /(guard|safety|jailbreak|gliner-pii|moderation|topic-control)/],
  ["image", /(^|[\/-])(sdxl|stable-diffusion|flux|edify|image|sana|kandinsky)/],
  ["vision", /(vision|(^|[\/-])vl([\/-]|$)|vlm|llava|pixmo|nemotron-nano-vl)/],
  ["code", /(coder|codegen|starcoder|codestral|usdcode|deepseek-coder)/],
  ["reasoning", /(reason|thinking|r1([\/-]|$)|qwq|nemotron|ultra|super|o1|o3)/],
];

/** Best-effort capability inference for model ids that are not in the presets. */
export function inferCapabilities(id) {
  const caps = new Set();
  const value = String(id).toLowerCase();
  for (const [capability, pattern] of PATTERNS) {
    if (pattern.test(value)) caps.add(capability);
  }
  if (caps.has("embedding") || caps.has("rerank") || caps.has("image")) caps.delete("chat");
  else if (!caps.has("safety") && !caps.has("vision")) caps.add("chat");
  if (!caps.size) caps.add("chat");
  if (!caps.has("chat") && !caps.has("embedding") && !caps.has("rerank") && !caps.has("image") && !caps.has("safety")) {
    caps.add("chat");
  }
  return [...caps];
}

export function describeModel(id, extra = {}) {
  const preset = MODEL_CATALOG.find((entry) => entry.id === id);
  const [publisher] = String(id).split("/");
  return {
    id,
    publisher: preset?.publisher ?? publisher ?? "unknown",
    label: preset?.label ?? humanize(id),
    capabilities: preset?.capabilities ?? inferCapabilities(id),
    contextWindow: preset?.contextWindow ?? null,
    curated: Boolean(preset),
    ...extra,
  };
}

export function humanize(id) {
  const tail = String(id).split("/").pop() ?? String(id);
  return tail
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\b(\d+)b\b/gi, "$1B");
}

/**
 * Assign a concrete model to every agent role.
 * Live models win; curated presets fill gaps; the first candidate is the floor.
 */
export function resolveRoles(availableModelIds = []) {
  const available = new Set(availableModelIds);
  const byCapability = new Map();
  for (const id of availableModelIds) {
    for (const capability of describeModel(id).capabilities) {
      if (!byCapability.has(capability)) byCapability.set(capability, []);
      byCapability.get(capability).push(id);
    }
  }
  const roles = {};
  for (const [role, definition] of Object.entries(ROLE_DEFINITIONS)) {
    const preferred = definition.candidates.find((candidate) => available.has(candidate));
    const capable = (byCapability.get(definition.capability) ?? []).find((id) => !/(guard|safety)/.test(id) || definition.capability === "safety");
    roles[role] = {
      role,
      label: definition.label,
      title: definition.title,
      description: definition.description,
      capability: definition.capability,
      model: preferred ?? capable ?? definition.candidates[0],
      temperature: definition.temperature,
      maxTokens: definition.maxTokens,
      resolvedFrom: preferred ? "pinned" : capable ? "discovered" : "default",
    };
  }
  return roles;
}

/** OpenAI-style function schemas exposed to the Operator agent and the chat lab. */
export const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_knowledge",
      description:
        "Search the company knowledge base (uploaded documents and past run deliverables) and return the most relevant passages. Use before writing anything that depends on company-specific facts.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for." },
          top_k: { type: "integer", description: "How many passages to return (1-10).", default: 4 },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Evaluate an arithmetic expression (supports + - * / % ** and parentheses).",
      parameters: {
        type: "object",
        properties: { expression: { type: "string" } },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_artifact",
      description:
        "Save a deliverable (markdown, JSON, code, plan) to the run workspace so it can be reviewed and downloaded. Always save substantial deliverables instead of only describing them.",
      parameters: {
        type: "object",
        properties: {
          filename: { type: "string", description: "File name with extension, e.g. launch-plan.md" },
          content: { type: "string" },
        },
        required: ["filename", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "safety_check",
      description: "Run NVIDIA safety guardrails over a piece of text before it is published or sent.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_visual",
      description: "Generate an image from a prompt using an NVIDIA-hosted diffusion model.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          aspect_ratio: { type: "string", enum: ["1024x1024", "1344x768", "768x1344"] },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_human",
      description:
        "Stop and ask the operator for a decision when work needs approval, spend, credentials or information you cannot obtain.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          why_blocked: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["question", "why_blocked"],
      },
    },
  },
];

export const TOOL_NAMES = AGENT_TOOLS.map((tool) => tool.function.name);

/** Primary capability order used by the Settings → Models browser. */
export const CAPABILITY_ORDER = [
  "chat",
  "reasoning",
  "tool_use",
  "vision",
  "code",
  "long_context",
  "embedding",
  "rerank",
  "safety",
  "image",
  "audio",
  "biology",
];

/**
 * Specific families win over the generic ones so a vision or code model shows up
 * under Vision/Code rather than disappearing into the chat bucket. Everything
 * else (chat, reasoning, tool use, long context) is grouped as Chat.
 */
export const FAMILY_PRIORITY = ["embedding", "rerank", "safety", "image", "audio", "biology", "vision", "code"];

export function primaryFamily(model) {
  const capabilities = model.capabilities ?? [];
  return FAMILY_PRIORITY.find((family) => capabilities.includes(family)) ?? "chat";
}

/**
 * Group models once each by their primary family so the catalog reads as
 * families instead of an alphabetical wall of ids.
 */
export function groupCatalog(models) {
  const groups = new Map();
  for (const model of models) {
    const primary = primaryFamily(model);
    if (!groups.has(primary)) groups.set(primary, []);
    groups.get(primary).push(model);
  }
  return CAPABILITY_ORDER.filter((capability) => groups.has(capability)).map((capability) => ({
    capability,
    label: CAPABILITY_LABELS[capability] ?? capability,
    models: groups.get(capability).sort((a, b) => String(a.id).localeCompare(String(b.id))),
  }));
}
