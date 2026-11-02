/**
 * NVIDIA NIM client — one adapter per endpoint family.
 *
 *   POST /chat/completions        chat · reasoning · tools · vision · parse · safety · translate
 *   POST /completions             legacy text completion
 *   POST /embeddings              NeMo Retriever embeddings
 *   POST /ranking                 NeMo Retriever reranking
 *   POST /genai/{model}           visual generative AI (image, video, pose)
 *   POST /biology/{task}          BioNeMo (protein, molecule, genomics)
 *   GET  /models                  catalog + credential verification
 *   ANY  /{path}                  raw passthrough for anything not covered yet
 *
 * Every method returns a normalised envelope:
 *   { text, reasoning, toolCalls, usage, artifacts, latencyMs, model, simulated, raw }
 *
 * With no credential the whole surface is served by sim.mjs, so callers never
 * branch on "is this a real key".
 */

import { MODEL_CATALOG, estimateCost, findModel, selectModel } from "./catalog.mjs";
import {
  simBiology,
  simChat,
  simComplete,
  simEmbed,
  simImage,
  simParse,
  simRerank,
  simSafety,
  simStream,
  simTranslate,
} from "./sim.mjs";

export class NimError extends Error {
  constructor(message, { status = 0, code = "nim_error", retryable = false, hint = "", body, latencyMs } = {}) {
    super(message);
    this.name = "NimError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.hint = hint;
    this.body = body;
    this.latencyMs = latencyMs;
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const HINTS = {
  401: "NVIDIA rejected the credential. Check the key in Settings → API keys.",
  402: "This account is out of credits on build.nvidia.com.",
  403: "The key is valid but not entitled to this model. Try another model or request access.",
  404: "The model or endpoint does not exist at this base URL. Confirm NIM_BASE_URL.",
  422: "The request body was accepted by HTTP but rejected by the model — check parameter names.",
  429: "Rate limited by NVIDIA. The client retries with backoff; lower concurrency if it persists.",
  503: "The NIM is scaled to zero or overloaded. Retry shortly.",
};

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(abortError());
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError() {
  const error = new Error("Run cancelled");
  error.name = "AbortError";
  return error;
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? (part?.type === "image_url" ? "[image]" : "")))
      .join("\n");
  }
  return content == null ? "" : String(content);
}

/** Chat content helper: `imageMessage("describe", base64OrUrl)` */
export function imageContent(text, image, { mimeType = "image/png" } = {}) {
  const url = image.startsWith("data:") || image.startsWith("http") ? image : `data:${mimeType};base64,${image}`;
  return [
    { type: "text", text },
    { type: "image_url", image_url: { url } },
  ];
}

