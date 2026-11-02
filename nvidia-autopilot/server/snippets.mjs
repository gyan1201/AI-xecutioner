/**
 * Request replay.
 *
 * Users copy a working chat-completions snippet from build.nvidia.com (or a
 * notebook, or a colleague) and expect the app to run *that* request — not a
 * re-typed approximation of it. This module extracts the payload from python,
 * curl, node or bare JSON text, normalises it to the OpenAI chat shape, and
 * reports exactly what the app will send.
 *
 * It never returns or logs the key: any Authorization header found in the text
 * is dropped from the normalised payload.
 */

const PARAM_ALIASES = {
  temperature: "temperature",
  top_p: "topP",
  topP: "topP",
  max_tokens: "maxTokens",
  maxTokens: "maxTokens",
  frequency_penalty: "frequencyPenalty",
  presence_penalty: "presencePenalty",
  reasoning_effort: "reasoningEffort",
  seed: "seed",
  stop: "stop",
  top_k: "topK",
  min_p: "minP",
  repetition_penalty: "repetitionPenalty",
  response_format: "responseFormat",
};

const MAX_TOKENS_LIMIT = 32_000;

function stripKey(text) {
  return String(text ?? "").replace(/nvapi-[A-Za-z0-9_-]{8,}/g, "nvapi-REDACTED");
}

/** Find the first balanced `{ ... }` block that starts at or after `index`. */
function balancedObject(text, index) {
  const start = text.indexOf("{", index);
  if (start === -1) return null;
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Turn a python-ish literal into JSON without executing anything. */
function pythonishToJson(source, { flags = {} } = {}) {
  let value = source
    .replace(/^\s*#.*$/gm, "")
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/\bNone\b/g, "null")
    .replace(/\/\/.*$/gm, "");

  // Bare identifiers used as values (`"stream": stream`, `image_urls[0]`) cannot
  // be evaluated: substitute known booleans or drop the whole key.
  value = value.replace(
    /("[^"]*"|'[^']*')\s*:\s*((?!(?:true|false|null)\b)[A-Za-z_$][\w$]*(?:\[[^\]]*\])?)/g,
    (match, key, identifier) => {
      const name = String(key).replace(/["']/g, "");
      if (identifier in flags) return `"${name}": ${flags[identifier]}`;
      return `"${name}":`;
    },
  );
  // Drop keys whose value was a variable we could not resolve, then tidy the
  // commas they leave behind.
  value = value.replace(/"[^"]*"\s*:\s*(?=[,}])/g, "");
  value = value.replace(/([{,])\s*,/g, "$1");
  value = value.replace(/,\s*([}\]])/g, "$1");

  const attempts = [
    value,
    // Single quotes → double quotes, but only where a quote clearly delimits a
    // string (a quote followed by `:` or `,`/`}` is a closer).
    value.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"'),
  ];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* try the next form */
    }
  }
  return null;
}

