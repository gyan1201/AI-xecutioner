import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NIM_SIMULATION = "1";
process.env.NVIDIA_AUTOPILOT_DATA_DIR = mkdtempSync(join(tmpdir(), "nvidia-autopilot-snippets-"));

import { parseSnippet, runSnippet } from "../server/snippets.mjs";
const { createRuntime } = await import("../server/runtime.mjs");
const { createApp } = await import("../server/routes.mjs");

// A 1x1 transparent PNG. Small on purpose: the shape of the request is what
// matters here, not the pixels.
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF6zM0AAAAASUVORK5CYII=";
const KEY = `nvapi-${"SNIPPET".repeat(5)}-Zz9`;

const PYTHON_SNIPPET = `
import base64
from pathlib import Path
import requests

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
stream = False

def media_data_url(kind, index, mime_types):
    return "data:image/png;base64,..."

image_data_urls = [media_data_url("image", i, {".png": "image/png"}) for i in [1]]

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
        {"type": "image_url", "image_url": {"url": "${PNG_DATA_URL}"}}
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

response = requests.post(invoke_url, headers=headers, json=payload, stream=stream)
print(response.json())
`;

test("a python snippet is parsed into the exact chat payload", () => {
  const result = parseSnippet(PYTHON_SNIPPET);
  assert.equal(result.ok, true);
  assert.equal(result.invocation.endpoint, "https://integrate.api.nvidia.com/v1/chat/completions");
  assert.equal(result.payload.model, "mistralai/mistral-large-4-1t-a52b");
  assert.equal(result.payload.stream, false);
  assert.deepEqual(result.payload.params, {
    maxTokens: 4096,
    temperature: 0.5,
    topP: 1,
    frequencyPenalty: 0,
    presencePenalty: 0,
    reasoningEffort: "high",
  });

  const [message] = result.payload.messages;
  assert.equal(message.role, "user");
  assert.equal(message.content.length, 2);
  assert.equal(message.content[0].type, "text");
  assert.equal(message.content[1].type, "image_url");
  assert.equal(message.content[1].image_url.url, PNG_DATA_URL, "data URLs must survive intact");

  assert.equal(result.warnings.includes("The payload has no usable messages."), false);
  assert.ok(!result.curl.includes(KEY), "the cURL preview must never contain the key");
  assert.match(result.curl, /reasoning_effort/);
});

test("curl, node and bare JSON bodies are accepted too", () => {
  const curl = parseSnippet(
    `curl -s https://integrate.api.nvidia.com/v1/chat/completions -H "Authorization: Bearer ${KEY}" -H "Content-Type: application/json" -d '{"model":"qwen/qwen3-235b-a22b","messages":[{"role":"user","content":"hello"}],"stream":true}'`,
  );
  assert.equal(curl.ok, true);
  assert.equal(curl.payload.model, "qwen/qwen3-235b-a22b");
  assert.equal(curl.payload.stream, true);

  const node = parseSnippet(
    `const body = {"model":"nvidia/nemotron-3-super-120b-a12b","messages":[{"role":"user","content":"hey"}],"top_p":0.9,"max_tokens":256}`,
  );
  assert.equal(node.ok, true);
  assert.deepEqual(node.payload.params, { topP: 0.9, maxTokens: 256 });

  const json = parseSnippet(JSON.stringify({ model: "meta/llama-3.3-70b-instruct", messages: [{ role: "user", content: "hi" }] }));
  assert.equal(json.ok, true);
  assert.equal(json.payload.model, "meta/llama-3.3-70b-instruct");

  const singleQuoted = parseSnippet(`payload = {'model': 'meta/llama-3.3-70b-instruct', 'messages': [{'role': 'user', 'content': 'hi'}]}`);
  assert.equal(singleQuoted.ok, true);
  assert.equal(singleQuoted.payload.model, "meta/llama-3.3-70b-instruct");
});

test("unusable snippets fail with an explanation, not a crash", () => {
  const junk = parseSnippet("hello world, no request here");
  assert.equal(junk.ok, false);
  assert.match(junk.error, /No chat-completions payload/);

  const empty = parseSnippet("");
  assert.equal(empty.ok, false);

  const noMessages = parseSnippet(JSON.stringify({ model: "meta/llama-3.3-70b-instruct", messages: [] }));
  assert.equal(noMessages.ok, false);

  const localFile = parseSnippet(
    `payload = {"model": "m/x", "messages": [{"role":"user","content":[{"type":"image_url","image_url":{"url": image_data_urls[0]}}]}]}`,
  );
  assert.equal(localFile.ok, false, "an image reference we cannot resolve leaves no usable content");
});

