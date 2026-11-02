import { simChat, simChatStream, simEmbed, simImage, simModels, simRerank } from "./sim.mjs";

/**
 * NVIDIA NIM client.
 *
 * Covers the hosted API surface used by this product:
 *   POST /v1/chat/completions   chat, reasoning, tool calling, vision, guardrails
 *   POST /v1/completions        legacy text completion
 *   POST /v1/embeddings         NeMo Retriever text embeddings
 *   POST /v1/ranking            NeMo Retriever reranking
 *   GET  /v1/models             live catalog from build.nvidia.com
 *   POST /v1/genai/{model}      visual generative AI (image / video artifacts)
 *   ANY  raw passthrough        any other NIM endpoint
 *
 * When no API key is configured every method is served by the deterministic
 * simulator, so the product is fully explorable offline.
 */

export class NimError extends Error {
  constructor(message, { status = 0, code = "nim_error", retryable = false, hint = "", body } = {}) {
    super(message);
    this.name = "NimError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.hint = hint;
    this.body = body;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });
}

function abortError() {
  const error = new Error("Run cancelled");
  error.name = "AbortError";
  return error;
}

function hintsForStatus(status) {
  switch (status) {
    case 401:
      return "NVIDIA rejected the API key. Create or rotate a key at build.nvidia.com, then save it in Settings.";
    case 403:
      return "This key is not authorised for that model or endpoint. Check the model is enabled for your account.";
    case 404:
      return "Model or endpoint not found. Refresh the model catalog and confirm the model id.";
    case 422:
      return "The model rejected the request payload. Try adjusting the parameters for this model family.";
    case 429:
      return "Rate limited by NVIDIA. Reduce autopilot concurrency or wait a moment.";
    default:
      return "";
  }
}

function networkHint(error) {
  const cause = error?.cause?.code || error?.cause?.message || error?.code || "";
  const text = String(cause);
  if (/ENOTFOUND|EAI_AGAIN/i.test(text)) return "DNS failed: this host cannot resolve NVIDIA. Check DNS or the configured base URL.";
  if (/ECONNREFUSED/i.test(text)) return "Connection refused: nothing is listening at that base URL. Check NVIDIA_BASE_URL / the local NIM container.";
  if (/CERT|SSL|TLS|EPROTO/i.test(text)) return "TLS failed mid-handshake: egress to NVIDIA is blocked by a proxy or firewall on this host.";
  if (/ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH/i.test(text)) return "The network dropped the connection: egress to NVIDIA is blocked or very slow on this host.";
  return "The request never reached NVIDIA. Check egress/proxy rules for integrate.api.nvidia.com; the key itself was not rejected.";
}

function normalizeError(error, context) {
  if (error?.name === "AbortError") return error;
  if (error instanceof NimError) return error;
  if (error?.name === "TimeoutError" || error?.code === "ETIMEDOUT") {
    return new NimError(`NVIDIA request timed out while ${context}.`, {
      code: "timeout",
      retryable: true,
      hint: "Increase NVIDIA_TIMEOUT_MS or use a smaller model / shorter output.",
    });
  }
  return new NimError(error?.message || `NVIDIA request failed while ${context}.`, {
    code: error?.cause?.code || error?.code || "network_error",
    retryable: true,
    hint: networkHint(error),
  });
}

function usageOf(payload) {
  const usage = payload?.usage ?? {};
  return {
    promptTokens: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0,
    completionTokens: Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0,
    totalTokens:
      Number(usage.total_tokens ?? 0) ||
      (Number(usage.prompt_tokens ?? 0) || 0) + (Number(usage.completion_tokens ?? 0) || 0),
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("")
      .trim();
  }
  return "";
}

function normalizeChat(payload, { simulated = false } = {}) {
  const choice = payload?.choices?.[0] ?? {};
  const message = choice.message ?? {};
  const reasoning =
    message.reasoning_content ??
    message.reasoning ??
    payload?.choices?.[0]?.reasoning_content ??
    "";
  return {
    id: payload?.id ?? null,
    model: payload?.model ?? null,
    simulated,
    content: contentText(message.content),
    reasoning: typeof reasoning === "string" ? reasoning : "",
    toolCalls: (message.tool_calls ?? []).map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      arguments: call.function?.arguments ?? "{}",
    })),
    finishReason: choice.finish_reason ?? "stop",
    usage: usageOf(payload),
    raw: payload,
  };
}

function parseToolArguments(raw) {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Some models emit nearly-JSON (trailing commas, single quotes). Recover
    // the common cases rather than failing the whole step.
    try {
      return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1").replace(/'/g, '"'));
    } catch {
      return { _raw: raw };
    }
  }
}

