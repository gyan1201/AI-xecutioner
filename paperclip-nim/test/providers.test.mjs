/**
 * Provider intake: "one key, every model".
 *
 * Two layers are covered: the pure detector (pasted Python/cURL snippets of
 * every shape we claim to support) and the HTTP flow that turns a snippet into
 * a stored provider, a vault key and a usable model — without leaking the key
 * back to the browser.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

process.env.PAPERCLIP_DATA_DIR = mkdtempSync(join(tmpdir(), "paperclip-nim-providers-"));
process.env.LOG_REQUESTS = "0";
process.env.FORCE_SIMULATION = "1";
delete process.env.NVIDIA_API_KEY;
delete process.env.NIM_API_KEY;

const { detectSetup, getProvider, allProviderSummaries } = await import("../server/nim/providers.mjs");
const { createRuntime } = await import("../server/runtime.mjs");
const { createApp } = await import("../server/routes.mjs");

const NVIDIA_SNIPPET = [
  "from openai import OpenAI",
  "",
  "client = OpenAI(",
  '  base_url="https://integrate.api.nvidia.com/v1",',
  '  api_key="nvapi-AbCdEfGhIjKlMnOp123456"',
  ")",
  "",
  "response = client.chat.completions.create(",
  '  model="nvidia/nemotron-3-super-120b-a12b",',
  '  messages=[{"role": "user", "content": "Hello"}],',
  ")",
].join("\n");

const GROQ_SNIPPET = [
  "from groq import Groq",
  "",
  'client = Groq(api_key="gsk_ZZZZyyyyXXXXwwwwVVVVuuuu1234")',
  "",
  "chat = client.chat.completions.create(",
  '  model="llama-3.3-70b-versatile",',
  '  messages=[{"role": "user", "content": "Hello"}],',
  ")",
].join("\n");

const OPENAI_CURL = [
  "curl https://api.openai.com/v1/chat/completions \\",
  '  -H "Content-Type: application/json" \\',
  '  -H "Authorization: Bearer sk-proj-qqqqwwwwEEEERRRRttttyyyy1234" \\',
  `  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "Hello"}]}'`,
].join("\n");

describe("snippet detection", () => {
  test("NVIDIA python snippet: provider, key, model, base URL", () => {
    const detection = detectSetup(NVIDIA_SNIPPET);
    assert.equal(detection.providerId, "nvidia");
    assert.equal(detection.baseUrl, "https://integrate.api.nvidia.com/v1");
    assert.equal(detection.key, "nvapi-AbCdEfGhIjKlMnOp123456");
    assert.equal(detection.model, "nvidia/nemotron-3-super-120b-a12b");
    assert.equal(detection.confidence, "high");
    assert.match(detection.keyMasked, /^nvapi-…/);
  });

  test("Groq python snippet is not mistaken for OpenAI", () => {
    const detection = detectSetup(GROQ_SNIPPET);
    assert.equal(detection.providerId, "groq");
    assert.equal(detection.baseUrl, "https://api.groq.com/openai/v1");
    assert.equal(detection.model, "llama-3.3-70b-versatile");
    assert.equal(detection.confidence, "high");
  });

  test("OpenAI cURL snippet: bearer token and JSON body", () => {
    const detection = detectSetup(OPENAI_CURL);
    assert.equal(detection.providerId, "openai");
    assert.ok(detection.key.startsWith("sk-proj-"));
    assert.equal(detection.model, "gpt-4o-mini");
  });

  test("a bare NVIDIA key is enough on its own", () => {
    const detection = detectSetup("nvapi-1234567890abcdefghijklmn");
    assert.equal(detection.providerId, "nvidia");
    assert.equal(detection.baseUrl, "https://integrate.api.nvidia.com/v1");
    assert.equal(detection.model, "");
  });

  test("environment-variable snippets explain why there is nothing to extract", () => {
    const detection = detectSetup('client = OpenAI(api_key=os.environ["NVIDIA_API_KEY"], base_url="https://integrate.api.nvidia.com/v1")');
    assert.equal(detection.key, "");
    assert.match(detection.warnings.join(" "), /environment variable/i);
  });

  test("an unknown host is offered as a custom OpenAI-compatible endpoint", () => {
    const detection = detectSetup('client = OpenAI(base_url="https://llm.internal.example.com/v1", api_key="abc123def456ghi789jkl012")');
    assert.equal(detection.baseUrl, "https://llm.internal.example.com/v1");
    assert.equal(detection.key, "abc123def456ghi789jkl012");
    assert.match(detection.warnings.join(" "), /custom OpenAI-compatible/i);
  });

  test("a stub endpoint collapses to the provider root", () => {
    const detection = detectSetup('curl https://api.openai.com/v1/chat/completions -H "Authorization: Bearer sk-proj-aaaaaaaaaaaaaaaaaaaa1111"');
    assert.equal(detection.baseUrl, "https://api.openai.com/v1");
  });

  test("every advertised provider is in the registry with a base URL", () => {
    const available = allProviderSummaries();
    for (const id of ["nvidia", "openai", "groq"]) assert.ok(getProvider(id), `${id} must exist`);
    for (const provider of available) {
      assert.match(provider.baseUrl, /^https:\/\//, `${provider.id} needs an https base URL`);
      assert.ok(provider.name && provider.docs, `${provider.id} needs a name and docs link`);
    }
  });
});

describe("provider API", () => {
  let server;
  let base;
  const json = async (path, options = {}) => {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers: options.body ? { "Content-Type": "application/json" } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  before(async () => {
    const runtime = createRuntime({ logger: { log() {}, warn() {}, error() {} } });
    const app = createApp(runtime);
    server = createServer((req, res) =>
      Promise.resolve(app(req, res)).catch((error) => {
        if (!res.headersSent) res.writeHead(error?.status ?? 500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: error?.message ?? "Internal error", code: error?.code ?? "error" }));
      }),
    );
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    server?.closeAllConnections?.();
    await new Promise((resolve) => server?.close(resolve));
    rmSync(process.env.PAPERCLIP_DATA_DIR, { recursive: true, force: true });
  });

  test("detect never echoes the raw key", async () => {
    const { status, body } = await json("/api/providers/detect", { method: "POST", body: { text: NVIDIA_SNIPPET } });
    assert.equal(status, 200);
    assert.equal(body.detection.key, undefined);
    assert.equal(body.detection.hasKey, true);
    assert.ok(!JSON.stringify(body).includes("nvapi-AbCdEfGhIjKlMnOp123456"), "the raw key must not travel to the browser");
    assert.equal(body.detection.providerId, "nvidia");
  });

  test("apply configures the provider, stores the key and adds the model", async () => {
    const { status, body } = await json("/api/providers/apply", { method: "POST", body: { text: NVIDIA_SNIPPET } });
    assert.equal(status, 200);
    assert.match(body.message, /^Success! Auto-configured NVIDIA NIM provider/);
    assert.equal(body.provider.providerId, "nvidia");
    assert.equal(body.provider.baseUrl, "https://integrate.api.nvidia.com/v1");
    assert.equal(body.provider.keyPresent, true);
    assert.ok(body.keys.some((key) => key.providerId === "nvidia" && key.hint.startsWith("nvapi-…")));
    assert.ok(!JSON.stringify(body).includes("nvapi-AbCdEfGhIjKlMnOp123456"), "responses must stay masked");

    const models = await json("/api/models");
    assert.equal(models.body.nvidiaUnlocked, true);
    assert.ok(models.body.summary.total >= 97);
  });

  test("a second provider coexists and does not hijack the NIM credential", async () => {
    const applied = await json("/api/providers/apply", { method: "POST", body: { text: GROQ_SNIPPET } });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.provider.providerId, "groq");

    const config = await json("/api/settings");
    assert.equal(config.body.config.baseUrl, "https://integrate.api.nvidia.com/v1");
    assert.equal(config.body.config.keySource, "settings");

    const models = await json("/api/models");
    const groqModel = models.body.models.find((model) => model.id === "llama-3.3-70b-versatile");
    assert.ok(groqModel, "the Groq model must appear in the picker");
    assert.equal(groqModel.providerId, "groq");
    assert.ok(models.body.models.some((model) => model.source === "connected"));
  });

  test("adding a model to a connection is idempotent", async () => {
    const first = await json("/api/providers/groq/models", { method: "POST", body: { model: "mixtral-8x7b-32768" } });
    assert.equal(first.status, 200);
    const second = await json("/api/providers/groq/models", { method: "POST", body: { model: "mixtral-8x7b-32768" } });
    assert.equal(second.status, 200);
    assert.equal(second.body.provider.models.filter((model) => model === "mixtral-8x7b-32768").length, 1);
  });

  test("snippets without a key fail with an actionable error", async () => {
    const { status, body } = await json("/api/providers/apply", {
      method: "POST",
      body: { text: 'client = OpenAI(api_key=os.environ["NVIDIA_API_KEY"])' },
    });
    assert.equal(status, 400);
    assert.equal(body.code, "missing_key");
    assert.ok(body.hint);
  });

  test("removing a connection drops its models and its stored key", async () => {
    const removed = await json("/api/providers/groq", { method: "DELETE" });
    assert.equal(removed.status, 200);
    assert.ok(!removed.body.providers.some((provider) => provider.providerId === "groq"));
    const models = await json("/api/models");
    assert.ok(!models.body.models.some((model) => model.providerId === "groq"));
    assert.ok(!models.body.models.some((model) => model.id === "llama-3.3-70b-versatile"));
  });
});
