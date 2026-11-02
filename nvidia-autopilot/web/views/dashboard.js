import { api, esc, fmt, reportError, statusBadge, toast } from "../lib.js";

const EXAMPLES = [
  "Launch a self-serve onboarding motion and grow activated accounts 20% this quarter",
  "Cut support resolution time in half without adding headcount",
  "Ship a pricing page experiment and decide the winner within two weeks",
];

const CAPABILITIES = [
  { title: "Chat & reasoning", body: "Every hosted NIM chat model, streaming, with reasoning traces.", href: "#/chat", glyph: "◍" },
  { title: "Tool calling", body: "Agents call retrieval, calculation, artifacts, guardrails and image tools.", href: "#/autopilot", glyph: "⚒" },
  { title: "Embeddings + rerank", body: "NeMo Retriever embed/rerank pipeline over your company documents.", href: "#/knowledge", glyph: "▤" },
  { title: "Guardrails", body: "Safety, jailbreak and PII models screen inputs and every shipped output.", href: "#/guardrails", glyph: "⛨" },
  { title: "Vision", body: "Send images to vision-language models from the chat lab.", href: "#/chat", glyph: "◉" },
  { title: "Image generation", body: "Stable Diffusion / FLUX hosted endpoints, saved as run artifacts.", href: "#/studio", glyph: "❖" },
];