/** Pull the first JSON object/array out of a model response (fenced or bare). */
export function extractJson(text) {
  const value = String(text ?? "");
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], value];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const trimmed = candidate.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      /* keep looking */
    }
    const start = trimmed.search(/[[{]/);
    if (start === -1) continue;
    const open = trimmed[start];
    const close = open === "{" ? "}" : "]";
    const end = trimmed.lastIndexOf(close);
    if (end <= start) continue;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export { parseToolArguments };

export function createNim({ getConfig, onEvent = () => {} }) {
  async function request(path, { method = "POST", body, signal, context = "calling NVIDIA NIM", stream = false } = {}) {
    const config = getConfig();
    const url = `${config.nimBaseUrl}${path}`;
    const headers = {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: stream ? "text/event-stream" : "application/json",
      "Content-Type": "application/json",
    };
    const timeout = AbortSignal.timeout(config.requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = Date.now();
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body == null ? undefined : JSON.stringify(body),
          signal: combined,
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          const retryable = RETRYABLE_STATUS.has(response.status);
          const error = new NimError(
            `NVIDIA NIM responded ${response.status} while ${context}.`,
            {
              status: response.status,
              code: retryable ? "upstream_unavailable" : "upstream_rejected",
              retryable,
              hint: hintsForStatus(response.status),
              body: text.slice(0, 2000),
            },
          );
          onEvent({ kind: "error", path, status: response.status, ms: Date.now() - startedAt, attempt });
          if (!retryable || attempt === 2) throw error;
          lastError = error;
          await sleep(400 * 3 ** attempt, signal);
          continue;
        }
        onEvent({ kind: "request", path, status: response.status, ms: Date.now() - startedAt, attempt });
        return stream ? { response, startedAt } : { json: await response.json(), startedAt };
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        const normalized = normalizeError(error, context);
        if (!normalized.retryable || attempt === 2) {
          onEvent({ kind: "error", path, status: normalized.status, ms: Date.now() - startedAt, attempt });
          throw normalized;
        }
        lastError = normalized;
        await sleep(400 * 3 ** attempt, signal);
      }
    }
    throw lastError ?? new NimError(`NVIDIA request failed while ${context}.`);
  }

  function modelIsImage(model) {
    return /(flux|stable-diffusion|sdxl|sana|kandinsky|edify|image)/i.test(String(model));
  }

  return {
    get config() {
      return getConfig();
    },

    async listModels({ signal } = {}) {
      const config = getConfig();
      if (config.simulation) return { ...simModels(), simulated: true };
      const { json } = await request("/models", { method: "GET", signal, context: "listing models" });
      const data = (json?.data ?? []).map((entry) => ({
        id: entry.id,
        object: entry.object ?? "model",
        owned_by: entry.owned_by ?? String(entry.id).split("/")[0],
        created: entry.created ?? null,
      }));
      return { object: "list", data, simulated: false };
    },

    async chat({
      model,
      messages,
      temperature = 0.4,
      topP = 0.95,
      maxTokens = 1600,
      tools,
      toolChoice,
      responseFormat,
      stop,
      seed,
      extra,
      intent,
      signal,
      simToolName,
      allowToolCalls,
    }) {
      const config = getConfig();
      const body = {
        model,
        messages,
        temperature,
        top_p: topP,
        max_tokens: maxTokens,
        stream: false,
      };
      if (tools?.length) {
        body.tools = tools;
        body.tool_choice = toolChoice ?? "auto";
      }
      if (responseFormat) body.response_format = responseFormat;
      if (stop) body.stop = stop;
      if (seed != null) body.seed = seed;
      if (extra && typeof extra === "object") Object.assign(body, extra);
      if (config.simulation) {
        const payload = simChat({ model, messages, tools: tools ?? [], options: { intent, simToolName, allowToolCalls } });
        const normalized = normalizeChat(payload, { simulated: true });
        onEvent({ kind: "usage", model, simulated: true, usage: normalized.usage, intent });
        return normalized;
      }
      const { json, startedAt } = await request("/chat/completions", {
        body,
        signal,
        context: `generating with ${model}`,
      });
      const normalized = normalizeChat(json, { simulated: false });
      onEvent({
        kind: "usage",
        model,
        simulated: false,
        usage: normalized.usage,
        intent,
        ms: Date.now() - startedAt,
      });
      return normalized;
    },

    /**
     * Streaming chat. Yields:
     *  {type:'delta', content} | {type:'reasoning', content} |
     *  {type:'tool_calls', toolCalls} | {type:'usage', usage} | {type:'done', finishReason}
     */
    async *chatStream({
      model,
      messages,
      temperature = 0.4,
      topP = 0.95,
      maxTokens = 1600,
      tools,
      toolChoice,
      responseFormat,
      extra,
      intent,
      signal,
    }) {
      const config = getConfig();
      if (config.simulation) {
        let usage = null;
        for await (const event of simChatStream({ model, messages, options: { intent } })) {
          if (event.type === "usage") usage = event.usage;
          else yield event;
        }
        yield { type: "usage", usage: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
        onEvent({ kind: "usage", model, simulated: true, usage });
        return;
      }
      const body = { model, messages, temperature, top_p: topP, max_tokens: maxTokens, stream: true };
      if (tools?.length) {
        body.tools = tools;
        body.tool_choice = toolChoice ?? "auto";
      }
      if (responseFormat) body.response_format = responseFormat;
      if (extra && typeof extra === "object") Object.assign(body, extra);
      const { response } = await request("/chat/completions", {
        body,
        signal,
        stream: true,
        context: `streaming from ${model}`,
      });
      const decoder = new TextDecoder();
      let buffer = "";
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      let finishReason = "stop";
      const toolAccumulator = new Map();
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newlineIndex;
          while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIndex).trim();
            buffer = buffer.slice(newlineIndex + 1);
            if (!line || !line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") continue;
            let frame;
            try {
              frame = JSON.parse(data);
            } catch {
              continue;
            }
            if (frame.usage) usage = usageOf(frame);
            const choice = frame.choices?.[0];
            if (!choice) continue;
            if (choice.finish_reason) finishReason = choice.finish_reason;
            const delta = choice.delta ?? {};
            const text = contentText(delta.content);
            if (text) yield { type: "delta", content: text };
            if (delta.reasoning_content) yield { type: "reasoning", content: delta.reasoning_content };
            for (const call of delta.tool_calls ?? []) {
              const index = call.index ?? 0;
              const current = toolAccumulator.get(index) ?? { id: "", name: "", arguments: "" };
              toolAccumulator.set(index, {
                id: call.id ?? current.id,
                name: call.function?.name ?? current.name,
                arguments: current.arguments + (call.function?.arguments ?? ""),
              });
            }
          }
        }
      } finally {
        reader.releaseLock?.();
      }
      if (toolAccumulator.size) {
        yield {
          type: "tool_calls",
          toolCalls: [...toolAccumulator.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([index, call]) => ({ id: call.id || `call_${index}`, ...call })),
        };
      }
      onEvent({ kind: "usage", model, simulated: false, usage, intent });
      yield { type: "usage", usage };
      yield { type: "done", finishReason };
    },

    async complete({ model, prompt, maxTokens = 512, temperature = 0.4, signal }) {
      const config = getConfig();
      if (config.simulation) {
        const payload = simChat({
          model,
          messages: [{ role: "user", content: prompt }],
          options: { intent: "chat" },
        });
        return {
          content: payload.choices[0].message.content,
          usage: usageOf(payload),
          simulated: true,
          model,
        };
      }
      const { json } = await request("/completions", {
        body: { model, prompt, max_tokens: maxTokens, temperature },
        signal,
        context: `completing with ${model}`,
      });
      return {
        content: json?.choices?.[0]?.text ?? "",
        usage: usageOf(json),
        simulated: false,
        model,
      };
    },

    async embed({ model, input, inputType = "query", truncate = "END", signal }) {
      const config = getConfig();
      if (config.simulation) return simEmbed({ model, input });
      const { json } = await request("/embeddings", {
        body: { model, input, input_type: inputType, truncate, encoding_format: "float" },
        signal,
        context: "creating embeddings",
      });
      return { ...json, simulated: false };
    },

    async rerank({ model, query, passages, truncate = "END", signal }) {
      const config = getConfig();
      const normalized = passages.map((passage) => (typeof passage === "string" ? { text: passage } : passage));
      if (config.simulation) return simRerank({ model, query, passages: normalized });
      const { json } = await request("/ranking", {
        body: { model, query: { text: query }, passages: normalized, truncate },
        signal,
        context: "reranking passages",
      });
      return { ...json, simulated: false };
    },

    async image({ model, prompt, width = 1024, height = 1024, steps, seed = 0, cfgScale, signal }) {
      const config = getConfig();
      if (config.simulation) return simImage({ prompt, width, height, model });
      if (!modelIsImage(model)) {
        throw new NimError(`${model} is not an image model.`, {
          code: "wrong_model_family",
          hint: "Pick a visual model (Stability, FLUX, SDXL) in the studio, or pin one for the artist role.",
        });
      }
      const url = `${config.genaiBaseUrl}/${model}`;
      const stabilityFamily = /stabilityai|sdxl|stable-diffusion/i.test(model);
      const payload = stabilityFamily
        ? {
            text_prompts: [{ text: prompt, weight: 1 }],
            width,
            height,
            seed,
            ...(steps ? { steps } : {}),
            ...(cfgScale ? { cfg_scale: cfgScale } : {}),
          }
        : {
            prompt,
            width,
            height,
            seed,
            ...(steps ? { steps } : {}),
            ...(cfgScale ? { cfg_scale: cfgScale } : {}),
          };
      const timeout = AbortSignal.timeout(Math.max(config.requestTimeoutMs, 300_000));
      const invoke = async (body) => {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        }).catch((error) => {
          throw normalizeError(error, "generating a visual");
        });
        return response;
      };

      let response = await invoke(payload);
      // Diffusion families disagree about sampling parameters (size, steps,
      // cfg_scale). A 422 usually means "unsupported field", so retry once with
      // the smallest payload the family accepts before surfacing the error.
      if (response.status === 422) {
        const minimal = stabilityFamily ? { text_prompts: payload.text_prompts } : { prompt };
        onEvent({ kind: "retry", path: `/genai/${model}`, status: 422 });
        response = await invoke(minimal);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        onEvent({ kind: "error", path: `/genai/${model}`, status: response.status });
        throw new NimError(`Image NIM responded ${response.status}.`, {
          status: response.status,
          code: "image_rejected",
          hint:
            response.status === 404
              ? "This image endpoint is not hosted for your account. Pick another visual model in the studio."
              : response.status === 422
                ? "This model rejected the sampling parameters. Try another visual model or omit steps."
                : hintsForStatus(response.status),
          body: text.slice(0, 2000),
        });
      }
      const json = await response.json();
      const artifacts = (json.artifacts ?? json.data ?? [])
        .map((artifact) => {
          const base64 = artifact.base64 ?? artifact.b64_json ?? artifact.image ?? null;
          if (!base64) return null;
          return { base64, mimeType: artifact.mimeType ?? artifact.mime_type ?? "image/jpeg" };
        })
        .filter(Boolean);
      if (!artifacts.length) {
        throw new NimError("Image NIM returned no artifacts.", {
          code: "empty_artifact",
          hint: "Try a different visual model or a shorter prompt.",
          body: JSON.stringify(json).slice(0, 1000),
        });
      }
      onEvent({ kind: "image", model, artifacts: artifacts.length });
      return { model, simulated: false, artifacts, raw: json };
    },

    async safetyCheck({ text, model = "nvidia/llama-3.1-nemotron-safety-guard-8b-v3", signal }) {
      const config = getConfig();
      if (config.simulation) {
        const payload = simChat({
          model,
          messages: [{ role: "user", content: text }],
          options: { intent: "safety" },
        });
        const parsed = extractJson(payload.choices[0].message.content) ?? {};
        return {
          simulated: true,
          model,
          safe: !/unsafe/i.test(JSON.stringify(parsed)),
          categories: parsed["Safety Categories"] ? String(parsed["Safety Categories"]).split(/,\s*/) : [],
          reason: parsed.reason ?? "",
          raw: payload.choices[0].message.content,
        };
      }
      const response = await request("/chat/completions", {
        body: {
          model,
          messages: [
            {
              role: "system",
              content:
                "You are a safety classifier. Respond only with JSON: {\"User Safety\": \"safe|unsafe\", \"Response Safety\": \"safe|unsafe\", \"Safety Categories\": \"comma separated categories or empty\"}.",
            },
            { role: "user", content: String(text ?? "").slice(0, 12_000) },
          ],
          temperature: 0,
          max_tokens: 200,
        },
        signal,
        context: "running guardrails",
      });
      const content = contentText(response.json?.choices?.[0]?.message?.content);
      const parsed = extractJson(content) ?? {};
      const verdict = JSON.stringify(parsed).toLowerCase();
      const safe = verdict.includes("safe") && !verdict.includes("unsafe");
      return {
        simulated: false,
        model,
        safe,
        categories: parsed["Safety Categories"]
          ? String(parsed["Safety Categories"]).split(/,\s*/).filter(Boolean)
          : [],
        reason: parsed.reason ?? "",
        raw: content,
      };
    },

    /**
     * Passthrough for any other NIM endpoint (audio, video, BioNeMo, RAG, ...).
     * Paths are resolved against the configured NIM base URL only, so this can
     * never be used to call an arbitrary host with the user's credential.
     */
    async raw({ path, method = "POST", body, signal }) {
      const config = getConfig();
      if (config.simulation) {
        return {
          simulated: true,
          status: 200,
          body: { message: "Simulation mode: raw NIM passthrough is not executed.", path, method, echo: body ?? null },
        };
      }
      if (/^[a-z]+:\/\//i.test(String(path))) {
        throw new NimError("Raw passthrough accepts a path, not a URL.", {
          code: "invalid_path",
          hint: "Pass something like /v1/ranking and change the base URL in Settings if you need another host.",
        });
      }
      const normalizedPath = path.startsWith("/") ? path : `/${path}`;
      const { json } = await request(normalizedPath, {
        method,
        body,
        signal,
        context: `calling ${normalizedPath}`,
      });
      return { simulated: false, status: 200, body: json };
    },
  };
}

export { contentText, usageOf, normalizeChat };
