import { api, debounce, esc, icon, md, stream, toast } from "../lib.js";
import { pageHeader } from "./shared.js";

/**
 * Full auto.
 *
 * Two answers — a company name and a goal — plus optional model keys are enough
 * to build a working company: Paperclip picks the closest NVIDIA blueprint,
 * rewrites its team and backlog around the goal, configures every key it was
 * given, and runs the first cycle. The preview panel is a real dry run against
 * `POST /api/launch/plan`; the launch itself streams its steps over SSE so the
 * user watches the company being built rather than a spinner.
 */

export const title = "New company";

const EXAMPLES = [
  "Cut customer support response time to under five minutes with an AI triage copilot",
  "Answer questions across our internal docs, with citations",
  "Screen every online order for fraud before it ships",
  "Generate on-brand marketing content for each product launch",
  "Summarise CCTV footage into incident reports for the security team",
];

const escapeAttr = (value) => esc(String(value ?? "")).replace(/"/g, "&quot;");

function stepRow(step) {
  const state = step.state === "running" ? "running" : step.ok === false ? "fail" : step.skipped ? "skip" : "ok";
  const glyph =
    state === "running"
      ? `<span class="step-spinner" aria-hidden="true"></span>`
      : state === "fail"
        ? icon("x", "step-glyph")
        : state === "skip"
          ? icon("clock", "step-glyph dim")
          : icon("check", "step-glyph ok");
  return `<div class="step ${state}" data-step="${escapeAttr(step.id)}">
    <span class="step-icon">${glyph}</span>
    <div class="step-body">
      <div class="step-label">${esc(step.label ?? step.id)}</div>
      ${step.detail ? `<div class="step-detail">${esc(step.detail)}</div>` : ""}
    </div>
  </div>`;
}

function previewPanel(plan, { loading = false } = {}) {
  if (loading && !plan) {
    return `<div class="card"><div class="card-title">The plan</div><div class="hint">Reading the goal…</div></div>`;
  }
  if (!plan) {
    return `<div class="card"><div class="card-title">The plan</div><div class="hint">Write a goal and Paperclip will show the company it would build — before you create anything.</div></div>`;
  }
  const sourceLabel =
    plan.source === "selected"
      ? "blueprint you picked"
      : plan.source === "model"
        ? "drafted by the strategist"
        : plan.source === "default"
          ? "generalist team"
          : "matched to your goal";
  const matched = (plan.match?.matched ?? []).slice(0, 4);
  return `
    <div class="card">
      <div class="row-between" style="align-items:flex-start;gap:10px">
        <div class="card-title" style="margin:0">The plan</div>
        <span class="pill accent">${esc(sourceLabel)}</span>
      </div>
      <div style="margin-top:10px">
        <div style="font-size:15px;font-weight:600;letter-spacing:-.015em">${esc(plan.blueprint.name)}</div>
        <div class="hint" style="margin-top:3px">${esc(plan.blueprint.category)} · ${esc(plan.blueprint.summary ?? "")}</div>
        ${
          matched.length
            ? `<div class="row" style="gap:5px;flex-wrap:wrap;margin-top:8px">${matched
                .map((term) => `<span class="tag">${esc(term)}</span>`)
                .join("")}</div>`
            : ""
        }
      </div>
      <div class="kv" style="margin-top:10px"><span class="k">Goal</span><span class="v">${esc(plan.goal.title)}</span></div>
      <div class="kv"><span class="k">Metric</span><span class="v">${esc(plan.goal.metric || "accepted deliverables")} → ${esc(String(plan.goal.target ?? 5))}${plan.goal.unit ? ` ${esc(plan.goal.unit)}` : ""}</span></div>
      <div class="kv"><span class="k">Team</span><span class="v">${plan.counts.agents} agents</span></div>
      <div class="kv"><span class="k">Backlog</span><span class="v">${plan.counts.issues} issues, each with a definition of done</span></div>
    </div>

    <div class="card">
      <div class="card-title">Who gets hired</div>
      <div class="stack" style="gap:8px">
        ${plan.agents
          .map(
            (agent) => `<div class="row" style="gap:9px;align-items:flex-start">
              <span class="avatar sm" style="background:var(--panel-3);color:var(--text-2)">${esc(
                agent.name
                  .split(/\s+/)
                  .map((word) => word[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase(),
              )}</span>
              <div style="min-width:0">
                <div style="font-size:12.5px;font-weight:600">${esc(agent.name)} <span class="dim" style="font-weight:400">· ${esc(agent.title)}</span></div>
                <div class="hint mono" style="font-size:10.5px">${esc(agent.model)}</div>
              </div>
            </div>`,
          )
          .join("")}
      </div>
    </div>

    <div class="card">
      <div class="card-title">The first board</div>
      <div class="stack" style="gap:7px">
        ${plan.issues
          .map(
            (issue) => `<div class="row" style="gap:8px;align-items:flex-start">
              <span class="tag" style="text-transform:uppercase">${esc(issue.priority)}</span>
              <div style="min-width:0">
                <div style="font-size:12.3px">${esc(issue.title)}</div>
                <div class="hint" style="font-size:10.8px">${issue.acceptance.length} acceptance checks</div>
              </div>
            </div>`,
          )
          .join("")}
      </div>
    </div>`;
}

function reportPanel(result) {
  const company = result.company;
  const cycle = result.launch?.cycle;
  const credentials = result.launch?.credentials ?? [];
  const steps = result.launch?.steps ?? [];
  return `
    <div class="card">
      <div class="row-between" style="gap:10px;align-items:flex-start">
        <div>
          <div class="pill green"><span class="dot"></span>company live</div>
          <div style="font-size:19px;font-weight:600;letter-spacing:-.02em;margin-top:8px">${esc(company.name)}</div>
          <div class="hint" style="margin-top:2px">${esc(company.goals?.[0]?.title ?? company.mission ?? "")}</div>
        </div>
        <div class="row" style="gap:6px">
          <button class="btn primary sm" data-action="open-dashboard">${icon("dashboard", "nav-icon")} Open dashboard</button>
        </div>
      </div>
      <div class="kpi-row" style="margin-top:14px">
        <div class="kpi"><b>${company.agents.length}</b><span class="hint">agents hired</span></div>
        <div class="kpi"><b>${company.issues.length}</b><span class="hint">issues on the board</span></div>
        <div class="kpi"><b>${company.goals?.length ?? 0}</b><span class="hint">goal tracked</span></div>
        <div class="kpi"><b>${cycle?.ran ?? 0}</b><span class="hint">ran in cycle one</span></div>
      </div>
      ${
        cycle
          ? `<div class="kv" style="margin-top:12px"><span class="k">First cycle</span><span class="v">${cycle.ok ? `${cycle.ran} ran · ${cycle.accepted} accepted · ${cycle.changesRequested} changes requested · ${cycle.blocked} blocked` : `skipped — ${esc(cycle.reason ?? "unknown")}`}</span></div>
             ${cycle.focus ? `<div class="kv"><span class="k">Focus</span><span class="v">${esc(cycle.focus)}</span></div>` : ""}
             ${cycle.standup ? `<div class="card" style="margin-top:10px;background:var(--panel-2)"><div class="card-title" style="margin:0 0 6px">Standup</div><div class="prose" style="font-size:12.4px">${md(cycle.standup.slice(0, 1200))}</div></div>` : ""}`
          : ""
      }
    </div>

    <div class="card">
      <div class="card-title">What happened</div>
      <div class="launch-steps">${steps.filter((step) => step.state !== "running").map(stepRow).join("")}</div>
      ${
        credentials.length
          ? `<div class="kv" style="margin-top:8px"><span class="k">Providers configured</span><span class="v">${credentials
              .map((entry) => `${esc(entry.name)}${entry.verified ? " ✓" : ""}`)
              .join(", ")}</span></div>`
          : ""
      }
      <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
        <a class="btn sm ghost" href="#/issues" data-action="open-board">${icon("issues", "nav-icon")} See the board</a>
        <a class="btn sm ghost" href="#/agents" data-action="open-agents">${icon("agents", "nav-icon")} Meet the team</a>
        <button class="btn sm ghost" data-action="again">${icon("plus", "nav-icon")} Launch another</button>
      </div>
    </div>`;
}

export async function render(root, ctx) {
  const blueprints = await api("/api/blueprints")
    .then((data) => data.blueprints ?? [])
    .catch(() => []);

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Full auto",
      title: "Build a company",
      subtitle:
        "Two answers: what it is called, and what it is for. Paperclip picks the NVIDIA blueprint that fits, hires the team, writes the backlog, configures any model key you paste, and runs the first cycle — no further setup.",
      actions: `<a class="btn ghost" href="#/blueprints">${icon("blueprints", "nav-icon")} Browse blueprints</a>`,
    })}

    <div class="launch-grid">
      <form class="stack" id="launch-form" style="gap:12px">
        <div class="card">
          <div class="card-title">1 · The company</div>
          <div class="field">
            <label for="launch-name">Company name</label>
            <input class="input" id="launch-name" name="name" maxlength="80" required placeholder="e.g. Northwind Support" autocomplete="off" />
          </div>
          <div class="field" style="margin-top:10px">
            <label for="launch-goal">Company goal</label>
            <textarea class="textarea" id="launch-goal" name="goal" rows="3" required placeholder="What should this company achieve, in one or two sentences? An agent has to be able to act on it."></textarea>
            <div class="hint">The goal becomes the tracked metric, the backlog and the planner's focus. Be concrete: “cut support response time to under 5 minutes”.</div>
          </div>
          <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:8px">
            ${EXAMPLES.map((example) => `<button type="button" class="chip" data-example="${escapeAttr(example)}">${esc(example.split(" ").slice(0, 4).join(" "))}…</button>`).join("")}
          </div>
        </div>

        <div class="card">
          <div class="card-title">2 · Model keys <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">— optional</span></div>
          <div class="field">
            <label for="launch-keys">Paste a key, or a whole Python/cURL snippet</label>
            <textarea class="textarea mono" id="launch-keys" name="keys" rows="4" placeholder="nvapi-...&#10;&#10;…or drop in the snippet from build.nvidia.com, OpenAI, Groq, OpenRouter, Together, Mistral, DeepSeek, Fireworks, Perplexity or Anthropic."></textarea>
            <div class="hint">
              One line per provider. Detection is automatic: the key never leaves this machine and is never sent back to the browser.
              Skip it and the company still runs — in simulation, ready to go live the moment a key is added.
            </div>
          </div>
          <div id="launch-key-hint" class="hint" aria-live="polite" style="margin-top:6px"></div>
        </div>

        <div class="card">
          <div class="card-title">3 · Launch options</div>
          <label class="check-row"><input type="checkbox" id="launch-cycle" checked /> <span>Run the first cycle immediately <span class="dim">— the strategist plans, the team works, quality reviews</span></span></label>
          <label class="check-row"><input type="checkbox" id="launch-auto" /> <span>Leave it autonomous <span class="dim">— a cycle on a schedule until the goal is met</span></span></label>
          <div class="field" style="margin-top:8px">
            <label for="launch-blueprint">Blueprint</label>
            <select class="select" id="launch-blueprint">
              <option value="">Auto — choose the closest fit for the goal</option>
              ${blueprints.map((blueprint) => `<option value="${esc(blueprint.id)}">${esc(blueprint.name)} — ${esc(blueprint.category)}</option>`).join("")}
            </select>
          </div>
        </div>

        <div class="card">
          <div class="row-between" style="gap:10px">
            <div class="hint" id="launch-status">Nothing is created until you press the button.</div>
            <button class="btn primary lg" type="submit" id="launch-submit">${icon("spark", "nav-icon")} Build my company</button>
          </div>
          <div class="launch-steps" id="launch-steps" hidden></div>
          <div class="hint" id="launch-error" style="color:var(--red-text)" hidden></div>
        </div>
      </form>

      <div class="stack" id="launch-preview" style="gap:12px"></div>
    </div>`;

  const form = root.querySelector("#launch-form");
  const nameEl = root.querySelector("#launch-name");
  const goalEl = root.querySelector("#launch-goal");
  const keysEl = root.querySelector("#launch-keys");
  const blueprintEl = root.querySelector("#launch-blueprint");
  const previewEl = root.querySelector("#launch-preview");
  const stepsEl = root.querySelector("#launch-steps");
  const statusEl = root.querySelector("#launch-status");
  const errorEl = root.querySelector("#launch-error");
  const submitEl = root.querySelector("#launch-submit");
  const keyHintEl = root.querySelector("#launch-key-hint");

  let plan = null;
  let launched = false;
  let built = false;

  const showPreview = () => {
    previewEl.innerHTML = previewPanel(plan);
  };
  showPreview();

  const refreshPreview = debounce(async () => {
    const goal = goalEl.value.trim();
    if (goal.length < 4) {
      plan = null;
      showPreview();
      return;
    }
    try {
      const data = await api("/api/launch/plan", {
        method: "POST",
        body: { name: nameEl.value.trim(), goal, blueprintId: blueprintEl.value || null },
      });
      plan = data.plan;
      showPreview();
    } catch (error) {
      previewEl.innerHTML = `<div class="card"><div class="card-title">The plan</div><div class="hint">${esc(error.message)}</div></div>`;
    }
  }, 320);

  const refreshKeyHint = debounce(async () => {
    const text = keysEl.value.trim();
    if (!text) {
      keyHintEl.innerHTML = "";
      return;
    }
    try {
      const first = text.split(/\n{2,}/)[0].trim();
      const data = await api("/api/providers/detect", { method: "POST", body: { text: first } });
      const detection = data.detection ?? {};
      keyHintEl.innerHTML = detection.hasKey
        ? `<span class="pill green"><span class="dot"></span>${esc(detection.detectedName ?? "provider")} detected</span> ${esc(detection.keyMasked ?? "")} ${detection.warnings?.length ? `· ${esc(detection.warnings[0])}` : ""}`
        : `<span class="pill amber"><span class="dot"></span>no key detected</span> ${esc(detection.warnings?.[0] ?? "")}`;
    } catch (error) {
      keyHintEl.textContent = error.message;
    }
  }, 380);

  nameEl.addEventListener("input", refreshPreview);
  goalEl.addEventListener("input", refreshPreview);
  blueprintEl.addEventListener("change", refreshPreview);
  keysEl.addEventListener("input", refreshKeyHint);

  root.querySelectorAll("[data-example]").forEach((node) => {
    node.addEventListener("click", () => {
      goalEl.value = node.dataset.example;
      goalEl.focus();
      refreshPreview();
    });
  });

  root.querySelectorAll("[data-action]").forEach((node) => {
    node.addEventListener("click", (event) => {
      const action = node.dataset.action;
      if (action === "again") {
        event.preventDefault();
        render(root, ctx);
      }
      if (action === "open-dashboard") {
        ctx.navigate("/dashboard");
      }
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (built) {
      // The launch is done: the same button is now the way into the company.
      ctx.navigate("/dashboard");
      return;
    }
    if (launched) return;
    const name = nameEl.value.trim();
    const goal = goalEl.value.trim();
    errorEl.hidden = true;
    if (!name) {
      nameEl.focus();
      errorEl.hidden = false;
      errorEl.textContent = "Give the company a name first.";
      return;
    }
    if (!goal) {
      goalEl.focus();
      errorEl.hidden = false;
      errorEl.textContent = "A goal is required — it is what the first cycle plans against.";
      return;
    }

    launched = true;
    submitEl.disabled = true;
    submitEl.innerHTML = `${icon("clock", "nav-icon")} Building…`;
    stepsEl.hidden = false;
    stepsEl.innerHTML = "";
    statusEl.textContent = "Working…";

    const seen = new Map();
    const paint = (step) => {
      const wrap = document.createElement("div");
      wrap.innerHTML = stepRow(step);
      const node = wrap.firstElementChild;
      const existing = seen.get(step.id);
      // A step is emitted twice (running → finished); keep its position.
      if (existing && existing.isConnected) existing.replaceWith(node);
      else stepsEl.append(node);
      seen.set(step.id, node);
    };

    const body = {
      name,
      goal,
      blueprintId: blueprintEl.value || null,
      keys: keysEl.value.trim() ? [keysEl.value.trim()] : [],
      runCycle: root.querySelector("#launch-cycle").checked,
      autoMode: root.querySelector("#launch-auto").checked,
    };

    try {
      let result = null;
      try {
        result = await stream("/api/launch?stream=1", body, {
          onEvent(type, payload) {
            if ((type === "step" || type === "progress") && payload) paint(payload);
          },
        });
      } catch (streamError) {
        // A proxy that buffers SSE would swallow the stream; POST once instead.
        result = await api("/api/launch", { method: "POST", body });
        (result.launch?.steps ?? []).forEach(paint);
      }
      if (!result?.company) throw new Error("The launch finished without a company.");

      const company = result.company;
      ctx.state.bootstrap = await api("/api/bootstrap");
      ctx.state.companyId = company.id;
      ctx.state.company = company;
      const nameNode = document.querySelector("#company-name");
      if (nameNode) nameNode.textContent = company.name;
      document.title = `${company.name} · Paperclip × NIM`;
      // Redraw the chrome (company name, roster, spend) for the new company.
      await ctx.refresh(true).catch(() => {});
      statusEl.textContent = `${company.name} is live.`;
      built = true;
      submitEl.disabled = false;
      submitEl.className = "btn primary lg";
      submitEl.innerHTML = `${icon("dashboard", "nav-icon")} Open ${company.name}`;
      toast(`${company.name} is live — ${company.agents.length} agents hired`);

      previewEl.innerHTML = reportPanel(result);
      previewEl.scrollIntoView({ behavior: "smooth", block: "start" });
      previewEl.querySelector('[data-action="again"]')?.addEventListener("click", () => render(root, ctx));
      previewEl.querySelector('[data-action="open-dashboard"]')?.addEventListener("click", async () => {
        await ctx.refresh(true).catch(() => {});
        ctx.navigate("/dashboard");
      });
    } catch (error) {
      launched = false;
      submitEl.disabled = false;
      submitEl.className = "btn primary lg";
      submitEl.innerHTML = `${icon("spark", "nav-icon")} Build my company`;
      statusEl.textContent = "Nothing was created.";
      errorEl.hidden = false;
      errorEl.textContent = error.message;
      toast(`Launch failed: ${error.message}`, "error");
    }
  });

  if (!nameEl.value && ctx.state.company) {
    // A returning user launching a second company: do not prefill, just focus.
    nameEl.focus();
  } else {
    nameEl.focus();
  }

  const onKey = (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) form.requestSubmit();
  };
  root.addEventListener("keydown", onKey);
  return () => root.removeEventListener("keydown", onKey);
}
