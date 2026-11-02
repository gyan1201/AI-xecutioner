import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NIM_SIMULATION = "1";
process.env.NVIDIA_AUTOPILOT_DATA_DIR = mkdtempSync(join(tmpdir(), "nvidia-autopilot-vault-"));

const config = await import("../server/config.mjs");
const { createRuntime } = await import("../server/runtime.mjs");
const { createApp } = await import("../server/routes.mjs");
const { MODEL_CATALOG } = await import("../server/catalog.mjs");

const KEY_A = `nvapi-${"VAULTKEYA".repeat(4)}-aaaa`;
const KEY_B = `nvapi-${"VAULTKEYB".repeat(4)}-bbbb`;
const SNIPPET = `headers = {"Authorization": "Bearer ${KEY_A}"}\npayload = {"model": "mistralai/mistral-large-4-1t-a52b", "messages": [{"role": "user", "content": "hi"}]}`;

test("the key vault stores, masks, activates and removes credentials", () => {
  assert.equal(config.loadConfig().hasApiKey, false);
  assert.equal(config.publicConfig().needsApiKey, true);

  const first = config.addVaultKey({ apiKey: KEY_A, label: "work", verified: true, modelCount: 42, source: "pasted" });
  assert.equal(first.keyHint, "••••aaaa");
  assert.ok(!JSON.stringify(first).includes(KEY_A), "vault records are masked");

  const summary = config.vaultSummary();
  assert.equal(summary.count, 1);
  assert.equal(summary.verified, 1);
  assert.equal(summary.activeHint, "••••aaaa");
  assert.equal(summary.keys[0].label, "work");

  const cfg = config.loadConfig();
  assert.equal(cfg.hasApiKey, true);
  assert.equal(cfg.apiKey, KEY_A);
  assert.equal(cfg.keySource, "vault");
  // The public config never carries the secret.
  assert.ok(!JSON.stringify(config.publicConfig()).includes(KEY_A));
  assert.equal(config.publicConfig().keys.count, 1);

  const second = config.addVaultKey({ apiKey: KEY_B, label: "personal" });
  assert.equal(config.vaultSummary().count, 2);
  assert.equal(config.activateVaultKey(second.id).keyHint, "••••bbbb");
  assert.equal(config.loadConfig().apiKey, KEY_B);

  assert.deepEqual(config.removeVaultKey(first.id), { removed: first.id, remaining: 1 });
  assert.equal(config.loadConfig().apiKey, KEY_B);
  assert.equal(config.removeVaultKey("nope"), null);
});

test("the vault file is private and keeps the key out of settings", () => {
  const file = config.paths.keys;
  assert.ok(existsSync(file), "keys.json must exist after storing a key");
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode & 0o077, 0, "keys.json must not be group/world readable");
  assert.match(readFileSync(file, "utf8"), /apiKey/, "the vault stores the key (that is the point)");
  assert.ok(!JSON.stringify(config.readRuntimeSettings()).includes("nvapi-"), "settings.json is not the key store");
});

test("precedence is settings key > active vault key > environment", () => {
  const previousEnv = process.env.NVIDIA_API_KEY;
  process.env.NVIDIA_API_KEY = `nvapi-${"ENVKEY".repeat(6)}-cc`;
  try {
    assert.equal(config.loadConfig().keySource, "vault", "vault beats env");
    config.writeRuntimeSettings({ apiKey: `nvapi-${"SETTINGS".repeat(4)}-dd` });
    assert.equal(config.loadConfig().keySource, "settings");
    config.writeRuntimeSettings({ apiKey: "" });
    assert.equal(config.loadConfig().keySource, "vault");
  } finally {
    if (previousEnv === undefined) delete process.env.NVIDIA_API_KEY;
    else process.env.NVIDIA_API_KEY = previousEnv;
  }
});

/* ------------------------------- HTTP layer ------------------------------- */

