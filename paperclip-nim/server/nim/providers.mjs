/**
 * Providers — the "one key, every model" layer.
 *
 * build.nvidia.com hands out a single key that unlocks the whole hosted NIM
 * catalog, and half the ecosystem speaks the same OpenAI-compatible dialect, so
 * the same intake should work for an NVIDIA snippet, an OpenAI snippet or a Groq
 * one. This module owns three things:
 *
 *   1. REGISTRY  — what a provider is: base URL, key shape, docs, sample snippet.
 *   2. DETECTION — pull provider + base URL + key + model out of pasted text.
 *   3. STORE     — which providers are configured, with which key and models.
 *
 * Keys never leave the machine: the vault holds them (data/keys.json, 0600) and
 * the browser only ever sees a mask.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.mjs";
import { findModel } from "./catalog.mjs";

/* ------------------------------------------------------------- registry -- */

export const PROVIDERS = [
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    short: "NVIDIA",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    hosts: ["integrate.api.nvidia.com", "build.nvidia.com", "api.nvcf.nvidia.com"],
    keyPrefixes: ["nvapi-"],
    keyHint: "nvapi-…",
    docs: "https://build.nvidia.com/models",
    models: "all",
    blurb: "One key from build.nvidia.com unlocks every hosted NIM: all 97 catalog models, on every endpoint family.",
    sampleModel: "openai/gpt-oss-20b",
    snippet: [
      "from openai import OpenAI",
      "",
      'client = OpenAI(',
      '  base_url="https://integrate.api.nvidia.com/v1",',
      '  api_key="nvapi-..."',
      ")",
      "",
      "response = client.chat.completions.create(",
      '  model="openai/gpt-oss-20b",',
      '  messages=[{"role": "user", "content": "Hello"}],',
      ")",
    ].join("\n"),
  },
  {
    id: "openai",
    name: "OpenAI",
    short: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    hosts: ["api.openai.com"],
    keyPrefixes: ["sk-proj-", "sk-"],
    keyHint: "sk-…",
    docs: "https://platform.openai.com/api-keys",
    models: "listed",
    blurb: "Chat, reasoning and embeddings from api.openai.com. Same wire format as NIM.",
    sampleModel: "gpt-4o-mini",
    snippet: [
      "curl https://api.openai.com/v1/chat/completions \\",
      '  -H "Authorization: Bearer sk-..." \\',
      '  -H "Content-Type: application/json" \\',
      '  -d \'{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}\'',
    ].join("\n"),
  },
  {
    id: "groq",
    name: "Groq",
    short: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    hosts: ["api.groq.com"],
    keyPrefixes: ["gsk_"],
    keyHint: "gsk_…",
    docs: "https://console.groq.com/keys",
    models: "listed",
    blurb: "LPU inference — very low latency chat and tool calls at api.groq.com.",
    sampleModel: "llama-3.3-70b-versatile",
    snippet: [
      "from groq import Groq",
      "",
      'client = Groq(api_key="gsk_...")',
      "",
      "chat = client.chat.completions.create(",
      '  model="llama-3.3-70b-versatile",',
      '  messages=[{"role": "user", "content": "Hello"}],',
      ")",
    ].join("\n"),
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    short: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    hosts: ["openrouter.ai"],
    keyPrefixes: ["sk-or-v1-"],
    keyHint: "sk-or-v1-…",
    docs: "https://openrouter.ai/keys",
    models: "listed",
    blurb: "One key across hundreds of hosted models, OpenAI-compatible.",
    sampleModel: "nvidia/nemotron-3-super-120b-a12b",
  },
  {
    id: "together",
    name: "Together AI",
    short: "Together",
    baseUrl: "https://api.together.xyz/v1",
    hosts: ["api.together.xyz", "api.together.ai"],
    keyPrefixes: [],
    keyHint: "64-char key",
    docs: "https://api.together.ai/settings/api-keys",
    models: "listed",
    blurb: "Open-weight models including NVIDIA Nemotron checkpoints.",
    sampleModel: "nvidia/llama-3.1-nemotron-70b-instruct",
  },
  {
    id: "mistral",
    name: "Mistral",
    short: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    hosts: ["api.mistral.ai"],
    keyPrefixes: [],
    keyHint: "32-char key",
    docs: "https://console.mistral.ai/api-keys",
    models: "listed",
    blurb: "Mistral's own endpoints — the same Codestral/Magistral weights NIM serves.",
    sampleModel: "mistral-large-latest",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    short: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    hosts: ["api.deepseek.com"],
    keyPrefixes: ["sk-"],
    keyHint: "sk-…",
    docs: "https://platform.deepseek.com/api_keys",
    models: "listed",
    blurb: "DeepSeek chat and reasoner, OpenAI-compatible.",
    sampleModel: "deepseek-chat",
  },
  {
    id: "fireworks",
    name: "Fireworks AI",
    short: "Fireworks",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    hosts: ["api.fireworks.ai"],
    keyPrefixes: [],
    keyHint: "fw_…",
    docs: "https://fireworks.ai/account/api-keys",
    models: "listed",
    blurb: "Fast serverless inference for open-weight models.",
    sampleModel: "accounts/fireworks/models/llama-v3p1-70b-instruct",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    short: "Perplexity",
    baseUrl: "https://api.perplexity.ai",
    hosts: ["api.perplexity.ai"],
    keyPrefixes: ["pplx-"],
    keyHint: "pplx-…",
    docs: "https://www.perplexity.ai/settings/api",
    models: "listed",
    blurb: "Search-grounded Sonar models.",
    sampleModel: "sonar",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    short: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    hosts: ["api.anthropic.com"],
    keyPrefixes: ["sk-ant-"],
    keyHint: "sk-ant-…",
    docs: "https://console.anthropic.com/settings/keys",
    models: "listed",
    blurb: "Claude models. Anthropic's API is not OpenAI-shaped; Paperclip treats it as a catalog source, not a drop-in engine.",
    sampleModel: "claude-sonnet-4-5",
    native: true,
  },
];