export async function render(el, ctx) {
  const status = await api.get("/api/status").catch((error) => {
    reportError(error);
    return null;
  });
  const runs = await api.get("/api/autopilot").catch(() => ({ runs: [] }));
  const roles = status?.roles ?? {};
  const knowledge = status?.knowledge ?? { documents: 0, chunks: 0 };
  const recent = (runs.runs ?? []).slice(0, 5);
  const active = (runs.runs ?? []).filter((run) => ["executing", "planning", "reporting", "awaiting_approval", "paused"].includes(run.status));

  el.innerHTML = `
    <section class="hero">
      <span class="hero-kicker"><span class="status-dot" style="background:var(--green-400)"></span> NVIDIA NIM · full stack</span>
      <h1>Give one company goal. The team plans, executes and reports.</h1>
      <p>
        Autopilot staffs your goal with NIM-powered agents — strategist, analyst, operator, critic,
        safety and scribe — retrieves your company knowledge, checks its own work against guardrails,
        saves every deliverable, and stops for a human only when the policy says it must.
      </p>
      <form id="goal-form" class="stack" style="margin-top:var(--space-5);max-width:840px">
        <div class="field-row">
          <div class="field">
            <label for="company">Company</label>
            <input id="company" name="company" placeholder="Northwind Labs" autocomplete="organization" />
          </div>
          <div class="field">
            <label for="maxSteps">Work items</label>
            <select id="maxSteps" name="maxSteps">
              <option value="3">3 — focused</option>
              <option value="5" selected>5 — balanced</option>
              <option value="8">8 — thorough</option>
            </select>
          </div>
          <div class="field">
            <label for="approval">Human approval</label>
            <select id="approval" name="approval">
              <option value="high" selected>High-risk only</option>
              <option value="all">Every work item</option>
              <option value="never">Fully hands-off</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label for="goal">Company goal</label>
          <textarea id="goal" name="goal" rows="3" placeholder="e.g. Launch a self-serve onboarding motion and grow activated accounts by 20% this quarter."
            required minlength="8"></textarea>
        </div>
        <div class="field">
          <label for="companyContext">Operating context <span class="faint">(optional — constraints, budget, positioning, anything the team must respect)</span></label>
          <textarea id="companyContext" rows="2" placeholder="e.g. B2B SaaS, $49/seat, no paid acquisition this quarter, engineering has 2 weeks."></textarea>
        </div>
        <div class="row-wrap">
          <button class="btn btn-primary btn-lg" type="submit" id="launch">Launch autopilot →</button>
          ${status?.config?.simulation ? `<span class="badge badge-amber">simulation mode — connect a key for real inference</span>` : `<span class="badge badge-green">live NIM inference</span>`}
          <span class="pill">${esc(knowledge.documents ?? 0)} docs indexed</span>
        </div>
      </form>
      <div class="chips" style="margin-top:var(--space-4)">
        ${EXAMPLES.map((example) => `<button class="chip" data-example="${esc(example)}">${esc(example)}</button>`).join("")}
      </div>
    </section>

    <div class="grid grid-4" style="margin-top:var(--space-4)">
      ${statCard("Inference", status?.config?.simulation ? "Simulation" : "Live NIM", status?.config?.simulation ? "no key configured" : `key ${status?.config?.keyHint ?? ""}`)}
      ${statCard("Models online", status?.modelCount ?? "—", status?.modelsDegraded ? "cached preset catalog" : "from build.nvidia.com")}
      ${statCard("Active runs", active.length, `${runs.runs?.length ?? 0} total`)}
      ${statCard("Knowledge", `${knowledge.chunks ?? 0}`, `${knowledge.documents ?? 0} documents · ${knowledge.pending ?? 0} pending`)}
    </div>

    <div class="card" style="margin-top:var(--space-4)">
      <div class="card-head">
        <span class="card-title">Company OS</span>
        <a class="small" href="#/companies">Build a company →</a>
      </div>
      <p class="small muted">
        Autopilot delivers one goal. <strong>Company OS</strong> runs the whole organization: departments,
        <a href="#/companies">agents with budgets and reporting lines</a>, Paperclip-style goals and a board of issues,
        an executive cycle that plans, executes and reviews, and a Paperclip bridge that mirrors the company into a live
        Paperclip instance.
      </p>
      <div class="row-wrap" style="margin-top:var(--space-3)">
        <span class="pill">${status?.companies?.total ?? 0} companies</span>
        <span class="pill">${status?.companies?.agents ?? 0} agents</span>
        <span class="pill">${status?.companies?.openIssues ?? 0} open issues</span>
        <span class="pill">${status?.companies?.autoMode ?? 0} running auto mode</span>
        <a class="btn btn-sm btn-primary" href="#/companies">Open Company OS</a>
      </div>
    </div>

    <div class="split" style="margin-top:var(--space-4)">
      <div class="card">
        <div class="card-head">
          <span class="card-title">Recent runs</span>
          <a class="small" href="#/autopilot">All runs →</a>
        </div>
        ${
          recent.length
            ? `<div class="table-wrap"><table><thead><tr><th>Goal</th><th>Status</th><th>Tasks</th><th class="num">Tokens</th><th class="num">Started</th></tr></thead><tbody>
                ${recent
                  .map(
                    (run) => `<tr data-run="${esc(run.id)}" style="cursor:pointer">
                      <td>${esc(run.goal).slice(0, 80)}${run.goal.length > 80 ? "…" : ""}<div class="tiny faint">${esc(run.company ?? "—")}</div></td>
                      <td>${statusBadge(run.status)}</td>
                      <td class="mono">${run.completedTasks}/${run.taskCount}</td>
                      <td class="num">${fmt.tokens(run.usage?.totalTokens)}</td>
                      <td class="num faint">${fmt.ago(run.createdAt)}</td>
                    </tr>`,
                  )
                  .join("")}
              </tbody></table></div>`
            : `<div class="empty"><h3>No runs yet</h3><p>Give the autopilot a goal above and it will plan, execute and report on its own.</p></div>`
        }
      </div>

      <div class="side-stack">
        <div class="card">
          <div class="card-head"><span class="card-title">Agent routing</span><a class="small" href="#/models">Edit →</a></div>
          <dl class="kv">
            ${Object.entries(roles)
              .map(([role, entry]) => `<dt>${esc(entry.label)}</dt><dd class="mono tiny">${esc(entry.model.split("/").pop())}</dd>`)
              .join("")}
          </dl>
        </div>
        <div class="card">
          <div class="card-head"><span class="card-title">Run policy</span></div>
          <p class="small muted">
            Default ceilings: 250k tokens, 20 minutes, 2 concurrent work items, guardrails on every output.
            Raise them per run or in <a href="#/settings">settings</a>.
          </p>
        </div>
      </div>
    </div>

    <div class="grid grid-3" style="margin-top:var(--space-4)">
      ${CAPABILITIES.map(
        (capability) => `
        <a class="card" href="${capability.href}" style="color:inherit">
          <div class="row" style="justify-content:space-between"><span style="font-size:20px;color:var(--green-400)">${capability.glyph}</span><span class="tiny faint">NIM</span></div>
          <h3 style="margin-top:10px">${esc(capability.title)}</h3>
          <p class="small muted" style="margin-top:4px">${esc(capability.body)}</p>
        </a>`,
      ).join("")}
    </div>
  `;

  const form = el.querySelector("#goal-form");
  el.querySelectorAll("[data-example]").forEach((chip) => {
    chip.addEventListener("click", () => {
      el.querySelector("#goal").value = chip.dataset.example;
      el.querySelector("#goal").focus();
    });
  });
  el.querySelectorAll("[data-run]").forEach((row) => {
    row.addEventListener("click", () => ctx.navigate(`/autopilot/${row.dataset.run}`));
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const launch = el.querySelector("#launch");
    const payload = {
      goal: form.goal.value.trim(),
      company: form.company.value.trim(),
      companyContext: form.companyContext.value.trim(),
      options: {
        maxSteps: Number(form.maxSteps.value),
        requireApproval: form.approval.value,
      },
    };
    if (payload.goal.length < 8) return toast("Describe the goal in a sentence or two.", "warn");
    launch.disabled = true;
    launch.innerHTML = `<span class="spinner"></span> launching`;
    try {
      const { run } = await api.post("/api/autopilot", payload);
      toast("Autopilot launched");
      ctx.navigate(`/autopilot/${run.id}`);
    } catch (error) {
      reportError(error);
      launch.disabled = false;
      launch.textContent = "Launch autopilot →";
    }
  });
}

function statCard(label, value, hint) {
  return `<div class="stat"><span class="stat-label">${esc(label)}</span><span class="stat-value">${esc(value)}</span><span class="stat-hint">${esc(hint)}</span></div>`;
}