function findJsonPayload(text) {
  const trimmed = stripKey(text).trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      /* fall through to extraction */
    }
  }
  // Bare JSON body after `--data`, `-d`, `json=`, `data=`.
  const dataMatch = text.match(/(?:--data(?:-raw)?|-d|json\s*=|data\s*=)\s*(['"])([\s\S]*?)\1/);
  if (dataMatch) {
    try {
      return JSON.parse(dataMatch[2]);
    } catch {
      /* fall through */
    }
  }
  return null;
}

function findPayloadObject(text) {
  const flags = {};
  for (const match of text.matchAll(/^\s*(stream|verify|use_vision)\s*=\s*(True|False|true|false)\s*$/gm)) {
    flags[match[1]] = /true/i.test(match[2]) ? "true" : "false";
  }
  const anchors = [
    /payload\s*=\s*/,
    /json_body\s*=\s*/,
    /body\s*=\s*\{\s*$/m,
    /data\s*=\s*\{\s*$/m,
    /"messages"\s*:/,
  ];
  for (const anchor of anchors) {
    const match = anchor.exec(text);
    if (!match) continue;
    const block = balancedObject(text, match.index + match[0].length - 1);
    if (!block) continue;
    const parsed = pythonishToJson(block, { flags });
    if (parsed && (parsed.messages || parsed.model)) return parsed;
  }
  // Fall back to the first braces block in the text.
  const block = balancedObject(text, 0);
  if (block) {
    const parsed = pythonishToJson(block, { flags });
    if (parsed && (parsed.messages || parsed.model)) return parsed;
  }
  return null;
}

function normalizeMessages(rawMessages, warnings) {
  if (!Array.isArray(rawMessages) || !rawMessages.length) {
    return [];
  }
  const messages = [];
  rawMessages.forEach((message, index) => {
    if (!message || typeof message !== "object") return;
    const role = ["system", "user", "assistant", "tool"].includes(message.role) ? message.role : "user";
    const content = message.content;
    if (typeof content === "string") {
      messages.push({ role, content });
      return;
    }
    if (!Array.isArray(content)) {
      warnings.push(`Message ${index} has unsupported content and was skipped.`);
      return;
    }
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "text" || part.text) {
        if (typeof part.text === "string") parts.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "image_url") {
        const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
        if (typeof url === "string" && /^(data:image\/[\w.+-]+;base64,|https?:\/\/)/i.test(url)) {
          parts.push({ type: "image_url", image_url: { url } });
        } else {
          warnings.push(
            `Message ${index} references an image this app cannot read (${String(url ?? "no url").slice(0, 40)}). Attach the file in Chat lab instead.`,
          );
        }
      }
    }
    if (parts.length) messages.push({ role, content: parts });
  });
  return messages;
}

function normalizeParams(payload, warnings) {
  const params = {};
  for (const [key, value] of Object.entries(payload)) {
    const target = PARAM_ALIASES[key];
    if (!target) continue;
    if (target === "reasoningEffort") {
      const level = String(value).toLowerCase();
      if (["low", "medium", "high"].includes(level)) params[target] = level;
      else warnings.push(`reasoning_effort "${value}" is not low/medium/high; ignored.`);
      continue;
    }
    if (target === "responseFormat") {
      if (value && typeof value === "object") params[target] = value;
      else if (value === "json" || value === "json_object") params[target] = { type: "json_object" };
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") params[target] = value;
  }
  if (params.maxTokens != null) {
    const value = Number(params.maxTokens);
    if (!Number.isFinite(value) || value <= 0) delete params.maxTokens;
    else params.maxTokens = Math.min(Math.round(value), MAX_TOKENS_LIMIT);
  }
  if (params.temperature != null) {
    const value = Number(params.temperature);
    params.temperature = Number.isFinite(value) ? Math.min(Math.max(value, 0), 2) : undefined;
    if (params.temperature === undefined) delete params.temperature;
  }
  return params;
}

/**
 * @param {string} text python / curl / node / JSON snippet
 * @returns {{
 *   ok: boolean,
 *   payload: {model: string|null, messages: Array, params: Record<string, any>, stream: boolean},
 *   warnings: string[],
 *   invocation: {endpoint: string|null},
 *   curl: string,
 *   error?: string,
 * }}
 */
export function parseSnippet(text) {
  const source = typeof text === "string" ? text : text == null ? "" : JSON.stringify(text);
  const warnings = [];
  if (!source.trim()) {
    return { ok: false, payload: null, warnings, invocation: { endpoint: null }, curl: "", error: "Paste a request first." };
  }

  const endpointMatch = source.match(/https?:\/\/[^\s"'`]+?\/(?:v1\/)?chat\/completions/i);
  const endpoint = endpointMatch ? endpointMatch[0] : null;

  const payload = findJsonPayload(source) ?? findPayloadObject(source);
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      payload: null,
      warnings,
      invocation: { endpoint },
      curl: "",
      error: "No chat-completions payload found. Expected a JSON body, or a snippet with `payload = { \"model\": …, \"messages\": […] }`.",
    };
  }

  const model = typeof payload.model === "string" && payload.model.includes("/") ? payload.model : null;
  if (!model) warnings.push("No model id in the payload; the configured default will be used.");
  const messages = normalizeMessages(payload.messages, warnings);
  if (!messages.length) {
    return {
      ok: false,
      payload: null,
      warnings,
      invocation: { endpoint },
      curl: "",
      error: "The payload has no usable messages.",
    };
  }
  if (/media_data_url|Path\(|read_bytes|image_data_urls/.test(source)) {
    warnings.push(
      "The snippet loads images from local files. Copy those files into Chat lab (Attach image) — file paths cannot be read by the server.",
    );
  }
  const params = normalizeParams(payload, warnings);
  const stream = Boolean(payload.stream);
  const normalized = { model, messages, params, stream };

  return {
    ok: true,
    payload: normalized,
    warnings,
    invocation: { endpoint },
    curl: buildCurl(normalized),
  };
}

export function buildCurl({ model, messages, params }) {
  const body = {
    model: model ?? "<model>",
    messages,
    ...(params.temperature != null ? { temperature: params.temperature } : {}),
    ...(params.topP != null ? { top_p: params.topP } : {}),
    ...(params.maxTokens != null ? { max_tokens: params.maxTokens } : {}),
    ...(params.reasoningEffort ? { reasoning_effort: params.reasoningEffort } : {}),
    stream: false,
  };
  const compact = JSON.stringify(body, (key, value) =>
    typeof value === "string" && value.startsWith("data:") && value.length > 120 ? `${value.slice(0, 60)}…` : value,
  );
  return [
    "curl -s $NIM_BASE/chat/completions \\",
    '  -H "Authorization: Bearer $NVIDIA_API_KEY" \\',
    '  -H "Content-Type: application/json" \\',
    `  -d '${compact}'`,
  ].join("\n");
}

/**
 * Run a parsed snippet through the app's NIM client, so the exact request the
 * operator pasted is what gets sent — including vision parts and extra params.
 */
export async function runSnippet({ nim, snippet, model, signal, stream = false }) {
  const payload = snippet.payload;
  if (!payload) throw Object.assign(new Error("Nothing to run: the snippet has no payload."), { status: 422 });
  const chosen = model || payload.model;
  if (!chosen) {
    throw Object.assign(new Error("The snippet has no model id — pick one, or set a default in Settings."), {
      status: 422,
      hint: "Paste a snippet that includes `\"model\": \"publisher/model\"`, or pass a model with the request.",
    });
  }
  const extra = {};
  for (const key of ["frequencyPenalty", "presencePenalty", "topK", "minP", "repetitionPenalty"]) {
    if (payload.params[key] != null) {
      const wire = {
        frequencyPenalty: "frequency_penalty",
        presencePenalty: "presence_penalty",
        topK: "top_k",
        minP: "min_p",
        repetitionPenalty: "repetition_penalty",
      }[key];
      extra[wire] = payload.params[key];
    }
  }
  if (payload.params.reasoningEffort) extra.reasoning_effort = payload.params.reasoningEffort;

  const request = {
    model: chosen,
    messages: payload.messages,
    temperature: payload.params.temperature,
    topP: payload.params.topP,
    maxTokens: payload.params.maxTokens,
    responseFormat: payload.params.responseFormat,
    seed: payload.params.seed,
    stop: payload.params.stop,
    extra: Object.keys(extra).length ? extra : undefined,
  };

  const response = await nim.chat({ ...request, intent: "replay", signal });
  return {
    model: chosen,
    request: {
      model: chosen,
      messages: payload.messages.map((message) => ({
        role: message.role,
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => (part.type === "text" ? part : { type: "image_url", image_url: { url: "<image>" } })),
      })),
      temperature: payload.params.temperature,
      top_p: payload.params.topP,
      max_tokens: payload.params.maxTokens,
      ...extra,
    },
    simulated: Boolean(response.simulated),
    content: response.content,
    reasoning: response.reasoning ?? "",
    usage: response.usage,
    finishReason: response.finishReason,
    streamed: stream,
  };
}
