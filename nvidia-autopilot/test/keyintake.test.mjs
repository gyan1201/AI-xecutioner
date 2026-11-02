import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NIM_SIMULATION = "1";
process.env.NVIDIA_AUTOPILOT_DATA_DIR = mkdtempSync(join(tmpdir(), "nvidia-autopilot-key-"));

import { parseCredentialText, maskKey, verifyCredential, pickDefaultModel } from "../server/keyintake.mjs";
const { createRuntime } = await import("../server/runtime.mjs");
const { createApp } = await import("../server/routes.mjs");

// A syntactically valid but fake key: never put a real credential in a test.
const KEY = `nvapi-${"TESTKEY".repeat(6)}-aBcD`;

const SNIPPET = `
import base64
from pathlib import Path
import requests

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
stream = False

def media_data_url(kind, index, mime_types):
    for suffix, mime in mime_types.items():
        path = Path(f"{kind}_{index}{suffix}")
        if path.exists():
            return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"
    raise FileNotFoundError(f"Expected {kind}_{index} with suffix in {list(mime_types)}")

image_data_urls = [media_data_url("image", i, {".png": "image/png", ".jpg": "image/jpeg"}) for i in [1]]

headers = {
    "Authorization": "Bearer ${KEY}",
    "Accept": "text/event-stream" if stream else "application/json",
}

payload = {
  "model": "mistralai/mistral-large-4-1t-a52b",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Describe the color and shape on the left and on the right."},
        {"type": "image_url", "image_url": {"url": image_data_urls[0]}}
      ]
    }
  ],
  "max_tokens": 4096,
  "stream": stream,
  "temperature": 0.5,
  "top_p": 1,
  "frequency_penalty": 0,
  "presence_penalty": 0,
  "reasoning_effort": "high"
}
`;

test("a whole request snippet configures the app in one paste", () => {
  const parsed = parseCredentialText(SNIPPET);

  assert.equal(parsed.apiKey, KEY);
  assert.equal(parsed.keyHint, maskKey(KEY));
  assert.ok(!parsed.keyHint.includes(KEY.slice(10)), "the hint must not leak the key");
  assert.equal(parsed.nimBaseUrl, "https://integrate.api.nvidia.com/v1");
  assert.deepEqual(parsed.models, ["mistralai/mistral-large-4-1t-a52b"]);
  assert.deepEqual(parsed.params, {
    temperature: 0.5,
    topP: 1,
    maxTokens: 4096,
    frequencyPenalty: 0,
    presencePenalty: 0,
    reasoningEffort: "high",
  });
  assert.equal(parsed.flags.vision, true);
  assert.equal(parsed.flags.stream, false);
  assert.equal(parsed.source, "text");
  assert.deepEqual(parsed.warnings, [], "a complete snippet needs no warnings");
  assert.equal(pickDefaultModel(parsed), "mistralai/mistral-large-4-1t-a52b");
});

test("every common way of pasting a key is accepted", () => {
  const cases = [
    KEY,
    `"${KEY}"`,
    `Bearer ${KEY}`,
    `export NVIDIA_API_KEY=${KEY}`,
    `NVIDIA_API_KEY: ${KEY}`,
    `curl https://integrate.api.nvidia.com/v1/chat/completions -H "Authorization: Bearer ${KEY}"`,
  ];
  for (const text of cases) {
    const parsed = parseCredentialText(text);
    assert.equal(parsed.apiKey, KEY, `failed to parse: ${text.slice(0, 40)}`);
    assert.equal(parsed.warnings.includes("No NVIDIA key found. Paste an `nvapi-…` key, a `NVIDIA_API_KEY=…` line, or the whole request snippet — the key is extracted either way."), false);
  }
});

test("endpoints and model ids are detected without being fooled by metadata", () => {
  const genai = parseCredentialText(
    "POST https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev with",
  );
  assert.equal(genai.genaiBaseUrl, "https://ai.api.nvidia.com/v1/genai");
  assert.match(genai.warnings.join(" "), /No NVIDIA key/);

  const selfHosted = parseCredentialText(`NVIDIA_BASE_URL=http://localhost:8000/v1\nNVIDIA_API_KEY=${KEY}`);
  assert.equal(selfHosted.nimBaseUrl, "http://localhost:8000/v1");

  const mimes = parseCredentialText(`Accept: application/json\nContent-Type: image/png\nmodel: meta/llama-3.3-70b-instruct`);
  assert.deepEqual(mimes.models, ["meta/llama-3.3-70b-instruct"], "MIME types are not model ids");
});

test("bad or masked input is rejected with guidance, never silently", () => {
  const empty = parseCredentialText("");
  assert.equal(empty.apiKey, null);
  assert.ok(empty.warnings.some((warning) => /No NVIDIA key/.test(warning)));

  const masked = parseCredentialText(`nvapi-${"•".repeat(12)}`);
  assert.equal(masked.apiKey, null);
  assert.ok(masked.warnings.some((warning) => /masked/i.test(warning)));

  const twoKeys = parseCredentialText(`first ${KEY} second ${KEY.replace("aBcD", "wXyZ")}`);
  assert.equal(twoKeys.apiKey, KEY);
  assert.ok(twoKeys.warnings.some((warning) => /different keys/.test(warning)));
});

