/**
 * Credential intake.
 *
 * People do not paste a bare key. They paste whatever their notes, a curl
 * command, or an SDK snippet contains — usually the whole thing, quotes and
 * `Bearer` and all. This module finds the key, the endpoints, the models and
 * the request parameters in that text so the app can configure itself from one
 * paste, and it verifies the credential before anything is switched to live.
 *
 * It never logs, stores in events, or returns a full key.
 */

export const NVIDIA_DEFAULTS = {
  nimBaseUrl: "https://integrate.api.nvidia.com/v1",
  genaiBaseUrl: "https://ai.api.nvidia.com/v1/genai",
};

const KEY_PATTERN = /\bnvapi-[A-Za-z0-9_-]{16,}/g;
const ENV_KEY_PATTERN = /NVIDIA_API_KEY\s*[=:]\s*["']?([A-Za-z0-9._-]{20,})/;
const MIME_PUBLISHERS = new Set([
  "text",
  "application",
  "image",
  "audio",
  "video",
  "multipart",
  "font",
  "model",
  "message",
]);
const PARAM_KEYS = {
  temperature: "temperature",
  top_p: "topP",
  topP: "topP",
  max_tokens: "maxTokens",
  maxTokens: "maxTokens",
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
  reasoning_effort: "reasoningEffort",
};

export function maskKey(key) {
  const value = String(key ?? "");
  if (!value) return null;
  if (value.length <= 8) return "••••";
  return `••••${value.slice(-4)}`;
}

function unquote(value) {
  return String(value ?? "").replace(/^["'`\s]+|["'`\s]+$/g, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function hostOf(url) {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Pull the chat/embeddings base URL and the visual generative AI base URL out of
 * free text. Handles `.../v1/chat/completions` invoke URLs, `.../v1/genai/...`
 * and bare hosts.
 */
function extractBaseUrls(text) {
  const candidates = unique(
    [...String(text).matchAll(/https?:\/\/[^\s"'`<>,;()[\]]+/gi)].map((match) => unquote(match[0]).replace(/[.,;)]+$/, "")),
  );
  let nimBaseUrl = null;
  let genaiBaseUrl = null;

  for (const candidate of candidates) {
    const genai = candidate.match(/^(https?:\/\/[^\s"'`]+?\/v1\/genai)(?:\/|$)/i);
    if (genai) {
      genaiBaseUrl = genaiBaseUrl ?? genai[1];
      continue;
    }
    let url;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    // Drop the operation path so we keep the API root.
    const path = url.pathname
      .replace(/\/(chat\/completions|completions|embeddings|ranking|models|health)\/?$/i, "")
      .replace(/\/+$/, "");
    const v1 = path.match(/^(.*?\/v1)(?:\/|$)/i);
    const base = v1 ? `${url.origin}${v1[1]}` : path === "" ? `${url.origin}/v1` : null;
    if (!base) continue;
    // `ai.api.nvidia.com` only serves the generative-image host; don't use it as
    // the chat base unless it is the only thing we were given.
    if (/^ai\.api\.nvidia\.com$/i.test(url.host) && candidates.length > 1 && !nimBaseUrl) continue;
    nimBaseUrl = nimBaseUrl ?? base;
  }

  return { nimBaseUrl, genaiBaseUrl };
}

function extractModels(text) {
  const found = [];
  const source = String(text);

  for (const match of source.matchAll(/["']model["']\s*:\s*["']([^"']+)["']/gi)) {
    found.push(unquote(match[1]));
  }
  // Unquoted `model: publisher/id` (YAML, .env files, curl --data-raw bodies).
  for (const match of source.matchAll(/\bmodel\b\s*[:=]\s*([a-z0-9][\w.-]*\/[\w.:@-]+)/gi)) {
    found.push(match[1]);
  }
  // Any quoted `publisher/model` token, which covers SDK snippets that only
  // mention the id in a variable.
  for (const match of source.matchAll(/["']([a-z0-9][\w.-]*\/[\w.:@-]+)["']/gi)) {
    const value = match[1];
    const publisher = value.split("/")[0].toLowerCase();
    if (MIME_PUBLISHERS.has(publisher)) continue;
    if (/^(https?|data)$/i.test(publisher)) continue;
    found.push(value);
  }
  return unique(found.map(unquote).filter((id) => /^[\w.-]+\/[\w.:@-]+$/.test(id))).slice(0, 12);
}

function extractParams(text) {
  const params = {};
  for (const [needle, key] of Object.entries(PARAM_KEYS)) {
    const pattern = new RegExp(`["']?${needle}["']?\\s*[:=]\\s*["']?([-\\w.]+)["']?`, "i");
    const match = String(text).match(pattern);
    if (!match) continue;
    const raw = match[1];
    if (key === "reasoningEffort") {
      if (["low", "medium", "high"].includes(raw.toLowerCase())) params[key] = raw.toLowerCase();
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value)) params[key] = value;
  }
  return params;
}

/**
 * Parse arbitrary text for everything needed to configure NVIDIA inference.
 *
 * @param {string} text
 * @returns {{
 *   apiKey: string|null,
 *   keyHint: string|null,
 *   nimBaseUrl: string|null,
 *   genaiBaseUrl: string|null,
 *   models: string[],
 *   params: Record<string, number|string>,
 *   flags: { stream: boolean|null, vision: boolean, tools: boolean },
 *   warnings: string[],
 *   source: "text"|"key",
 * }}
 */
export function parseCredentialText(text) {
  const raw = typeof text === "string" ? text : text == null ? "" : JSON.stringify(text);
  const warnings = [];

  const matches = unique(raw.match(KEY_PATTERN) ?? []);
  let apiKey = matches[0] ?? null;
  if (!apiKey) {
    const envMatch = raw.match(ENV_KEY_PATTERN);
    if (envMatch) apiKey = envMatch[1];
  }
  if (!apiKey) {
    // Someone pasted only the token itself (no `nvapi-` prefix, no prose).
    const trimmed = unquote(raw);
    if (!/\s/.test(trimmed) && /^[A-Za-z0-9._-]{24,}$/.test(trimmed)) apiKey = trimmed;
  }
  if (matches.length > 1) {
    warnings.push(`Found ${matches.length} different keys in that text; using the first one.`);
  }
  if (raw.includes("••") || raw.includes("****")) {
    warnings.push("That looks like a masked key. Paste the real value from build.nvidia.com.");
  }
  if (raw.length > 0 && /nvapi-/i.test(raw) && !apiKey) {
    warnings.push("A key prefix was found but the value is too short to be complete.");
  }

  const urls = extractBaseUrls(raw);
  const models = extractModels(raw);
  const params = extractParams(raw);
  const streamMatch = raw.match(/["']?stream["']?\s*[:=]\s*(True|False|true|false)/);
  const flags = {
    stream: streamMatch ? /true/i.test(streamMatch[1]) : null,
    vision: /image_url|data:image\//i.test(raw),
    tools: /"tools"\s*:/.test(raw),
  };

  if (!apiKey) {
    warnings.push(
      "No NVIDIA key found. Paste an `nvapi-…` key, a `NVIDIA_API_KEY=…` line, or the whole request snippet — the key is extracted either way.",
    );
  }
  if (!urls.nimBaseUrl) {
    warnings.push(`No endpoint found; the default ${NVIDIA_DEFAULTS.nimBaseUrl} will be used.`);
  }
  if (!models.length) warnings.push("No model id found; the catalog from /v1/models will be used.");

  return {
    apiKey,
    keyHint: maskKey(apiKey),
    nimBaseUrl: urls.nimBaseUrl,
    genaiBaseUrl: urls.genaiBaseUrl,
    models,
    params,
    flags,
    warnings,
    source: /\s/.test(unquote(raw)) ? "text" : "key",
  };
}

function reasonForStatus(status) {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_unavailable";
  return "rejected";
}

function hintForStatus(status) {
  if (status === 401) {
    return "NVIDIA rejected the key. Create a new one at build.nvidia.com, or check that it was copied whole.";
  }
  if (status === 403) return "The key is valid but is not enabled for this endpoint or model.";
  if (status === 404) {
    return "The base URL does not expose /v1/models. It should look like https://integrate.api.nvidia.com/v1.";
  }
  if (status === 429) return "Rate limited — the key is valid; retry in a moment.";
  if (status >= 500) return "NVIDIA is unavailable right now; the key may still be fine.";
  return "Check the key and the base URL.";
}

/**
 * Verify a credential by listing models. Never throws: the caller decides what to
 * do with a failure, and an unreachable network must not be confused with a bad
 * key.
 *
 * @returns {Promise<{
 *   attempted: boolean, ok: boolean, status: number, reason?: string,
 *   hint?: string, modelCount?: number, models?: string[], latencyMs: number,
 * }>}
 */
export async function verifyCredential({ apiKey, baseUrl, timeoutMs = 12_000, fetchImpl } = {}) {
  const call = fetchImpl ?? globalThis.fetch;
  const startedAt = Date.now();
  const base = String(baseUrl || NVIDIA_DEFAULTS.nimBaseUrl).replace(/\/+$/, "");
  if (!apiKey) {
    return { attempted: false, ok: false, status: 0, reason: "missing_key", hint: "No key to verify.", latencyMs: 0 };
  }
  if (typeof call !== "function") {
    return { attempted: false, ok: false, status: 0, reason: "no_fetch", latencyMs: 0 };
  }
  try {
    const response = await call(`${base}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text().catch(() => "");
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        attempted: true,
        ok: false,
        status: response.status,
        reason: reasonForStatus(response.status),
        hint: hintForStatus(response.status),
        latencyMs,
        detail: text.slice(0, 300),
      };
    }
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const models = (payload?.data ?? [])
      .map((entry) => entry?.id)
      .filter((id) => typeof id === "string")
      .slice(0, 500);
    return {
      attempted: true,
      ok: true,
      status: response.status,
      reason: "ok",
      modelCount: models.length,
      models,
      latencyMs,
    };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      status: 0,
      reason: "unreachable",
      hint: "This host could not reach NVIDIA. The key was saved; switch to live once the network allows it.",
      latencyMs: Date.now() - startedAt,
      detail: error?.message ?? String(error),
    };
  }
}

/** Choose which model to pre-select after an intake. */
export function pickDefaultModel(parsed, catalogIds = []) {
  const chatCapable = (id) => {
    const value = String(id).toLowerCase();
    if (/(embed|rerank|guard|safety|clip|deplot|parse|ocr|flux|diffusion|sdxl|sana)/.test(value)) return false;
    return true;
  };
  const fromPaste = (parsed?.models ?? []).filter(chatCapable);
  if (fromPaste.length) return fromPaste[0];
  const preferred = (catalogIds ?? []).filter(chatCapable);
  return preferred[0] ?? null;
}
