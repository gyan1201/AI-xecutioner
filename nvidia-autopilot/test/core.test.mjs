import assert from "node:assert/strict";
import test from "node:test";

import { calculate } from "../server/tools.mjs";
import { chunkText, cosine } from "../server/retrieval.mjs";
import { extractJson } from "../server/nim.mjs";

test("calculator evaluates arithmetic with precedence", () => {
  assert.equal(calculate("2 + 3 * 4"), 14);
  assert.equal(calculate("(2 + 3) * 4"), 20);
  assert.equal(calculate("-5 + 2 ^ 3"), 3);
  assert.equal(calculate("10 % 4"), 2);
  assert.equal(calculate("1.5e3 / 3"), 500);
});

test("calculator rejects non-arithmetic input", () => {
  assert.throws(() => calculate("process.exit(1)"), /Only numbers/);
  assert.throws(() => calculate("2 / 0"), /Division by zero/);
  assert.throws(() => calculate("2 +"), /Unexpected|not a number/);
});

test("chunking keeps every character reachable and respects size", () => {
  const text = Array.from({ length: 40 }, (_, index) => `Sentence number ${index} about pipeline quality.`).join(" ");
  const chunks = chunkText(text, { size: 200, overlap: 40 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 240, "chunk should respect the size budget");
  assert.ok(chunks.join(" ").includes("Sentence number 39"));
});

test("cosine similarity behaves for identical, orthogonal and empty vectors", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.equal(cosine([], []), 0);
});

test("extractJson recovers fenced and padded JSON", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here is the plan: {"a":[1,2]} — good luck'), { a: [1, 2] });
  assert.equal(extractJson("no json here"), null);
});
