/**
 * Catalog tests: the clone is only honest if the three NVIDIA surfaces are real.
 * Models come from /v1/models, skills from github.com/NVIDIA/skills, blueprints
 * from build.nvidia.com/blueprints.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CAPABILITIES,
  DEFAULTS,
  MODEL_CATALOG,
  catalogSummary,
  defaults,
  findModel,
  mergeLive,
  selectModel,
} from "../server/nim/catalog.mjs";
import { BLUEPRINTS, blueprintStats, getBlueprint, listBlueprints, planBlueprint } from "../server/nim/blueprints.mjs";
import { loadSkills, searchSkills, suggestSkills } from "../server/nim/skills.mjs";

test("model catalog covers the NIM surface with unique ids", () => {
  assert.ok(MODEL_CATALOG.length >= 80, `expected 80+ models, got ${MODEL_CATALOG.length}`);
  const ids = new Set(MODEL_CATALOG.map((model) => model.id));
  assert.equal(ids.size, MODEL_CATALOG.length, "model ids must be unique");
  for (const model of MODEL_CATALOG) {
    assert.ok(model.id.includes("/"), `${model.id} should be vendor/name`);
    assert.ok(model.capabilities.length > 0, `${model.id} needs at least one capability`);
    for (const capability of model.capabilities) {
      assert.ok(CAPABILITIES[capability], `${model.id} has an unknown capability: ${capability}`);
    }
  }
});

test("every endpoint family has at least one model", () => {
  const required = ["chat", "reasoning", "tools", "code", "vision", "embedding", "rerank", "image", "safety", "parse", "translate", "protein"];
  const counts = catalogSummary().capabilities;
  for (const capability of required) {
    assert.ok((counts[capability] ?? 0) > 0, `no model advertises ${capability}`);
  }
});

test("configured defaults exist in the catalog and match their capability", () => {
  // `fast` is a routing key, not a capability: it still has to be a chat model.
  const expectedCapability = { embed: "embedding", fast: "chat" };
  for (const [key, id] of Object.entries(defaults())) {
    const model = findModel(id);
    assert.ok(model, `default ${key} model ${id} is missing from the catalog`);
    const expected = expectedCapability[key] ?? key;
    assert.ok(model.capabilities.includes(expected), `${id} does not advertise ${expected}`);
  }
  assert.ok(findModel(DEFAULTS.chat));
});

test("selectModel prefers the requested model, then the default, then anything usable", () => {
  assert.equal(selectModel("embedding", "nvidia/llama-3.2-nv-embedqa-1b-v1"), "nvidia/llama-3.2-nv-embedqa-1b-v1");
  assert.equal(selectModel("embedding", "not/a-real-model"), defaults().embed);
  const fallback = selectModel("image");
  assert.ok(findModel(fallback).capabilities.includes("image"));
});

test("mergeLive adds unknown live models without dropping the snapshot", () => {
  const { models, syncedAt, liveCount } = mergeLive([{ id: "nvidia/nemotron-3-super-120b-a12b" }, { id: "nvidia/brand-new-nim" }], {
    now: "2026-01-01T00:00:00.000Z",
  });
  assert.equal(models.length, MODEL_CATALOG.length + 1);
  assert.equal(syncedAt, "2026-01-01T00:00:00.000Z");
  assert.equal(liveCount, 2);
  const merged = models;
  const added = merged.find((model) => model.id === "nvidia/brand-new-nim");
  assert.equal(added.capabilities.includes("chat"), true);
  const known = merged.find((model) => model.id === "nvidia/nemotron-3-super-120b-a12b");
  assert.equal(known.verified, true);
});

test("skills catalog holds all 430 NVIDIA skills across 15 categories", () => {
  const catalog = loadSkills();
  assert.equal(catalog.count, 430);
  assert.equal(catalog.skills.length, 430);
  assert.equal(catalog.categories.length, 15);
  for (const skill of catalog.skills.slice(0, 50)) {
    assert.ok(skill.id && skill.title && skill.category, "skill needs id/title/category");
    assert.ok(Array.isArray(skill.tags));
  }
});

test("skill search matches title, description and tags", () => {
  const byTitle = searchSkills({ query: "cosmos", limit: 10 });
  assert.ok(byTitle.items.length > 0);
  assert.ok(byTitle.total >= byTitle.items.length);
  assert.ok(byTitle.items.every((skill) => /cosmos/i.test(`${skill.title} ${skill.description} ${skill.tags.join(" ")}`)));

  const byCategory = searchSkills({ category: loadSkills().categories[0], limit: 5 });
  assert.ok(byCategory.items.length > 0);
  assert.ok(byCategory.items.every((skill) => skill.category === loadSkills().categories[0]));

  const suggestions = suggestSkills({ text: "build a retrieval augmented generation pipeline over pdfs", limit: 5 });
  assert.ok(suggestions.length > 0);
  assert.ok(suggestions.length <= 5);
});

test("blueprints are the 36 reference architectures plus the Physical AI cell", () => {
  const stats = blueprintStats();
  // 36 come from build.nvidia.com; physical-ai-robotics is ours, because the
  // reference set has no teleoperation → policy → sim-to-real pipeline.
  assert.equal(stats.count, 37);
  assert.equal(BLUEPRINTS.length, 37);
  assert.ok(BLUEPRINTS.some((blueprint) => blueprint.id === "physical-ai-robotics"));
  assert.ok(stats.categories.length >= 5);
  for (const blueprint of BLUEPRINTS) {
    assert.ok(blueprint.id && blueprint.name, `${blueprint.id} needs an id and a name`);
    assert.ok(blueprint.team.length >= 2, `${blueprint.id} should staff a team`);
    assert.ok(blueprint.steps.length >= 2, `${blueprint.id} should describe a pipeline`);
    assert.ok(blueprint.backlog.length >= 3, `${blueprint.id} should ship a backlog`);
    assert.ok(blueprint.functions.length >= 1);
    assert.ok(getBlueprint(blueprint.id), `${blueprint.id} must be retrievable`);
  }
});

test("blueprint search filters by category and query", () => {
  const all = listBlueprints({});
  assert.equal(all.length, 37);
  const category = BLUEPRINTS[0].category;
  const filtered = listBlueprints({ category });
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((blueprint) => blueprint.category === category));
  const searched = listBlueprints({ query: "retrieval" });
  assert.ok(searched.length > 0);
});

test("planBlueprint yields a deployable team, goal and backlog", () => {
  const plan = planBlueprint(BLUEPRINTS[0].id, { issuePrefix: "NW" });
  assert.ok(plan.agents.length >= 2);
  assert.ok(plan.goal.title && plan.goal.metric);
  assert.ok(plan.issues.length >= 3);
  assert.ok(plan.issues.every((issue) => issue.title && issue.key.startsWith("NW-") && issue.acceptance.length));
  assert.ok(plan.issues.every((issue) => Number.isInteger(issue.ownerIndex) && issue.ownerIndex < plan.agents.length));
});

test("every model referenced by a blueprint exists in the catalog", () => {
  const ids = new Set(MODEL_CATALOG.map((model) => model.id));
  for (const blueprint of BLUEPRINTS) {
    for (const model of blueprint.models) {
      assert.ok(ids.has(model), `${blueprint.id} references unknown model ${model}`);
    }
  }
});