test("running a snippet sends the same wire format the snippet described", async () => {
  const captured = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    captured.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(
      JSON.stringify({
        model: "mistralai/mistral-large-4-1t-a52b",
        choices: [{ message: { role: "assistant", content: "Left: a blue circle. Right: a red square." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 42, completion_tokens: 11, total_tokens: 53 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  // The wire-format test needs live mode so the client actually POSTs; the rest
  // of this file runs simulated.
  const previousSimulation = process.env.NIM_SIMULATION;
  const previousKey = process.env.NVIDIA_API_KEY;
  delete process.env.NIM_SIMULATION;
  process.env.NVIDIA_API_KEY = KEY;

  try {
    const runtime = createRuntime();
    const snippet = parseSnippet(PYTHON_SNIPPET);
    const result = await runSnippet({ nim: runtime.nim, snippet });

    assert.equal(captured.length, 1);
    const sent = captured[0];
    assert.match(sent.url, /\/v1\/chat\/completions$/);
    assert.equal(sent.body.model, "mistralai/mistral-large-4-1t-a52b");
    assert.equal(sent.body.temperature, 0.5);
    assert.equal(sent.body.top_p, 1);
    assert.equal(sent.body.max_tokens, 4096);
    assert.equal(sent.body.frequency_penalty, 0);
    assert.equal(sent.body.presence_penalty, 0);
    assert.equal(sent.body.reasoning_effort, "high", "reasoning_effort must reach the wire");
    assert.equal(sent.body.stream, false);
    assert.equal(sent.body.messages[0].content[1].image_url.url, PNG_DATA_URL, "the image must be forwarded");
    assert.equal(result.content, "Left: a blue circle. Right: a red square.");
    assert.equal(result.usage.totalTokens, 53);
    assert.equal(result.streamed, false);
  } finally {
    globalThis.fetch = realFetch;
    if (previousSimulation === undefined) delete process.env.NIM_SIMULATION;
    else process.env.NIM_SIMULATION = previousSimulation;
    if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
  }
});

test("a blocked network is reported as egress, not as a bad key", async () => {
  const previousSimulation = process.env.NIM_SIMULATION;
  const previousKey = process.env.NVIDIA_API_KEY;
  delete process.env.NIM_SIMULATION;
  process.env.NVIDIA_API_KEY = KEY;
  const realFetch = globalThis.fetch;
  const failure = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  globalThis.fetch = async () => {
    throw failure;
  };
  try {
    const { createNim } = await import("../server/nim.mjs");
    const { loadConfig } = await import("../server/config.mjs");
    const nim = createNim({ getConfig: loadConfig });
    await assert.rejects(
      () => nim.chat({ model: "meta/llama-3.3-70b-instruct", messages: [{ role: "user", content: "hi" }] }),
      (error) => {
        assert.equal(error.code, "ECONNRESET");
        assert.match(error.hint, /egress|proxy|firewall/i);
        assert.doesNotMatch(error.hint, /rejected the API key/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = realFetch;
    if (previousSimulation === undefined) delete process.env.NIM_SIMULATION;
    else process.env.NIM_SIMULATION = previousSimulation;
    if (previousKey === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousKey;
  }
});

/* ------------------------------- HTTP layer ------------------------------- */

const runtime = createRuntime();
const handler = createApp(runtime);
const server = createServer((req, res) => void handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const json = async (path, body) => {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};

test("POST /api/snippets/parse previews without calling NVIDIA", async () => {
  const result = await json("/api/snippets/parse", { text: PYTHON_SNIPPET });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.payload.model, "mistralai/mistral-large-4-1t-a52b");
  assert.equal(result.body.payload.params.reasoningEffort, "high");
  assert.ok(result.body.curl);
  assert.ok(!JSON.stringify(result.body).includes(KEY));

  const junk = await json("/api/snippets/parse", { text: "nope" });
  assert.equal(junk.status, 200);
  assert.equal(junk.body.ok, false);
  assert.ok(junk.body.error);
});

test("POST /api/snippets/run replays the request and reports usage", async () => {
  const result = await json("/api/snippets/run", { text: PYTHON_SNIPPET });
  assert.equal(result.status, 200);
  assert.equal(result.body.model, "mistralai/mistral-large-4-1t-a52b");
  assert.equal(result.body.simulated, true);
  assert.ok(result.body.content.length > 20);
  assert.ok(result.body.usage.totalTokens > 0);
  assert.equal(result.body.request.reasoning_effort, "high");
  assert.equal(result.body.request.messages[0].content[1].image_url.url, "<image>", "request echo hides image bytes");

  const junk = await json("/api/snippets/run", { text: "no payload here" });
  assert.equal(junk.status, 422);
  assert.match(junk.body.error, /payload/i);

  const noModel = await json("/api/snippets/run", {
    text: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(noModel.status, 422);
  assert.match(noModel.body.error, /model/i);
});