test("verification distinguishes a bad key from an unreachable host", async () => {
  const ok = await verifyCredential({
    apiKey: KEY,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ id: "meta/llama-3.3-70b-instruct" }, { id: "nvidia/nv-embedqa-e5-v5" }] }), {
        status: 200,
      }),
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.modelCount, 2);
  assert.deepEqual(ok.models, ["meta/llama-3.3-70b-instruct", "nvidia/nv-embedqa-e5-v5"]);

  const unauthorized = await verifyCredential({
    apiKey: "nvapi-wrong",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    fetchImpl: async () => new Response("{}", { status: 401 }),
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.reason, "unauthorized");
  assert.match(unauthorized.hint, /build\.nvidia\.com/);

  const offline = await verifyCredential({
    apiKey: KEY,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  assert.equal(offline.ok, false);
  assert.equal(offline.reason, "unreachable");
  assert.match(offline.hint, /saved/i);

  const missing = await verifyCredential({ apiKey: "", baseUrl: "https://integrate.api.nvidia.com/v1" });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing_key");
});

/* ------------------------------- HTTP layer ------------------------------- */

const runtime = createRuntime();
const handler = createApp(runtime);
const server = createServer((req, res) => void handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const json = async (path, options) => {
  const response = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

test("POST /api/settings/key auto-configures endpoints, model and params", async () => {
  const result = await json("/api/settings/key", {
    method: "POST",
    body: { text: SNIPPET, verify: false },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.applied, true);
  assert.equal(result.body.parsed.keyHint, maskKey(KEY));
  assert.equal(result.body.parsed.nimBaseUrl, "https://integrate.api.nvidia.com/v1");
  assert.deepEqual(result.body.parsed.models, ["mistralai/mistral-large-4-1t-a52b"]);
  assert.equal(result.body.verification.reason, "skipped");
  // No verification + an offline host must not flip the app into broken live mode.
  assert.equal(result.body.live, false);
  assert.equal(result.body.config.simulation, true);
  assert.equal(result.body.config.hasApiKey, true);
  assert.equal(result.body.config.keyHint, maskKey(KEY));
  assert.ok(!JSON.stringify(result.body).includes(KEY), "the API must never echo the key");

  const settings = await json("/api/settings");
  assert.equal(settings.body.defaultModel, "mistralai/mistral-large-4-1t-a52b");
  assert.equal(settings.body.defaults.chatModel, "mistralai/mistral-large-4-1t-a52b");
  assert.deepEqual(settings.body.defaults.params, {
    temperature: 0.5,
    topP: 1,
    maxTokens: 4096,
    frequencyPenalty: 0,
    presencePenalty: 0,
    reasoningEffort: "high",
  });
  assert.deepEqual(settings.body.pastedModels, ["mistralai/mistral-large-4-1t-a52b"]);
  assert.equal(settings.body.keyMeta.verified, false);
  assert.equal(settings.body.keyMeta.source, "pasted-snippet");

  // The pasted model becomes selectable and is used by default.
  const models = await json("/api/models?refresh=1");
  assert.ok(models.body.models.some((model) => model.id === "mistralai/mistral-large-4-1t-a52b"));
  assert.equal(models.body.defaultModel, "mistralai/mistral-large-4-1t-a52b");

  // A chat request without an explicit model uses the configured default.
  const chat = await json("/api/chat", { method: "POST", body: { messages: [{ role: "user", content: "ping" }] } });
  assert.equal(chat.status, 200);
  assert.equal(chat.body.model, "mistralai/mistral-large-4-1t-a52b");
});

test("credential intake never turns on live mode when NVIDIA rejects or is unreachable", async () => {
  const result = await json("/api/settings/key", {
    method: "POST",
    body: { text: KEY, timeoutMs: 1500 },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.verification.attempted, true);
  // This sandbox has no route to NVIDIA: either an explicit rejection or an
  // unreachable host — in both cases live stays off and the key is kept.
  assert.equal(result.body.verification.ok, false);
  assert.ok(["unreachable", "unauthorized", "rejected", "upstream_unavailable", "rate_limited"].includes(result.body.verification.reason));
  assert.equal(result.body.live, false);
  assert.equal(result.body.config.hasApiKey, true);
});

test("an explicit mode overrides verification, and bad input is a 422", async () => {
  const live = await json("/api/settings/key", {
    method: "POST",
    body: { text: KEY, verify: false, mode: "live" },
  });
  assert.equal(live.body.live, true);
  assert.equal(live.body.config.simulation, false);

  const back = await json("/api/settings/key", {
    method: "POST",
    body: { text: KEY, verify: false, mode: "simulation" },
  });
  assert.equal(back.body.live, false);

  const noKey = await json("/api/settings/key", { method: "POST", body: { text: "just some prose without a key" } });
  assert.equal(noKey.status, 422);
  assert.match(noKey.body.error, /No NVIDIA API key/);
  assert.ok(noKey.body.hint);

  const empty = await json("/api/settings/key", { method: "POST", body: {} });
  assert.equal(empty.status, 422);

  const verify = await json("/api/settings/key/verify", { method: "POST", body: { timeoutMs: 1500 } });
  assert.equal(verify.status, 200);
  assert.equal(verify.body.verification.attempted, true);
  assert.equal(verify.body.live, false);
});

test("removing the active key clears the models it brought in", async () => {
  // Every pasted key is also kept in the background vault; empty it so this
  // test is about removal, not about the vault fallback.
  const keys = await json("/api/keys");
  for (const key of keys.body.keys) {
    await json(`/api/keys/${key.id}`, { method: "DELETE" });
  }

  const cleared = await json("/api/settings", { method: "PUT", body: { apiKey: "", simulation: true } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.hasApiKey, false);
  const settings = await json("/api/settings");
  assert.deepEqual(settings.body.pastedModels, []);
  assert.equal(settings.body.defaultModel, null);
});