const runtime = createRuntime();
const handler = createApp(runtime);
const server = createServer((req, res) => void handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const json = async (path, { method = "GET", body } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
};

test("the full catalog is browsable in families", async () => {
  const catalog = await json("/api/models/catalog");
  assert.equal(catalog.status, 200);
  assert.ok(catalog.body.total >= 100, `expected the hosted catalog, got ${catalog.body.total}`);
  assert.ok(MODEL_CATALOG.length >= 100);
  const families = catalog.body.groups.map((group) => group.capability);
  for (const family of ["chat", "embedding", "rerank", "safety", "image"]) {
    assert.ok(families.includes(family), `missing ${family} family`);
  }
  assert.ok(catalog.body.groups.every((group) => group.models.length > 0));
  const shown = catalog.body.groups.flatMap((group) => group.models).length;
  assert.equal(shown, catalog.body.total, "every model lands in exactly one family");

  const vision = catalog.body.groups.find((group) => group.capability === "vision");
  assert.ok(vision.models.every((model) => model.capabilities.includes("vision")));
  assert.ok(vision.models.some((model) => model.id.includes("llama-3.2-11b-vision")));
  const code = catalog.body.groups.find((group) => group.capability === "code");
  assert.ok(code.models.every((model) => model.capabilities.includes("code")));
  assert.ok(code.models.some((model) => model.id.includes("codestral")));
  const audio = catalog.body.groups.find((group) => group.capability === "audio");
  assert.ok(audio.models.some((model) => model.id.includes("parakeet")));
  const biology = catalog.body.groups.find((group) => group.capability === "biology");
  assert.ok(biology.models.some((model) => model.id.includes("esmfold")));

  const search = await json("/api/models/catalog?q=nemotron");
  assert.ok(search.body.shown >= 3);
  assert.ok(search.body.groups.flatMap((group) => group.models).every((model) => /nemotron/i.test(model.id) || /nemotron/i.test(model.label)));
});

test("keys can be added, activated and removed over HTTP", async () => {
  const before = await json("/api/keys");
  assert.equal(before.body.needsApiKey, false, "the vault already holds a key from the unit tests above");

  const added = await json("/api/keys", {
    method: "POST",
    body: { text: SNIPPET, label: "from snippet", verify: false },
  });
  assert.equal(added.status, 200);
  assert.equal(added.body.verification.reason, "skipped");
  assert.equal(added.body.key.keyHint, "••••aaaa");
  assert.ok(!JSON.stringify(added.body).includes(KEY_A), "the API never echoes a raw key");
  assert.ok(added.body.keys.count >= 2);

  const id = added.body.key.id;
  const activated = await json(`/api/keys/${id}`, { method: "PATCH", body: { active: true } });
  assert.equal(activated.status, 200);
  assert.equal(activated.body.keys.activeId, id);

  const renamed = await json(`/api/keys/${id}`, { method: "PATCH", body: { label: "rotated" } });
  assert.ok(renamed.body.keys.keys.some((key) => key.id === id && key.label === "rotated"));

  const removed = await json(`/api/keys/${id}`, { method: "DELETE" });
  assert.equal(removed.status, 200);
  assert.ok(!removed.body.keys.keys.some((key) => key.id === id));
  assert.equal((await json(`/api/keys/${id}`, { method: "DELETE" })).status, 404);

  const junk = await json("/api/keys", { method: "POST", body: { text: "no key here" } });
  assert.equal(junk.status, 422);
});

test("a default chat model can be chosen from the catalog", async () => {
  const chosen = "meta/llama-3.1-8b-instruct";
  const saved = await json("/api/settings", { method: "PUT", body: { defaults: { chatModel: chosen } } });
  assert.equal(saved.status, 200);

  const catalog = await json("/api/models/catalog");
  assert.equal(catalog.body.defaultModel, chosen);
  assert.ok(catalog.body.groups.flatMap((group) => group.models).some((model) => model.id === chosen));

  const chat = await json("/api/chat", { method: "POST", body: { messages: [{ role: "user", content: "ping" }] } });
  assert.equal(chat.body.model, chosen);
});

test("the vault keeps the app live when the pasted key is removed", async () => {
  const keys = await json("/api/keys");
  const survivor = keys.body.keys[0];
  const cleared = await json("/api/settings", { method: "PUT", body: { apiKey: "" } });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.hasApiKey, true, "the vault still supplies a key");
  assert.equal(cleared.body.keySource, "vault");
  assert.equal(cleared.body.simulation, false);

  await json(`/api/keys/${survivor.id}`, { method: "DELETE" });
  const after = await json("/api/settings");
  assert.equal(after.body.hasApiKey, false);
  assert.equal(after.body.needsApiKey, true);
});