export const PROVIDER_IDS = PROVIDERS.map((provider) => provider.id);

export function getProvider(id) {
  return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

export function providerSummary(provider) {
  return {
    id: provider.id,
    name: provider.name,
    short: provider.short,
    baseUrl: provider.baseUrl,
    host: hostOf(provider.baseUrl),
    keyHint: provider.keyHint,
    docs: provider.docs,
    blurb: provider.blurb,
    models: provider.models,
    sampleModel: provider.sampleModel ?? null,
    snippet: provider.snippet ?? null,
    native: Boolean(provider.native),
  };
}

export function allProviderSummaries() {
  return PROVIDERS.map(providerSummary);
}

/* ------------------------------------------------------------ detection -- */

const KEY_PATTERNS = [
  { providerId: "nvidia", pattern: /\bnvapi-[A-Za-z0-9_-]{16,}\b/ },
  { providerId: "groq", pattern: /\bgsk_[A-Za-z0-9]{20,}\b/ },
  { providerId: "openrouter", pattern: /\bsk-or-v1-[A-Za-z0-9]{20,}\b/ },
  { providerId: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { providerId: "openai", pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { providerId: "perplexity", pattern: /\bpplx-[A-Za-z0-9]{20,}\b/ },
  { providerId: "openai", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
];

const GENERIC_KEY = /(?:api[_-]?key|apikey|access[_-]?token|token|authorization)["']?\s*[:=]\s*(?:Bearer\s+)?["']?([A-Za-z0-9_.:-]{20,})["']?/i;
const BEARER = /\bBearer\s+([A-Za-z0-9_.:-]{20,})/i;

const BASE_URL_PATTERNS = [
  /\bbase[_-]?url["']?\s*[:=]\s*["']([^"'\s]+)["']/i,
  /\bbaseURL["']?\s*[:=]\s*["']([^"'\s]+)["']/i,
  /(?:curl|wget|fetch|post|url)\s+(?:-\S+\s+)*["']?(https?:\/\/[^\s"'\\)]+)/i,
  /["'](https?:\/\/[^"'\s]+)["']/,
  /\b(https?:\/\/[^\s"'`\\)]+)/,
];

const MODEL_PATTERNS = [
  /\bmodel\s*[:=]\s*["']([^"']+)["']/i,
  /["']model["']\s*:\s*["']([^"']+)["']/i,
  /--model[= ]([A-Za-z0-9._:/-]+)/i,
  /-m\s+([A-Za-z0-9._:/-]+)/,
];

const PLACEHOLDER = /^(?:\.{3,}|<.*>|x{3,}|your[_-]|<your|api[_-]?key|token|\.\.\.)$/i;

function isPlaceholder(value) {
  if (!value) return true;
  const trimmed = value.trim();
  return PLACEHOLDER.test(trimmed) || /\.\.\.$/.test(trimmed) || /^your[_-]/i.test(trimmed);
}

export function hostOf(value) {
  try {
    return new URL(String(value)).host.toLowerCase();
  } catch {
    return "";
  }
}

function providerByHost(host) {
  if (!host) return null;
  return (
    PROVIDERS.find((provider) => provider.hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) ?? null
  );
}

function providerByKey(key) {
  if (!key) return null;
  // Longest prefix wins so `sk-or-v1-` is not mistaken for `sk-`.
  const matches = KEY_PATTERNS.filter((entry) => entry.pattern.test(key));
  if (!matches.length) return null;
  const provider = getProvider(matches[0].providerId);
  return provider ?? null;
}

function providerByLibrary(text) {
  const lower = text.toLowerCase();
  if (/from\s+groq|import\s+groq|groq\.chat/.test(lower)) return getProvider("groq");
  if (/langchain[_-]nvidia|nemoguard|nemo_retriever|nvcf|nim\b/.test(lower)) return getProvider("nvidia");
  if (/from\s+openai|import\s+openai|openai\.chat|openai\.completions/.test(lower)) return getProvider("openai");
  if (/from\s+anthropic|anthropic\.messages/.test(lower)) return getProvider("anthropic");
  if (/together\.xyz|from\s+together/.test(lower)) return getProvider("together");
  if (/mistralai|from\s+mistralai/.test(lower)) return getProvider("mistral");
  if (/deepseek/.test(lower) && !/deepseek-ai\//.test(lower)) return getProvider("deepseek");
  if (/fireworks/.test(lower)) return getProvider("fireworks");
  if (/openrouter/.test(lower)) return getProvider("openrouter");
  if (/perplexity|sonar/.test(lower)) return getProvider("perplexity");
  return null;
}

function extractKey(text) {
  for (const { providerId, pattern } of KEY_PATTERNS) {
    const match = text.match(pattern);
    if (match) return { key: match[0], providerId, signal: `key prefix ${match[0].slice(0, 6)}…` };
  }
  const generic = text.match(GENERIC_KEY);
  if (generic && !isPlaceholder(generic[1])) {
    return { key: generic[1], providerId: null, signal: "api_key assignment" };
  }
  const bearer = text.match(BEARER);
  if (bearer && !isPlaceholder(bearer[1])) {
    return { key: bearer[1], providerId: null, signal: "Authorization: Bearer header" };
  }
  return { key: "", providerId: null, signal: null };
}

function extractBaseUrl(text) {
  for (const pattern of BASE_URL_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      const candidate = match[1].replace(/["'`\\)\],;]+$/, "");
      if (/^https?:\/\//i.test(candidate)) return candidate.replace(/\/+$/, "");
    }
  }
  return "";
}

function extractModel(text) {
  for (const pattern of MODEL_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1] && !isPlaceholder(match[1]) && !/^https?:/i.test(match[1])) return match[1];
  }
  return "";
}

function normalizeBaseUrl(value, provider) {
  const fallback = provider?.baseUrl ?? "";
  if (!value) return fallback;
  try {
    const url = new URL(value);
    let pathname = url.pathname.replace(/\/+$/, "");
    // Snippets often paste the full endpoint; providers want the root.
    pathname = pathname
      .replace(/\/(chat\/completions|completions|embeddings|responses|messages|ranking)$/i, "")
      .replace(/\/+$/, "");
    return `${url.origin}${pathname}`;
  } catch {
    return fallback;
  }
}

/**
 * Read a pasted snippet and say what it configures.
 * Pure: no I/O, no writes — safe to call on every keystroke.
 */
export function detectSetup(input) {
  const text = String(input ?? "").replace(/\r\n?/g, "\n").trim();
  if (!text) {
    return {
      ok: false,
      providerId: null,
      provider: null,
      baseUrl: "",
      key: "",
      keyMasked: "",
      model: "",
      host: "",
      confidence: "none",
      signals: [],
      warnings: ["Nothing pasted yet."],
    };
  }

  const signals = [];
  const warnings = [];
  const extractedKey = extractKey(text);
  const baseUrlRaw = extractBaseUrl(text);
  const host = hostOf(baseUrlRaw);
  const byHost = providerByHost(host);
  const byKey = extractedKey.providerId ? getProvider(extractedKey.providerId) : providerByKey(extractedKey.key);
  const byLibrary = providerByLibrary(text);

  let provider = byHost ?? byKey ?? byLibrary;
  let confidence = "low";
  if (byHost && byKey && byHost.id === byKey.id) confidence = "high";
  else if (byHost) confidence = "high";
  // A vendor-specific key prefix (nvapi-, gsk_, sk-or-v1-, sk-ant-, pplx-) is
  // conclusive on its own; a plain `sk-` is not, since several vendors use it.
  else if (byKey) confidence = byKey.id === "openai" ? "medium" : "high";
  else if (byLibrary) confidence = "medium";

  if (byHost) signals.push(`base URL host ${host}`);
  if (extractedKey.signal) signals.push(extractedKey.signal);
  if (byLibrary) signals.push(`${byLibrary.name} SDK import`);

  if (!provider && extractedKey.key) {
    // Unknown key shape but a real credential: keep it, flag it.
    warnings.push("Key found, but the provider could not be identified from the snippet. Pick one below.");
  }
  if (!extractedKey.key) {
    const envKey = /os\.environ|process\.env|getenv\(|ENV\[/i.test(text);
    const template = /\b(?:nvapi-|gsk_|sk-|sk-proj-|pplx-)\s*\.{3}|(["'])(?:nvapi-|gsk_|sk-|sk-proj-|pplx-)[^"']*\.{3}\1/.test(text);
    warnings.push(
      envKey
        ? "This snippet reads the key from an environment variable, so there is nothing to extract — paste the key itself (or a snippet with it inlined)."
        : template
          ? "That is the provider's template: the key is still a placeholder (nvapi-… / gsk_… / sk-…). Swap in your real key, or type it into the field below."
          : "No API key found in that snippet.",
    );
  }

  let baseUrl = normalizeBaseUrl(baseUrlRaw, provider);
  if (!baseUrl && provider) baseUrl = provider.baseUrl;

  if (host && !byHost) {
    warnings.push(`${host} is not a known provider — it will be added as a custom OpenAI-compatible endpoint.`);
  }

  const model = extractModel(text);
  if (model && !byHost && byKey?.id === "nvidia" && /^gpt-|^o\d/.test(model)) {
    warnings.push(`“${model}” looks like an OpenAI model, but the key is an NVIDIA key.`);
  }

  return {
    ok: Boolean(extractedKey.key || baseUrl || provider),
    providerId: provider?.id ?? (host ? "custom" : null),
    provider: provider ? providerSummary(provider) : null,
    detectedName: provider?.name ?? (host || null),
    baseUrl,
    host,
    key: extractedKey.key,
    keyMasked: extractedKey.key ? maskSecret(extractedKey.key) : "",
    model,
    models: model ? [model] : [],
    confidence,
    signals,
    warnings,
  };
}

export function maskSecret(key) {
  if (!key) return "";
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/* ---------------------------------------------------------------- store -- */

export const providerStorePath = join(paths.data, "providers.json");

function readStore() {
  try {
    if (!existsSync(providerStorePath)) return { providers: [] };
    const parsed = JSON.parse(readFileSync(providerStorePath, "utf8"));
    return { providers: Array.isArray(parsed.providers) ? parsed.providers : [] };
  } catch {
    return { providers: [] };
  }
}

function writeStore(providers) {
  mkdirSync(paths.data, { recursive: true });
  writeFileSync(providerStorePath, `${JSON.stringify({ providers }, null, 2)}\n`, { mode: 0o600 });
  return providers;
}

export function loadProviders() {
  return readStore().providers.map((entry) => ({
    id: entry.id ?? entry.providerId ?? "custom",
    providerId: entry.providerId ?? entry.id ?? "custom",
    name: entry.name ?? getProvider(entry.providerId)?.name ?? entry.providerId ?? "Custom",
    baseUrl: entry.baseUrl ?? getProvider(entry.providerId)?.baseUrl ?? "",
    keyId: entry.keyId ?? null,
    models: Array.isArray(entry.models) ? entry.models : [],
    source: entry.source ?? "manual",
    verified: Boolean(entry.verified),
    modelCount: entry.modelCount ?? null,
    createdAt: entry.createdAt ?? new Date().toISOString(),
    updatedAt: entry.updatedAt ?? entry.createdAt ?? new Date().toISOString(),
  }));
}

/**
 * Insert or update a provider connection. One connection per provider id:
 * pasting a second snippet re-points it rather than piling up duplicates.
 */
export function upsertProvider({ providerId, name, baseUrl, keyId = null, models = [], source = "manual", verified = false, modelCount = null }) {
  const known = getProvider(providerId);
  const providers = loadProviders();
  const existing = providers.find((entry) => entry.id === providerId);
  const mergedModels = [...new Set([...(existing?.models ?? []), ...models.filter(Boolean)])];
  const next = {
    id: providerId,
    providerId,
    name: name ?? known?.name ?? existing?.name ?? providerId,
    baseUrl: baseUrl ?? known?.baseUrl ?? existing?.baseUrl ?? "",
    keyId: keyId ?? existing?.keyId ?? null,
    models: mergedModels,
    source,
    verified: verified || Boolean(existing?.verified),
    modelCount: modelCount ?? existing?.modelCount ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeStore([...providers.filter((entry) => entry.id !== providerId), next]);
  return next;
}

export function addProviderModel(providerId, model) {
  const providers = loadProviders();
  const existing = providers.find((entry) => entry.id === providerId);
  if (!existing) {
    const error = new Error(`No ${providerId} connection configured yet.`);
    error.status = 404;
    error.code = "provider_missing";
    throw error;
  }
  if (existing.models.includes(model)) return providersView().find((entry) => entry.id === providerId);
  writeStore(providers.map((entry) => (entry.id === providerId ? { ...entry, models: [...entry.models, model], updatedAt: new Date().toISOString() } : entry)));
  return providersView().find((entry) => entry.id === providerId);
}

export function removeProvider(providerId) {
  const providers = loadProviders();
  writeStore(providers.filter((entry) => entry.id !== providerId));
  return providerId;
}

/** Providers with their credential resolved, for the client and the UI. */
export function resolveProviders({ vault = [] } = {}) {
  return loadProviders().map((entry) => {
    const key = vault.find((candidate) => candidate.id === entry.keyId) ?? vault.find((candidate) => candidate.providerId === entry.providerId);
    const known = getProvider(entry.providerId);
    return {
      ...entry,
      baseUrl: entry.baseUrl || known?.baseUrl || "",
      apiKey: key?.key ?? "",
      keyHint: key ? maskSecret(key.key) : "",
      keyPresent: Boolean(key?.key),
      models: entry.models,
      coversAllNvidia: entry.providerId === "nvidia",
      docs: known?.docs ?? "",
    };
  });
}

export function providersView({ vault = [] } = {}) {
  return resolveProviders({ vault }).map((entry) => ({
    id: entry.id,
    providerId: entry.providerId,
    name: entry.name,
    baseUrl: entry.baseUrl,
    host: hostOf(entry.baseUrl),
    keyHint: entry.keyHint,
    keyPresent: entry.keyPresent,
    models: entry.models,
    modelCount: entry.modelCount,
    coversAllNvidia: entry.coversAllNvidia,
    docs: entry.docs,
    source: entry.source,
    verified: entry.verified,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  }));
}

/**
 * Models that arrived from a pasted snippet, shaped like catalog entries so the
 * Models view, the Studio picker and the engine can all treat them the same.
 */
export function customModels({ vault = [] } = {}) {
  const out = [];
  for (const provider of resolveProviders({ vault })) {
    for (const model of provider.models) {
      // NIM already serves its whole catalog; only note models it does not list.
      if (provider.providerId === "nvidia" && findModel(model)) continue;
      out.push({
        id: model,
        name: model.split("/").pop(),
        family: provider.name,
        vendor: provider.name,
        capabilities: ["chat", "tools"],
        contextK: null,
        rate: { in: 0, out: 0 },
        source: "connected",
        status: "available",
        verified: provider.verified,
        providerId: provider.providerId,
        providerName: provider.name,
        baseUrl: provider.baseUrl,
        note: `Added from a ${provider.name} snippet. Calls route to ${provider.baseUrl}.`,
      });
    }
  }
  return out;
}

/** Which provider owns a model id? NVIDIA covers the whole catalog. */
export function providerForModel(modelId, { vault = [] } = {}) {
  const providers = resolveProviders({ vault });
  const exact = providers.find((entry) => entry.models.includes(modelId));
  if (exact) return exact;
  const nvidia = providers.find((entry) => entry.providerId === "nvidia");
  if (nvidia && !providers.some((entry) => entry.models.includes(modelId))) {
    // Anything the catalog knows and no other provider claims belongs to NIM.
    return nvidia.coversAllNvidia ? nvidia : null;
  }
  return null;
}
