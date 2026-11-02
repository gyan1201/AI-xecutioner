import assert from "node:assert/strict";
import test from "node:test";

import { describeModel, inferCapabilities, resolveRoles, MODEL_PRESETS, AGENT_TOOLS } from "../server/catalog.mjs";

test("curated presets carry sensible capabilities", () => {
  for (const preset of MODEL_PRESETS) {
    assert.ok(preset.id.includes("/"), `${preset.id} must be publisher/model`);
    assert.ok(preset.capabilities.length > 0, `${preset.id} needs at least one capability`);
  }
  const embedder = describeModel("nvidia/llama-3.2-nv-embedqa-1b-v2");
  assert.ok(embedder.capabilities.includes("embedding"));
  assert.ok(!embedder.capabilities.includes("chat"), "embedding models must not be offered as chat models");
});

test("capability inference labels unknown model ids", () => {
  assert.ok(inferCapabilities("acme/cool-embed-v9").includes("embedding"));
  assert.ok(inferCapabilities("acme/ranker-rerank-3b").includes("rerank"));
  assert.ok(inferCapabilities("acme/guard-safety-2b").includes("safety"));
  assert.ok(inferCapabilities("acme/vision-vl-7b").includes("vision"));
  assert.ok(inferCapabilities("acme/flux-image-pro").includes("image"));
  assert.deepEqual(inferCapabilities("acme/plain-chat-model"), ["chat"]);
});

test("role resolution prefers pinned models that exist in the live catalog", () => {
  const roles = resolveRoles(["meta/llama-3.3-70b-instruct", "nvidia/llama-3.2-nv-embedqa-1b-v2"]);
  assert.equal(roles.strategist.model, "meta/llama-3.3-70b-instruct");
  assert.equal(roles.strategist.resolvedFrom, "pinned");
  assert.equal(roles.embedder.model, "nvidia/llama-3.2-nv-embedqa-1b-v2");
});

test("role resolution falls back to defaults when the catalog is empty", () => {
  const roles = resolveRoles([]);
  for (const role of ["strategist", "analyst", "operator", "critic", "safety", "scribe", "embedder", "reranker", "artist"]) {
    assert.ok(roles[role], `missing role ${role}`);
    assert.equal(roles[role].model, MODEL_PRESETS.find((preset) => preset.id === roles[role].model)?.id ?? roles[role].model);
  }
});

test("agent tools expose valid OpenAI function schemas", () => {
  assert.ok(AGENT_TOOLS.length >= 5);
  for (const tool of AGENT_TOOLS) {
    assert.equal(tool.type, "function");
    assert.ok(tool.function.name.match(/^[a-z_]+$/));
    assert.equal(tool.function.parameters.type, "object");
    assert.ok(Array.isArray(tool.function.parameters.required));
  }
});