export function createNimClient({ getConfig, getProviders = () => [], onUsage = () => {}, logger = console } = {}) {
  function config() {
    const cfg = typeof getConfig === "function" ? getConfig() : getConfig ?? {};
    return {
      baseUrl: (cfg.baseUrl || "https://integrate.api.nvidia.com/v1").replace(/\/+$/, ""),
      apiKey: cfg.apiKey || "",
      simulation: Boolean(cfg.simulation || !cfg.apiKey),
      timeoutMs: cfg.timeoutMs ?? 180_000,
      maxRetries: cfg.maxRetries ?? 3,
    };
  }

  /**
   * A model from a pasted snippet may live at another OpenAI-compatible base
   * URL with its own key. NVIDIA stays the default; connected providers win
   * only for the model ids recorded against them.
   */
  function targetFor(model) {
    const cfg = config();
    if (!model) return cfg;
    let providers = [];
    try {
      providers = typeof getProviders === "function" ? getProviders() : getProviders ?? [];
    } catch {
      providers = [];
    }
    const owner = providers.find((provider) => (provider.models ?? []).includes(model) && provider.apiKey);
    if (!owner) return cfg;
    return { ...cfg, baseUrl: String(owner.baseUrl).replace(/\/+$/, ""), apiKey: owner.apiKey, providerId: owner.id };
  }

  function record({ model, usage, latencyMs, simulated, endpoint, artifacts = 0 }) {
    const cost = estimateCost({ model, usage: { ...usage, images: artifacts } });
    const meta = findModel(model);
    const event = {
      model,
      endpoint,
      latencyMs,
      simulated,
      usage: { ...usage, images: artifacts },
      cost,
     family: meta?.family ?? "unknown",
      at: new Date().toISOString(),
    };
    try {
      onUsage(event);
    } catch (error) {
      logger.warn?.("[nim] usage listener failed", error?.message);
    }
    return event;
  }

  async function request(path, { method = "POST", body, model, signal, query, retries } = {}) {
    const cfg = targetFor(model ?? body?.model);
    if (cfg.simulation) {
      const error = new NimError("Simulation mode is on — this call has no live NIM implementation.", {
        code: "simulation_only",
        hint: "Add a key in Settings to call this endpoint for real.",
      });
      throw error;
    }
    const url = new URL(joinUrl(cfg.baseUrl, path));
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const attempts = retries ?? cfg.maxRetries;
    let lastError;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), cfg.timeoutMs);
      const onAbort = () => controller.abort(abortError());
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            Accept: path.includes("stream") ? "text/event-stream" : "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
            "User-Agent": "paperclip-nim/1.0",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        const latencyMs = Date.now() - started;
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          let parsed;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text.slice(0, 600) };
          }
          const error = new NimError(
            parsed?.error?.message || parsed?.message || parsed?.detail || `${response.status} ${response.statusText}`,
            {
              status: response.status,
              code: parsed?.error?.code ?? parsed?.error ?? `http_${response.status}`,
              retryable: RETRYABLE.has(response.status),
              hint: HINTS[response.status] ?? "",
              body: parsed,
              latencyMs,
            },
          );
          if (error.retryable && attempt < attempts) {
            lastError = error;
            await sleep(Math.min(8000, 400 * 2 ** attempt) + Math.random() * 250, signal);
            continue;
          }
          throw error;
        }
        return { data: await response.json(), latencyMs, url: url.toString() };
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw abortError();
        if (error instanceof NimError) throw error;
        const wrapped = new NimError(
          error?.message === "timeout" ? `NIM call timed out after ${cfg.timeoutMs}ms` : `Network error reaching ${cfg.baseUrl}`,
          {
            code: error?.message === "timeout" ? "timeout" : "network_error",
            retryable: true,
            hint: "Check that this host can reach the NIM endpoint (proxy/VPC/firewall).",
          },
        );
        if (attempt < attempts) {
          lastError = wrapped;
          await sleep(Math.min(8000, 400 * 2 ** attempt), signal);
          continue;
        }
        throw wrapped;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
      }
    }
    throw lastError ?? new NimError("NIM request failed");
  }

  /* ----------------------------------------------------------- text calls */

  function normalizeChat(data, { model, latencyMs, simulated }) {
    const choice = data?.choices?.[0] ?? {};
    const message = choice.message ?? {};
    const toolCalls = (message.tool_calls ?? []).map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.function?.name ?? call.name,
        arguments: call.function?.arguments ?? call.arguments ?? "{}",
      },
    }));
    return {
      text: normalizeContent(message.content ?? choice.text ?? ""),
      reasoning: message.reasoning_content ?? message.reasoning ?? choice.reasoning_content ?? "",
      toolCalls,
      finishReason: choice.finish_reason ?? "stop",
      model: data?.model ?? model,
      usage: {
        prompt_tokens: data?.usage?.prompt_tokens ?? 0,
        completion_tokens: data?.usage?.completion_tokens ?? 0,
        total_tokens: data?.usage?.total_tokens ?? 0,
      },
      latencyMs,
      simulated,
      raw: data,
    };
  }

  /**
   * Chat completion. Pass `onDelta` to stream text as it arrives; the resolved
   * value is always the complete message.
   */
  async function chat({
    model,
    messages,
    temperature = 0.4,
    maxTokens = 1600,
    tools,
    toolChoice,
    responseFormat,
    topP,
    stop,
    seed,
    stream = Boolean(arguments[0]?.onDelta),
    onDelta,
    onReasoning,
    signal,
    simulateToolCall = true,
    endpointLabel = "chat",
  } = {}) {
    const cfg = config();
    const chosen = model ?? selectModel("chat");
    const body = {
      model: chosen,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: Boolean(stream && !cfg.simulation),
    };
    if (topP != null) body.top_p = topP;
    if (stop) body.stop = stop;
    if (seed != null) body.seed = seed;
    if (tools?.length) {
      body.tools = tools;
      if (toolChoice) body.tool_choice = toolChoice;
    }
    if (responseFormat) body.response_format = responseFormat;

    if (cfg.simulation) {
      const started = Date.now();
      const result = simChat({
        model: chosen,
        messages,
        responseFormat,
        temperature,
        seed,
        tools,
        // Only ask for a tool on the first hop: once a tool result is in the
        // transcript the simulator answers in prose, like a real model would.
        simulateToolCall: simulateToolCall && !messages.some((message) => message.role === "tool"),
        signal,
      });
      if (onDelta && result.text) {
        const chunks = result.text.match(/\S+\s*/g) ?? [];
        for (const chunk of chunks) {
          if (signal?.aborted) throw abortError();
          onDelta(chunk);
        }
      }
      result.latencyMs = Date.now() - started + 40;
      record({ model: chosen, usage: result.usage, latencyMs: result.latencyMs, simulated: true, endpoint: endpointLabel });
      return result;
    }

    if (!body.stream) {
      const { data, latencyMs } = await request("/chat/completions", { body, model: chosen, signal });
      const normalized = normalizeChat(data, { model: chosen, latencyMs, simulated: false });
      record({ model: normalized.model, usage: normalized.usage, latencyMs, simulated: false, endpoint: endpointLabel });
      if (onDelta && normalized.text) onDelta(normalized.text);
      return normalized;
    }

    // ---- streaming path (SSE) ----
    const streamCfg = targetFor(chosen);
    const url = joinUrl(streamCfg.baseUrl, "/chat/completions");
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("timeout")), cfg.timeoutMs);
    const onAbort = () => controller.abort(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${streamCfg.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "User-Agent": "paperclip-nim/1.0",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new NimError(`Stream failed: ${response.status}`, {
          status: response.status,
          code: `http_${response.status}`,
          hint: HINTS[response.status] ?? "",
          body: text.slice(0, 400),
        });
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let text = "";
      let reasoning = "";
      const toolCalls = [];
      let finishReason = "stop";
      let usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      let resolvedModel = chosen;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          resolvedModel = event.model ?? resolvedModel;
          if (event.usage) usage = event.usage;
          const choice = event.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (delta.reasoning_content) {
            reasoning += delta.reasoning_content;
            onReasoning?.(delta.reasoning_content);
          }
          if (delta.content) {
            text += delta.content;
            onDelta?.(delta.content);
          }
          for (const call of delta.tool_calls ?? []) {
            const index = call.index ?? toolCalls.length;
            toolCalls[index] ??= { id: call.id ?? `call_${index}`, type: "function", function: { name: "", arguments: "" } };
            if (call.id) toolCalls[index].id = call.id;
            if (call.function?.name) toolCalls[index].function.name = call.function.name;
            if (call.function?.arguments) toolCalls[index].function.arguments += call.function.arguments;
          }
          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
      }
      const latencyMs = Date.now() - started;
      const result = {
        text,
        reasoning,
        toolCalls: toolCalls.filter(Boolean),
        finishReason,
        model: resolvedModel,
        usage,
        latencyMs,
        simulated: false,
      };
      record({ model: resolvedModel, usage, latencyMs, simulated: false, endpoint: `${endpointLabel}:stream` });
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    }
  }

  async function complete({ model, prompt, temperature = 0.5, maxTokens = 512, signal } = {}) {
    const cfg = config();
    const chosen = model ?? selectModel("chat");
    if (cfg.simulation) {
      const result = simComplete({ model: chosen, prompt });
      record({ model: chosen, usage: result.usage, latencyMs: result.latencyMs, simulated: true, endpoint: "completions" });
      return result;
    }
    const { data, latencyMs } = await request("/completions", {
      body: { model: chosen, prompt, temperature, max_tokens: maxTokens, stream: false },
      signal,
    });
    const text = data?.choices?.[0]?.text ?? "";
    const usage = {
      prompt_tokens: data?.usage?.prompt_tokens ?? 0,
      completion_tokens: data?.usage?.completion_tokens ?? 0,
      total_tokens: data?.usage?.total_tokens ?? 0,
    };
    record({ model: data?.model ?? chosen, usage, latencyMs, simulated: false, endpoint: "completions" });
    return { text, usage, model: data?.model ?? chosen, latencyMs, simulated: false, raw: data };
  }

  /* ------------------------------------------------------------- retrieval */

  async function embed({ model, input, inputType = "query", truncate = "END", signal } = {}) {
    const cfg = config();
    const chosen = model ?? selectModel("embedding");
    const inputs = Array.isArray(input) ? input : [input];
    if (cfg.simulation) {
      const result = simEmbed({ model: chosen, inputs });
      record({ model: chosen, usage: result.usage, latencyMs: result.latencyMs, simulated: true, endpoint: "embeddings" });
      return result;
    }
    const { data, latencyMs } = await request("/embeddings", {
      body: {
        model: chosen,
        input: inputs,
        input_type: inputType,
        encoding_format: "float",
        truncate,
      },
      signal,
    });
    const vectors = (data?.data ?? []).map((row) => row.embedding ?? []);
    const usage = { prompt_tokens: data?.usage?.prompt_tokens ?? data?.usage?.total_tokens ?? 0 };
    record({ model: data?.model ?? chosen, usage, latencyMs, simulated: false, endpoint: "embeddings" });
    return { vectors, usage, model: data?.model ?? chosen, latencyMs, simulated: false, raw: data };
  }

  async function rerank({ model, query, passages, topN, signal } = {}) {
    const cfg = config();
    const chosen = model ?? selectModel("rerank");
    const list = Array.isArray(passages) ? passages : [passages];
    if (cfg.simulation) {
      const result = simRerank({ model: chosen, query, passages: list, topN });
      record({ model: chosen, usage: result.usage, latencyMs: result.latencyMs, simulated: true, endpoint: "ranking" });
      return result;
    }
    const { data, latencyMs } = await request("/ranking", {
      body: { model: chosen, query: { text: query }, passages: list.map((text) => ({ text })) },
      signal,
    });
    const rankings = (data?.rankings ?? data?.results ?? data?.data ?? []).map((row, index) => ({
      index: row.index ?? index,
      score: row.logit ?? row.score ?? row.relevance_score ?? 0,
      passage: list[row.index ?? index] ?? "",
      rank: index + 1,
    }));
    const usage = { prompt_tokens: data?.usage?.total_tokens ?? data?.usage?.prompt_tokens ?? 0 };
    record({ model: data?.model ?? chosen, usage, latencyMs, simulated: false, endpoint: "ranking" });
    return { rankings, usage, model: data?.model ?? chosen, latencyMs, simulated: false, raw: data };
  }

  /* --------------------------------------------------------- generative AI */

  async function generateImage({
    model,
    prompt,
    negativePrompt,
    width = 1024,
    height = 1024,
    steps = 30,
    cfgScale = 7,
    seed,
    image,
    mode = "base",
    signal,
  } = {}) {
    const cfg = config();
    const chosen = model ?? selectModel("image");
    if (cfg.simulation) {
      const result = simImage({ model: chosen, prompt, width, height, seed });
      record({ model: chosen, usage: result.usage, latencyMs: result.latencyMs, simulated: true, endpoint: "genai", artifacts: 1 });
      return result;
    }
    const body = {
      prompt,
      mode,
      width,
      height,
      steps,
      cfg_scale: cfgScale,
      seed: seed ?? 0,
      samples: 1,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      ...(image ? { image } : {}),
    };
    const { data, latencyMs } = await request(`/genai/${chosen}`, { body, signal });
    const artifacts = (data?.artifacts ?? []).map((artifact) => ({
      base64: artifact.base64 ?? artifact.b64_json ?? "",
      mimeType: artifact.mime_type ?? artifact.mimeType ?? "image/png",
      width,
      height,
      seed: artifact.seed ?? seed,
    }));
    record({ model: chosen, usage: { images: artifacts.length }, latencyMs, simulated: false, endpoint: "genai", artifacts: artifacts.length });
    return { artifacts, model: chosen, latencyMs, simulated: false, usage: { images: artifacts.length }, raw: data };
  }

  async function generateVideo({ model, prompt, image, duration = 5, fps = 24, seed, signal } = {}) {
    const cfg = config();
    const chosen = model ?? findModel("nvidia/cosmos-predict2-14b-text2world")?.id ?? selectModel("image");
    if (cfg.simulation) {
      return {
        simulated: true,
        model: chosen,
        artifacts: [],
        note: "Video generation needs a live key — the simulator returns no video payload.",
        latencyMs: 1500,
      };
    }
    const { data, latencyMs } = await request(`/genai/${chosen}`, {
      body: { prompt, ...(image ? { image } : {}), duration, fps, seed: seed ?? 0 },
      signal,
    });
    return { artifacts: data?.artifacts ?? [], model: chosen, latencyMs, simulated: false, raw: data };
  }

  /* --------------------------------------------------- document + language */

  async function parse({ model, image, prompt = "Extract all text, tables and layout from this page.", signal } = {}) {
    const cfg = config();
    const chosen = model ?? selectModel("parse");
    if (cfg.simulation) {
      const result = simParse({ model: chosen, prompt });
      record({ model: chosen, usage: result.usage, latencyMs: result.latencyMs, simulated: true, endpoint: "parse" });
      return result;
    }
    const result = await chat({
      model: chosen,
      messages: [{ role: "user", content: imageContent(prompt, image) }],
      temperature: 0.1,
      maxTokens: 3000,
      endpointLabel: "parse",
      signal,
      simulateToolCall: false,
    });
    return { ...result, text: result.text };
  }

  async function translate({ model, text, target = "es", source = "en", signal } = {}) {
    const cfg = config();
    const chosen = model ?? selectModel("translate");
    if (cfg.simulation) {
      const result = simTranslate({ model: chosen, text, target });
      record({ model: chosen, usage: result.usage, latencyMs: result.latencyMs, simulated: true, endpoint: "translate" });
      return result;
    }
    return chat({
      model: chosen,
      messages: [
        {
          role: "system",
          content: `You are a professional translator. Translate the user's text from ${source} to ${target}. Preserve markdown, numbers and names. Return only the translation.`,
        },
        { role: "user", content: text },
      ],
      temperature: 0.1,
      maxTokens: 2000,
      endpointLabel: "translate",
      signal,
      simulateToolCall: false,
    });
  }

  async function safety({ model, text, threshold = 0.5, signal } = {}) {
    const cfg = config();
    const chosen = model ?? selectModel("safety");
    if (cfg.simulation) {
      const result = simSafety({ model: chosen, text });
      record({ model: chosen, usage: result.usage, latencyMs: result.latencyMs, simulated: true, endpoint: "safety" });
      return result;
    }
    const response = await chat({
      model: chosen,
      messages: [
        {
          role: "system",
          content:
            "You are a safety classifier. Reply with JSON: {\"verdict\":\"safe\"|\"unsafe\",\"categories\":[],\"score\":0..1,\"rationale\":\"\"}.",
        },
        { role: "user", content: String(text).slice(0, 8000) },
      ],
      temperature: 0,
      maxTokens: 300,
      responseFormat: { type: "json_object" },
      endpointLabel: "safety",
      signal,
      simulateToolCall: false,
    });
    let parsed;
    try {
      parsed = JSON.parse(response.text.replace(/^```(?:json)?|```$/g, "").trim());
    } catch {
      parsed = { verdict: /unsafe/i.test(response.text) ? "unsafe" : "safe", categories: [], score: 0.5, rationale: response.text.slice(0, 300) };
    }
    return {
      ...parsed,
      unsafe: parsed.verdict === "unsafe" || Number(parsed.score) >= threshold,
      model: response.model,
      latencyMs: response.latencyMs,
      simulated: false,
      usage: response.usage,
    };
  }

  /* ---------------------------------------------------------- biomolecular */

  async function biology({ model, task = "protein-structure", payload = {}, signal } = {}) {
    const cfg = config();
    const chosen = model ?? "nvidia/bionemo-boltz2";
    if (cfg.simulation) {
      const result = simBiology({ model: chosen, task });
      record({ model: chosen, usage: { prompt_tokens: 0 }, latencyMs: result.latencyMs, simulated: true, endpoint: `biology/${task}` });
      return result;
    }
    const { data, latencyMs } = await request(`/biology/${task}`, { body: { ...payload, model: chosen }, signal });
    return { result: data, model: chosen, latencyMs, simulated: false };
  }

  /* ------------------------------------------------------------------- meta */

  async function listModels({ signal } = {}) {
    const cfg = config();
    if (cfg.simulation) {
      const error = new NimError("No credential to verify against /v1/models.", {
        code: "no_credential",
        hint: "Paste a key from build.nvidia.com in Settings.",
      });
      throw error;
    }
    const { data, latencyMs } = await request("/models", { method: "GET", signal, retries: 1 });
    const models = (data?.data ?? data?.models ?? []).map((model) => ({
      id: model.id,
      ownedBy: model.owned_by ?? model.publisher ?? "",
      created: model.created ?? null,
      raw: model,
    }));
    return { models, latencyMs, raw: data };
  }

  async function probeModel({ model, signal } = {}) {
    const started = Date.now();
    try {
      const result = await chat({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
        maxTokens: 8,
        temperature: 0,
        signal,
        simulateToolCall: false,
        endpointLabel: "probe",
      });
      return { model, ok: true, latencyMs: Date.now() - started, sample: result.text.slice(0, 40), simulated: result.simulated };
    } catch (error) {
      return { model, ok: false, error: error.message, code: error.code ?? "error", latencyMs: Date.now() - started };
    }
  }

  async function raw({ method = "POST", path, body, query, signal } = {}) {
    if (!path || !path.startsWith("/")) {
      throw new NimError("Raw passthrough needs an absolute API path like /chat/completions", { code: "bad_path", status: 400 });
    }
    const cfg = config();
    if (cfg.simulation) {
      // Without a key the passthrough still has to be explorable: answer the
      // OpenAI-shaped paths locally and label the envelope as simulated.
      const route = path.replace(/^\/+/, "").split("?")[0];
      const model = body?.model ?? selectModel("chat");
      const payload = body ?? {};
      if (route === "models") {
        const data = MODEL_CATALOG.map((entry) => ({
          id: entry.id,
          object: "model",
          owned_by: entry.vendor,
          created: 0,
          capabilities: entry.capabilities,
        }));
        return { simulated: true, path, method, data: { object: "list", data, count: data.length }, latencyMs: 4 };
      }
      if (route === "chat/completions") {
        const result = simChat({
          model,
          messages: Array.isArray(payload.messages) ? payload.messages : [{ role: "user", content: String(payload.prompt ?? "") }],
          responseFormat: payload.response_format,
          temperature: payload.temperature,
          tools: payload.tools,
          seed: payload.seed,
          signal,
        });
        return {
          simulated: true,
          path,
          method,
          latencyMs: result.latencyMs,
          data: {
            id: `chatcmpl-sim-${Date.now().toString(36)}`,
            object: "chat.completion",
            model,
            choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: result.text } }],
            usage: result.usage,
          },
        };
      }
      if (route === "completions") {
        const result = simComplete({ model, prompt: String(payload.prompt ?? "") });
        return {
          simulated: true,
          path,
          method,
          latencyMs: result.latencyMs,
          data: {
            id: `cmpl-sim-${Date.now().toString(36)}`,
            object: "text_completion",
            model,
            choices: [{ index: 0, text: result.text, finish_reason: "stop" }],
            usage: result.usage,
          },
        };
      }
      if (route === "embeddings") {
        const input = Array.isArray(payload.input) ? payload.input : [String(payload.input ?? "")];
        const result = simEmbed({ model, inputs: input });
        return {
          simulated: true,
          path,
          method,
          latencyMs: result.latencyMs,
          data: {
            object: "list",
            model,
            data: result.vectors.map((vector, index) => ({ object: "embedding", index, embedding: vector })),
            usage: result.usage,
          },
        };
      }
      if (route === "ranking") {
        const passages = Array.isArray(payload.passages) ? payload.passages : Array.isArray(payload.documents) ? payload.documents : [];
        const result = simRerank({ model, query: String(payload.query ?? ""), passages, topN: payload.top_n });
        return {
          simulated: true,
          path,
          method,
          latencyMs: result.latencyMs,
          data: { object: "list", model, rankings: result.rankings },
        };
      }
      const error = new NimError(`No simulated implementation for /${route}.`, {
        status: 400,
        code: "simulation_only",
        hint: "Add a key in Settings, or call one of /chat/completions, /completions, /embeddings, /ranking or /models.",
      });
      throw error;
    }
    const { data, latencyMs } = await request(path, { method, body, query, signal });
    return { data, latencyMs, path, method };
  }

  function status() {
    const cfg = config();
    return {
      mode: cfg.simulation ? "simulation" : "live",
      baseUrl: cfg.baseUrl,
      keyPresent: Boolean(cfg.apiKey),
      keyHint: cfg.apiKey ? `${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}` : "",
    };
  }

  return {
    status,
    chat,
    complete,
    embed,
    rerank,
    generateImage,
    generateVideo,
    parse,
    translate,
    safety,
    biology,
    listModels,
    probeModel,
    raw,
    imageContent,
  };
}
