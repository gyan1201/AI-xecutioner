import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NIM_SIMULATION = "1";
process.env.NVIDIA_AUTOPILOT_DATA_DIR = mkdtempSync(join(tmpdir(), "nvidia-autopilot-ui-"));

let JSDOM = null;
try {
  ({ JSDOM } = await import("jsdom"));
} catch {
  // The UI smoke test is optional: install jsdom (npm i --no-save jsdom) to run it.
}

const { createRuntime } = await import("../server/runtime.mjs");
const { createApp } = await import("../server/routes.mjs");
const { api } = await import("../web/lib.js");

const views = {
  dashboard: await import("../web/views/dashboard.js"),
  autopilot: await import("../web/views/autopilot.js"),
  companies: await import("../web/views/companies.js"),
  chat: await import("../web/views/chat.js"),
  knowledge: await import("../web/views/knowledge.js"),
  models: await import("../web/views/models.js"),
  guardrails: await import("../web/views/guardrails.js"),
  studio: await import("../web/views/studio.js"),
  settings: await import("../web/views/settings.js"),
};

const runtime = createRuntime();
const handler = createApp(runtime);
const server = createServer((req, res) => void handler(req, res));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

test("every view renders against the live API without throwing", { skip: !JSDOM }, async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='view'></div></body></html>", { url: origin });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.location = dom.window.location;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.EventSource = class {
    constructor() {}
    addEventListener() {}
    close() {}
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => realFetch(typeof input === "string" && input.startsWith("/") ? `${origin}${input}` : input, init);

  await runtime.loadModels();
  await api.post("/api/knowledge", {
    title: "Test memo",
    text: "Northwind activation target is 20% growth. Pricing is $49 per seat.",
  });
  await api.post("/api/knowledge/index", {});

  const run = await runtime.autopilot.start({ goal: "Increase activation by 20% with a guided onboarding flow.", options: { requireApproval: "never", maxSteps: 3 } });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = runtime.autopilot.get(run.id);
    if (["completed", "completed_with_issues", "failed", "blocked"].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const ctx = {
    api,
    state: { status: await api.get("/api/status") },
    navigate: (path) => {
      ctx.lastNav = path;
    },
    refresh: async () => {},
    params: [],
    setTitle: () => {},
  };

  const EXPECTED = {
    dashboard: /Give one company goal/,
    autopilot: /Autopilot runs|Work items/,
    companies: /Describe the company/,
    chat: /Chat lab/,
    knowledge: /Knowledge & RAG/,
    models: /Models & routing/,
    guardrails: /Run guardrails/,
    studio: /Visual studio/,
    settings: /NVIDIA API key/,
  };

  const host = dom.window.document.getElementById("view");
  // Settings carries the model catalog and the key database, so check them
  // before the generic loop re-renders everything.
  host.innerHTML = "";
  const settingsCleanup = await views.settings.render(host, ctx, []);
  assert.ok(host.querySelectorAll("#model-rows tr").length > 50, "the full model catalog should be listed");
  assert.ok(host.querySelector("#models-card"), "models section missing");
  assert.ok(host.querySelector("#keys-card"), "key database section missing");
  assert.match(host.textContent, /Model catalog/);
  assert.match(host.textContent, /API key database/);
  if (typeof settingsCleanup === "function") settingsCleanup();

  for (const [name, view] of Object.entries(views)) {
    host.innerHTML = "";
    const cleanup = await view.render(host, ctx, []);
    assert.ok(host.textContent.trim().length > 40, `${name} view rendered almost nothing`);
    assert.match(host.textContent, EXPECTED[name], `${name} view is missing its expected content`);
    if (typeof cleanup === "function") cleanup();
  }

  // Company OS: build one from a goal, then render its detail view.
  const company = await runtime.company.createCompany({
    name: "UI Co",
    goal: "Launch a paid beta for the analytics product within one quarter.",
    budgetMonthlyCents: 4000,
  });
  await runtime.company.runCycle(company.id);

  host.innerHTML = "";
  const companyCleanup = await views.companies.render(host, ctx, [company.id]);
  const companyText = host.textContent;
  assert.match(companyText, /UI Co/);
  assert.match(companyText, /Board/);
  assert.match(companyText, /Paperclip bridge|Autopilot|Organization/);
  assert.ok(host.querySelectorAll(".task").length >= 1, "the board should list issues");
  assert.ok(host.querySelectorAll("[data-tab]").length >= 4, "company tabs should render");
  // Visit every tab so no branch of the detail view stays unrendered.
  for (const button of [...host.querySelectorAll("[data-tab]")]) {
    button.dispatchEvent(new dom.window.Event("click"));
    assert.ok(host.textContent.trim().length > 200, `${button.dataset.tab} tab rendered almost nothing`);
  }
  if (typeof companyCleanup === "function") companyCleanup();

  // Detail view for a finished run, including the SSE wiring.
  host.innerHTML = "";
  const cleanup = await views.autopilot.render(host, ctx, [run.id]);
  const text = host.textContent;
  assert.match(text, /Work items/);
  assert.match(text, /Executive report/);
  assert.match(text, /Artifacts/);
  assert.ok(host.querySelectorAll(".task").length >= 1, "work items should be listed");
  if (typeof cleanup === "function") cleanup();

  globalThis.fetch = realFetch;
  dom.window.close();
});
