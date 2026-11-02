import { api, esc, fmt, md, reportError, statusBadge, toast } from "../lib.js";

/**
 * Company OS: the Paperclip operating model (company → agents → goals → issues →
 * budgets → approvals → activity) running on NVIDIA NIM.
 */

const ROLES = ["ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general"];
const PRIORITIES = ["critical", "high", "medium", "low"];
const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "cancelled"];
const INTERVALS = [
  { value: 0.05, label: "every 3 seconds (demo)" },
  { value: 1, label: "every minute" },
  { value: 5, label: "every 5 minutes" },
  { value: 15, label: "every 15 minutes" },
  { value: 60, label: "every hour" },
];

const money = (cents) => `$${((Number(cents) || 0) / 100).toFixed(2)}`;
const tokensOf = (company) =>
  company.ledger.reduce((sum, entry) => sum + (entry.promptTokens ?? 0) + (entry.completionTokens ?? 0), 0);

export async function render(el, ctx, params) {
  const companyId = params?.[0];
  if (companyId) return renderCompany(el, ctx, companyId);
  return renderList(el, ctx);
}

/* ---------------------------------- list ---------------------------------- */

async function renderList(el, ctx) {
  const { companies } = await api.get("/api/companies");
  const live = companies.filter((company) => company.status === "active");
  const totalAgents = companies.reduce((sum, company) => sum + company.counts.agents, 0);
  const totalDone = companies.reduce((sum, company) => sum + company.counts.done, 0);
  const totalSpend = companies.reduce((sum, company) => sum + company.counts.spentCents, 0);

  el.innerHTML = `
    <section class="hero">
      <span class="hero-kicker"><span class="status-dot" style="background:var(--green-400)"></span> Company OS · Paperclip model · NVIDIA NIM</span>
      <h1>Describe the company. It gets staffed, funded and run.</h1>
      <p>
        One goal becomes an organization: departments, agents with titles and budgets, company and team goals with KPIs,
        a prioritised board of issues, and an executive loop that plans, executes, reviews and books every token.
        The vocabulary is Paperclip's, the inference is NVIDIA NIM, and the same company can be mirrored into a real
        Paperclip instance so its agents pick up the work.
      </p>
      <form id="build-form" class="stack" style="margin-top:var(--space-5);max-width:900px">
        <div class="field-row">
          <div class="field">
            <label for="name">Company name</label>
            <input id="name" name="name" placeholder="Northwind Labs" autocomplete="organization" />
          </div>
          <div class="field">
            <label for="budget">Monthly budget (USD)</label>
            <input id="budget" name="budget" type="number" min="0" step="10" value="50" />
          </div>
          <div class="field">
            <label for="size">Team size</label>
            <select id="size" name="size">
              <option value="4">4 — lean</option>
              <option value="6" selected>6 — standard</option>
              <option value="8">8 — full</option>
            </select>
          </div>
          <div class="field">
            <label for="approval">Approval policy</label>
            <select id="approval" name="approval">
              <option value="high" selected>Board approval for risky work</option>
              <option value="all">Board approval for every issue</option>
              <option value="never">Fully autonomous</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label for="goal">Company goal</label>
          <textarea id="goal" name="goal" rows="3" required minlength="8"
            placeholder="e.g. Reach $20k MRR in 90 days by launching a self-serve onboarding flow, without adding headcount."></textarea>
        </div>
        <div class="field">
          <label for="constraints">Constraints <span class="faint">(budget, positioning, legal limits, what the team must respect)</span></label>
          <textarea id="constraints" rows="2" placeholder="e.g. B2B SaaS at $49/seat, 2 engineers, no paid ads, anything public needs approval."></textarea>
        </div>
        <div class="row-wrap">
          <button class="btn btn-primary btn-lg" type="submit" id="build">Build company →</button>
          <span class="pill">${live.length} active</span>
          <span class="pill">${totalAgents} agents</span>
          <span class="pill">${fmt.tokens(totalDone)} completed issues</span>
          <span class="pill">${money(totalSpend)} burned</span>
        </div>
      </form>
    </section>

    <div class="card" style="margin-top:var(--space-4)">
      <div class="card-head"><span class="card-title">Your companies</span><span class="badge badge-dim">${companies.length}</span></div>
      ${
        companies.length
          ? `<div class="table-wrap"><table>
              <thead><tr><th>Company</th><th>Status</th><th>People</th><th class="num">Open</th><th class="num">Done</th><th class="num">Budget</th><th>Auto</th><th></th></tr></thead>
              <tbody>
                ${companies
                  .map((company) => {
                    const pct = company.counts.budgetMonthlyCents
                      ? Math.min(100, Math.round((company.counts.spentCents / company.counts.budgetMonthlyCents) * 100))
                      : 0;
                    return `<tr>
                      <td><a href="#/companies/${esc(company.id)}"><strong>${esc(company.name)}</strong></a>
                        <div class="tiny faint">${esc(company.issuePrefix)} · ${esc((company.mission ?? "").slice(0, 90))}${(company.mission ?? "").length > 90 ? "…" : ""}</div></td>
                      <td>${statusBadge(company.status)}</td>
                      <td class="mono">${company.counts.agents}</td>
                      <td class="num">${company.counts.open}</td>
                      <td class="num">${company.counts.done}</td>
                      <td class="num"><div class="tiny">${money(company.counts.spentCents)} / ${money(company.counts.budgetMonthlyCents)}</div>
                        <div class="progress" style="width:90px"><span style="width:${pct}%"></span></div></td>
                      <td>${company.autoMode?.enabled ? '<span class="badge badge-green">on</span>' : '<span class="badge badge-dim">off</span>'}</td>
                      <td><a class="btn btn-sm btn-ghost" href="#/companies/${esc(company.id)}">Open</a></td>
                    </tr>`;
                  })
                  .join("")}
              </tbody></table></div>`
          : `<div class="empty"><h3>No companies yet</h3><p>Give one goal above. The strategist model designs the org, and the board is ready before you finish reading this line.</p></div>`
      }
    </div>

    <div class="grid grid-3" style="margin-top:var(--space-4)">
      ${[
        { t: "Hire and fire", b: "Any NVIDIA NIM model per role, monthly budgets per person, reporting lines and departments." },
        { t: "Board of issues", b: "Prioritised backlog with acceptance criteria, comments, approvals and deliverable artifacts." },
        { t: "Executive loop", b: "A cycle = plan → work → review → standup, with rework limits and a cost ledger per token." },
      ]
        .map(
          (card) => `<div class="card"><h3>${esc(card.t)}</h3><p class="small muted" style="margin-top:6px">${esc(card.b)}</p></div>`,
        )
        .join("")}
    </div>
  `;

  el.querySelector("#build-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = el.querySelector("#build");
    const goal = form.goal.value.trim();
    if (goal.length < 8) return toast("Describe the company goal in a sentence or two.", "warn");
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> designing the org`;
    try {
      const result = await api.post("/api/companies", {
        name: form.name.value.trim(),
        goal,
        constraints: form.constraints.value.trim(),
        size: Number(form.size.value),
        budgetMonthlyCents: Math.round(Number(form.budget.value || 0) * 100),
        settings: { approvalPolicy: form.approval.value },
      });
      toast(`${result.company.name} is staffed — ${result.company.agents.length} agents hired`);
      ctx.navigate(`/companies/${result.company.id}`);
    } catch (error) {
      reportError(error);
      button.disabled = false;
      button.textContent = "Build company →";
    }
  });
}

/* --------------------------------- detail --------------------------------- */

async function renderCompany(el, ctx, companyId) {
  let detail;
  try {
    detail = await api.get(`/api/companies/${companyId}`);
  } catch (error) {
    reportError(error);
    el.innerHTML = `<div class="empty"><h3>Company not found</h3><p>${esc(error.message)}</p><a class="btn" href="#/companies">All companies</a></div>`;
    return;
  }

  let company = detail.company;
  let artifacts = detail.artifacts;
  let tab = new URLSearchParams(location.hash.split("?")[1] ?? "").get("tab") ?? "overview";
  let busy = null;
  let closed = false;
  let source = null;

  el.innerHTML = `
    <div class="spread" style="margin-bottom:var(--space-3)">
      <a class="small" href="#/companies">← All companies</a>
      <div class="row-wrap">
        <a class="btn btn-sm btn-ghost" id="export" href="/api/companies/${esc(companyId)}/export">Export bundle</a>
        <button class="btn btn-sm btn-ghost" id="refresh">Refresh</button>
      </div>
    </div>
    <div id="tabs" class="chips" style="margin-bottom:var(--space-3)"></div>
    <div id="body"></div>
  `;

  const tabsEl = el.querySelector("#tabs");
  const bodyEl = el.querySelector("#body");

  const TABS = [
    ["overview", "Overview"],
    ["org", "Organization"],
    ["board", "Board"],
    ["finance", "Finance"],
    ["autopilot", "Autopilot"],
    ["settings", "Settings"],
  ];

  function paintTabs() {
    const pending = company.approvals.filter((approval) => approval.status === "pending").length;
    tabsEl.innerHTML = TABS.map(
      ([key, label]) =>
        `<button class="chip ${key === tab ? "active" : ""}" data-tab="${key}">${esc(label)}${
          key === "overview" && pending ? ` <span class="badge badge-amber">${pending}</span>` : ""
        }</button>`,
    ).join("");
    tabsEl.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        tab = button.dataset.tab;
        paintTabs();
        paintBody();
      });
    });
  }

  function header() {
    const summary = detail.summary ?? {};
    const pct = company.budgetMonthlyCents
      ? Math.min(100, Math.round((company.spentCents / company.budgetMonthlyCents) * 100))
      : 0;
    const auto = company.autoMode ?? {};
    return `
      <section class="card" style="border-color:var(--line-strong)">
        <div class="spread row-wrap" style="align-items:flex-start">
          <div style="flex:1;min-width:280px">
            <div class="row-wrap" style="margin-bottom:8px">
              ${statusBadge(company.status)}
              <span class="pill">${esc(company.issuePrefix)}</span>
              <span class="pill">${esc(company.orgSource === "model" ? "org from NIM" : "org from blueprint")}</span>
              ${auto.enabled ? `<span class="badge badge-green"><span class="status-dot pulse"></span>auto mode · ${esc(String(auto.everyMinutes))}min</span>` : `<span class="badge badge-dim">auto off</span>`}
              ${summary.pendingApprovals ? `<span class="badge badge-amber">${summary.pendingApprovals} approval${summary.pendingApprovals > 1 ? "s" : ""} waiting</span>` : ""}
              ${company.paperclip ? `<span class="badge badge-violet">mirrored → Paperclip</span>` : ""}
            </div>
            <h1 style="font-size:26px">${esc(company.name)}</h1>
            <p class="muted small" style="margin-top:6px;max-width:70ch">${esc(company.mission)}</p>
          </div>
          <div class="row-wrap">
            <button class="btn btn-primary btn-sm" id="run-cycle" ${busy ? "disabled" : ""}>
              ${busy === "cycle" ? '<span class="spinner"></span> running' : "Run cycle"}
            </button>
            <button class="btn btn-sm" id="toggle-auto">${auto.enabled ? "Stop auto mode" : "Start auto mode"}</button>
          </div>
        </div>
        <div class="grid grid-4" style="margin-top:var(--space-4)">
          ${statCard("People", summary.agents, "across " + summary.departments + " departments")}
          ${statCard("Board", `${summary.done}/${summary.issues}`, summary.open + " open · " + summary.blocked + " blocked")}
          ${statCard("Spend", money(company.spentCents), "of " + money(company.budgetMonthlyCents) + " / month")}
          ${statCard("Tokens", fmt.tokens(tokensOf(company)), summary.cycles + " cycles run")}
        </div>
        <div style="margin-top:var(--space-3)">
          <div class="spread tiny faint" style="margin-bottom:6px">
            <span>Budget used ${pct}%</span>
            <span class="mono">${money(company.spentCents)} / ${money(company.budgetMonthlyCents)}</span>
          </div>
          <div class="progress"><span style="width:${pct}%"></span></div>
        </div>
      </section>`;
  }

  function paintBody() {
    bodyEl.innerHTML = header() + `<div style="margin-top:var(--space-4)">${renderTab()}</div>`;
    bindCommon();
  }

  function renderTab() {
    switch (tab) {
      case "org":
        return renderOrg();
      case "board":
        return renderBoard();
      case "finance":
        return renderFinance();
      case "autopilot":
        return renderAutopilot();
      case "settings":
        return renderSettings();
      default:
        return renderOverview();
    }
  }

  function pendingApprovals() {
    const pending = company.approvals.filter((approval) => approval.status === "pending");
    if (!pending.length) return "";
    return `
      <div class="card" style="border-color:rgba(251,191,36,.45)">
        <div class="card-head"><span class="card-title">Board decisions waiting</span><span class="badge badge-amber">${pending.length}</span></div>
        <div class="stack">
          ${pending
            .map((approval) => {
              const issue = company.issues.find((entry) => entry.id === approval.issueId);
              const agent = company.agents.find((entry) => entry.id === approval.requestedByAgentId);
              return `<div class="task" style="border-color:rgba(251,191,36,.3)">
                <div class="task-head">
                  <div style="flex:1">
                    <div class="task-title">${esc(approval.title)}</div>
                    <div class="task-meta">
                      <span class="badge badge-dim">${esc(approval.kind)}</span>
                      ${issue ? `<span class="pill">${esc(issue.key)}</span>` : ""}
                      ${agent ? `<span class="pill">${esc(agent.name)}</span>` : ""}
                      ${approval.amountCents ? `<span class="pill">${money(approval.amountCents)}</span>` : ""}
                    </div>
                    ${approval.detail ? `<div class="small faint" style="margin-top:6px">${esc(approval.detail)}</div>` : ""}
                  </div>
                  <div class="row">
                    <button class="btn btn-primary btn-sm" data-approve="${esc(approval.id)}">Approve</button>
                    <button class="btn btn-danger btn-sm" data-reject="${esc(approval.id)}">Reject</button>
                  </div>
                </div>
              </div>`;
            })
            .join("")}
        </div>
      </div>`;
  }

  function renderOverview() {
    const latest = [...company.cycles].reverse()[0];
    const goalList = company.goals
      .map(
        (goal) => `<div class="card flat tight">
          <div class="spread" style="margin-bottom:6px">
            <strong>${esc(goal.title)}</strong>
            <span class="badge ${goal.status === "achieved" ? "badge-green" : goal.status === "active" ? "badge-blue" : "badge-dim"}">${esc(goal.level)} · ${esc(goal.status)}</span>
          </div>
          ${goal.description ? `<p class="small muted">${esc(goal.description.slice(0, 260))}</p>` : ""}
          ${
            goal.kpis.length
              ? `<div class="table-wrap"><table><thead><tr><th>KPI</th><th>Current</th><th>Target</th><th>Measured by</th></tr></thead><tbody>
                  ${goal.kpis
                    .map(
                      (kpi) =>
                        `<tr><td>${esc(kpi.name)}</td><td class="mono">${esc(kpi.current)}</td><td class="mono">${esc(kpi.target)}</td><td class="small faint">${esc(kpi.measure)}</td></tr>`,
                    )
                    .join("")}
                </tbody></table></div>`
              : '<p class="tiny faint">No KPIs recorded.</p>'
          }
        </div>`,
      )
      .join("");

    return `
      <div class="split">
        <div class="stack">
          ${pendingApprovals()}
          <div class="card">
            <div class="card-head"><span class="card-title">Latest standup</span>${latest ? `<span class="badge badge-dim">cycle ${latest.index} · ${esc(latest.status)}</span>` : ""}</div>
            ${
              latest?.summary
                ? `<div class="md">${md(latest.summary)}</div>`
                : `<p class="small faint">No cycles yet. Press <strong>Run cycle</strong> and the CEO will plan, employees will work, quality will review.</p>`
            }
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Goals</span><span class="badge badge-dim">${company.goals.length}</span></div>
            <div class="stack">${goalList || '<p class="small faint">No goals recorded.</p>'}</div>
          </div>
        </div>
        <div class="side-stack">
          <div class="card">
            <div class="card-head"><span class="card-title">Departments</span></div>
            <div class="stack">
              ${company.departments
                .map((department) => {
                  const people = company.agents.filter((agent) => agent.departmentId === department.id);
                  return `<div>
                    <div class="spread"><strong class="small">${esc(department.name)}</strong><span class="tiny faint mono">${people.length}</span></div>
                    <div class="tiny faint">${esc(department.mission || "—")}</div>
                  </div>`;
                })
                .join("") || '<p class="small faint">No departments.</p>'}
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Recent activity</span></div>
            <div class="timeline">
              ${(detail.events ?? [])
                .slice(-14)
                .reverse()
                .map(
                  (event) => `<div class="tl-row ${toneFor(event.type)}">
                    <span class="tl-time">${fmt.time(event.at)}</span>
                    <span class="tl-marker"><span class="tl-dot"></span></span>
                    <span class="tl-body">${esc(event.message ?? event.type)}</span>
                  </div>`,
                )
                .join("")}
            </div>
          </div>
        </div>
      </div>`;
  }

  function orgTree() {
    const byManager = new Map();
    for (const agent of company.agents) {
      const key = agent.reportsTo ?? "root";
      if (!byManager.has(key)) byManager.set(key, []);
      byManager.get(key).push(agent);
    }
    const roots = [...company.agents.filter((agent) => !agent.reportsTo || !company.agents.some((entry) => entry.id === agent.reportsTo))];
    const rows = [];
    const walk = (agent, depth) => {
      rows.push({ agent, depth });
      for (const child of byManager.get(agent.id) ?? []) walk(child, depth + 1);
    };
    roots.forEach((root) => walk(root, 0));
    return { rows, byManager };
  }

  function renderOrg() {
    const { rows } = orgTree();
    return `
      <div class="split">
        <div class="stack">
          <div class="card">
            <div class="card-head"><span class="card-title">Reporting line</span><span class="badge badge-dim">${company.agents.length}</span></div>
            <div class="stack">
              ${rows
                .map(
                  ({ agent, depth }) => `<div style="margin-left:${depth * 18}px">
                    <div class="spread row-wrap" style="align-items:flex-start">
                      <div>
                        <div class="row-wrap">
                          <strong>${esc(agent.name)}</strong>
                          <span class="pill">${esc(agent.role)}</span>
                          <span class="badge ${agent.status === "active" ? "badge-green" : agent.status === "over_budget" ? "badge-red" : "badge-dim"}">${esc(agent.status)}</span>
                        </div>
                        <div class="tiny faint">${esc(agent.title)} · ${esc(company.departments.find((department) => department.id === agent.departmentId)?.name ?? "no department")}</div>
                        <div class="tiny mono faint">${esc(agent.model ?? "no model")}</div>
                      </div>
                      <div style="min-width:170px">
                        <div class="tiny faint mono" style="text-align:right">${money(agent.spentCents)} / ${money(agent.budgetMonthlyCents)}</div>
                        <div class="progress"><span style="width:${agent.budgetMonthlyCents ? Math.min(100, Math.round((agent.spentCents / agent.budgetMonthlyCents) * 100)) : 0}%"></span></div>
                      </div>
                    </div>
                  </div>`,
                )
                .join("")}
            </div>
          </div>

          <div class="card">
            <div class="card-head"><span class="card-title">Hire someone</span></div>
            <div class="field-row">
              <div class="field"><label for="hire-name">Name</label><input id="hire-name" placeholder="Rowan Vale" /></div>
              <div class="field"><label for="hire-role">Role</label><select id="hire-role">${ROLES.map((role) => `<option value="${role}">${role}</option>`).join("")}</select></div>
              <div class="field"><label for="hire-title">Title</label><input id="hire-title" placeholder="Head of Support" /></div>
              <div class="field"><label for="hire-budget">Budget (USD)</label><input id="hire-budget" type="number" min="0" step="1" value="5" /></div>
            </div>
            <div class="field" style="margin-top:var(--space-3)">
              <label for="hire-model">Model</label>
              <select id="hire-model">${modelOptions()}</select>
            </div>
            <button class="btn btn-primary" id="hire" style="margin-top:var(--space-3)">Hire</button>
          </div>
        </div>

        <div class="side-stack">
          <div class="card">
            <div class="card-head"><span class="card-title">Agent detail</span></div>
            <div class="field">
              <label for="agent-pick">Person</label>
              <select id="agent-pick">${company.agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name)} — ${esc(agent.title)}</option>`).join("")}</select>
            </div>
            <div id="agent-editor" style="margin-top:var(--space-3)"></div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Skills & capabilities</span></div>
            <div class="stack">
              ${company.agents
                .map(
                  (agent) => `<div>
                    <div class="small"><strong>${esc(agent.name)}</strong></div>
                    <div class="chips">${[...(agent.capabilities ?? []), ...(agent.skills ?? [])]
                      .map((item) => `<span class="chip">${esc(item)}</span>`)
                      .join("") || '<span class="tiny faint">none recorded</span>'}</div>
                  </div>`,
                )
                .join("")}
            </div>
          </div>
        </div>
      </div>`;
  }

  function modelOptions(selected) {
    const models = ctx.state?.models?.models ?? [];
    const options = models.length
      ? models.filter((model) => (model.capabilities ?? []).includes("chat") || (model.capabilities ?? []).includes("reasoning"))
      : [];
    const list = options.length ? options : [{ id: "" }];
    return list
      .map((model) => `<option value="${esc(model.id)}" ${model.id === selected ? "selected" : ""}>${esc(model.id || "use role default")}</option>`)
      .join("");
  }

  function paintAgentEditor(agentId) {
    const host = el.querySelector("#agent-editor");
    const agent = company.agents.find((entry) => entry.id === agentId);
    if (!host || !agent) return;
    host.innerHTML = `
      <div class="field"><label>Name</label><input id="edit-name" value="${esc(agent.name)}" /></div>
      <div class="field" style="margin-top:8px"><label>Title</label><input id="edit-title" value="${esc(agent.title)}" /></div>
      <div class="field" style="margin-top:8px"><label>Model</label><select id="edit-model">${modelOptions(agent.model)}</select></div>
      <div class="field" style="margin-top:8px"><label>Monthly budget (USD)</label><input id="edit-budget" type="number" min="0" step="1" value="${(agent.budgetMonthlyCents / 100).toFixed(2)}" /></div>
      <div class="field" style="margin-top:8px"><label>Status</label>
        <select id="edit-status">${["active", "paused"].map((status) => `<option value="${status}" ${agent.status === status ? "selected" : ""}>${status}</option>`).join("")}</select>
      </div>
      <div class="field" style="margin-top:8px"><label>How they work</label><textarea id="edit-instructions" rows="3">${esc(agent.instructions ?? "")}</textarea></div>
      <div class="row-wrap" style="margin-top:var(--space-3)">
        <button class="btn btn-primary btn-sm" id="save-agent">Save</button>
        ${agent.role === "ceo" ? "" : `<button class="btn btn-danger btn-sm" id="fire-agent">Let go</button>`}
      </div>`;

    host.querySelector("#save-agent").addEventListener("click", async () => {
      try {
        await api.patch(`/api/companies/${companyId}/agents/${agent.id}`, {
          name: host.querySelector("#edit-name").value.trim(),
          title: host.querySelector("#edit-title").value.trim(),
          model: host.querySelector("#edit-model").value || null,
          budgetMonthlyCents: Math.round(Number(host.querySelector("#edit-budget").value || 0) * 100),
          status: host.querySelector("#edit-status").value,
          instructions: host.querySelector("#edit-instructions").value,
        });
        toast(`${agent.name} updated`);
        await load();
      } catch (error) {
        reportError(error);
      }
    });
    host.querySelector("#fire-agent")?.addEventListener("click", async () => {
      if (!confirm(`Remove ${agent.name} from the company?`)) return;
      try {
        await api.del(`/api/companies/${companyId}/agents/${agent.id}`);
        toast(`${agent.name} left the company`);
        await load();
      } catch (error) {
        reportError(error);
      }
    });
  }

  function renderBoard() {
    const issues = [...company.issues].sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2, low: 3 };
      return rank[a.priority] - rank[b.priority] || String(b.createdAt).localeCompare(String(a.createdAt));
    });
    return `
      <div class="split">
        <div class="stack">
          <div class="card">
            <div class="card-head"><span class="card-title">Board</span><span class="badge badge-dim">${issues.length} issues</span></div>
            <div class="stack">
              ${
                issues.length
                  ? issues.map((issue) => renderIssue(issue)).join("")
                  : `<div class="empty"><h3>Empty board</h3><p>Add the first issue on the right.</p></div>`
              }
            </div>
          </div>
        </div>
        <div class="side-stack">
          <div class="card">
            <div class="card-head"><span class="card-title">New issue</span></div>
            <div class="field"><label for="issue-title">Title</label><input id="issue-title" placeholder="Draft the retention email sequence" /></div>
            <div class="field" style="margin-top:8px"><label for="issue-desc">Description</label><textarea id="issue-desc" rows="3"></textarea></div>
            <div class="field-row" style="margin-top:8px">
              <div class="field"><label for="issue-priority">Priority</label><select id="issue-priority">${PRIORITIES.map((priority) => `<option value="${priority}" ${priority === "medium" ? "selected" : ""}>${priority}</option>`).join("")}</select></div>
              <div class="field"><label for="issue-assignee">Assignee</label><select id="issue-assignee">${company.agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name)} (${esc(agent.role)})</option>`).join("")}</select></div>
            </div>
            <div class="field" style="margin-top:8px"><label for="issue-criteria">Acceptance criteria <span class="faint">(one per line)</span></label><textarea id="issue-criteria" rows="3"></textarea></div>
            <label class="check" style="margin-top:8px"><input type="checkbox" id="issue-approval" /> Needs board approval before work starts</label>
            <button class="btn btn-primary" id="create-issue" style="margin-top:var(--space-3)">Add issue</button>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Pipeline</span></div>
            <dl class="kv">
              ${ISSUE_STATUSES.map(
                (status) =>
                  `<dt>${esc(status)}</dt><dd class="mono">${company.issues.filter((issue) => issue.status === status).length}</dd>`,
              ).join("")}
            </dl>
          </div>
        </div>
      </div>`;
  }

  function renderIssue(issue) {
    const agent = company.agents.find((entry) => entry.id === issue.assigneeAgentId);
    const review = issue.review;
    return `
      <article class="task ${esc(issue.status === "done" ? "done" : issue.status === "blocked" ? "blocked" : issue.status === "in_progress" ? "running" : "")}">
        <div class="task-head">
          <span class="task-id">${esc(issue.key)}</span>
          <div style="flex:1;min-width:0">
            <div class="task-title">${esc(issue.title)}</div>
            <div class="task-meta">
              <span class="badge ${issue.priority === "critical" ? "badge-red" : issue.priority === "high" ? "badge-amber" : "badge-dim"}">${esc(issue.priority)}</span>
              ${statusBadge(issue.status)}
              ${agent ? `<span class="pill">${esc(agent.name)}</span>` : '<span class="badge badge-amber">unassigned</span>'}
              ${review ? `<span class="badge ${review.verdict === "pass" ? "badge-green" : "badge-amber"}">review ${esc(review.verdict)}${review.score ? ` ${review.score}` : ""}</span>` : ""}
              ${issue.needsApproval ? '<span class="badge badge-amber">needs approval</span>' : ""}
              ${issue.reworks ? `<span class="tiny faint">${issue.reworks} rework(s)</span>` : ""}
            </div>
          </div>
          <div class="row">
            <select data-status="${esc(issue.id)}" style="width:130px" aria-label="Issue status">
              ${ISSUE_STATUSES.map((status) => `<option value="${status}" ${issue.status === status ? "selected" : ""}>${status}</option>`).join("")}
            </select>
          </div>
        </div>
        ${issue.description ? `<details><summary class="small faint" style="cursor:pointer">Details, criteria and comments</summary>
          <div class="small muted" style="margin-top:8px">${md(issue.description)}</div>
          ${
            issue.acceptanceCriteria?.length
              ? `<ul class="small muted" style="margin:8px 0 0;padding-left:18px">${issue.acceptanceCriteria.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`
              : ""
          }
          ${
            issue.artifacts?.length
              ? `<div class="chips" style="margin-top:8px">${issue.artifacts
                  .map(
                    (name) =>
                      `<a class="chip" href="/api/companies/${esc(companyId)}/artifacts/${encodeURIComponent(name)}" target="_blank">${esc(name)}</a>`,
                  )
                  .join("")}</div>`
              : ""
          }
          ${
            issue.comments?.length
              ? `<div class="stack" style="margin-top:10px">${issue.comments
                  .slice(-4)
                  .map(
                    (comment) => `<div class="card flat tight">
                      <div class="tiny faint">${esc(
                        comment.authorType === "agent"
                          ? company.agents.find((entry) => entry.id === comment.authorAgentId)?.name ?? "agent"
                          : comment.authorType,
                      )} · ${fmt.date(comment.createdAt)}</div>
                      <div class="md small" style="margin-top:4px">${md(comment.body.slice(0, 1600))}</div>
                    </div>`,
                  )
                  .join("")}</div>`
              : ""
          }
          ${issue.blockedReason ? `<div class="banner" style="margin-top:8px"><span>⏸</span><div>${esc(issue.blockedReason)}</div></div>` : ""}
          <div class="row-wrap" style="margin-top:10px">
            <input data-comment-input="${esc(issue.id)}" placeholder="Leave guidance for the team…" style="flex:1;min-width:200px" />
            <button class="btn btn-sm" data-comment="${esc(issue.id)}">Comment</button>
          </div>
        </details>` : ""}
      </article>`;
  }

  function renderFinance() {
    const byAgent = company.agents
      .map((agent) => ({
        agent,
        cents: company.ledger.filter((entry) => entry.agentId === agent.id).reduce((sum, entry) => sum + entry.costCents, 0),
      }))
      .sort((a, b) => b.cents - a.cents);
    const max = Math.max(1, ...byAgent.map((entry) => entry.cents));
    const ledger = [...company.ledger].slice(-40).reverse();
    return `
      <div class="split">
        <div class="stack">
          <div class="card">
            <div class="card-head"><span class="card-title">Spend by agent</span><span class="badge badge-dim">${money(company.spentCents)} total</span></div>
            <div class="stack">
              ${byAgent
                .map(
                  ({ agent, cents }) => `<div>
                    <div class="spread tiny"><span>${esc(agent.name)} <span class="faint">· ${esc(agent.role)}</span></span><span class="mono">${money(cents)}</span></div>
                    <div class="progress"><span style="width:${Math.round((cents / max) * 100)}%"></span></div>
                  </div>`,
                )
                .join("")}
            </div>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Cost ledger</span><span class="badge badge-dim">${company.ledger.length} entries</span></div>
            ${
              ledger.length
                ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Agent</th><th>Kind</th><th>Model</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>
                    ${ledger
                      .map(
                        (entry) => `<tr>
                          <td class="tiny mono faint">${fmt.time(entry.at)}</td>
                          <td class="small">${esc(company.agents.find((agent) => agent.id === entry.agentId)?.name ?? "company")}</td>
                          <td class="tiny">${esc(entry.kind)}</td>
                          <td class="tiny mono">${esc(String(entry.model ?? "—").split("/").pop())}</td>
                          <td class="num">${fmt.tokens((entry.promptTokens ?? 0) + (entry.completionTokens ?? 0))}</td>
                          <td class="num">${money(entry.costCents)}</td>
                        </tr>`,
                      )
                      .join("")}
                  </tbody></table></div>`
                : `<p class="small faint">No model calls booked yet.</p>`
            }
          </div>
        </div>
        <div class="side-stack">
          <div class="card">
            <div class="card-head"><span class="card-title">Budget</span></div>
            <div class="field"><label for="company-budget">Monthly company budget (USD)</label><input id="company-budget" type="number" min="0" step="10" value="${(company.budgetMonthlyCents / 100).toFixed(2)}" /></div>
            <p class="tiny faint" style="margin-top:8px">Agents stop when their personal budget runs out; the company stops when this one does.</p>
            <button class="btn btn-sm" id="save-budget" style="margin-top:var(--space-3)">Save budget</button>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Token pricing</span></div>
            <p class="tiny faint" style="margin-bottom:8px">${company.settings.pricing?.estimated ? "Using estimated NIM rates — set your own contract rates." : "Custom rates in use."}</p>
            <div class="field"><label for="price-in">Input cents / 1M tokens</label><input id="price-in" type="number" min="0" step="1" value="${company.settings.pricing?.inputCentsPerMTok ?? 0}" /></div>
            <div class="field" style="margin-top:8px"><label for="price-out">Output cents / 1M tokens</label><input id="price-out" type="number" min="0" step="1" value="${company.settings.pricing?.outputCentsPerMTok ?? 0}" /></div>
            <button class="btn btn-sm" id="save-pricing" style="margin-top:var(--space-3)">Save rates</button>
          </div>
        </div>
      </div>`;
  }

  function renderAutopilot() {
    const auto = company.autoMode ?? {};
    const reason = ctx.state?.status?.companies?.autoReason?.[company.id];
    return `
      <div class="split">
        <div class="stack">
          <div class="card">
            <div class="card-head"><span class="card-title">Auto mode</span>
              <span class="badge ${auto.enabled ? "badge-green" : "badge-dim"}">${auto.enabled ? "running" : "stopped"}</span>
            </div>
            <p class="small muted">Auto mode runs a full cycle on a timer: CEO plans → employees work → quality reviews → standup. It stops itself when the budget is gone, the board is empty, approvals are waiting, or the cycle limit is reached.</p>
            <div class="field-row" style="margin-top:var(--space-3)">
              <div class="field">
                <label for="auto-interval">Cadence</label>
                <select id="auto-interval">
                  ${INTERVALS.map((interval) => `<option value="${interval.value}" ${Number(auto.everyMinutes) === interval.value ? "selected" : ""}>${esc(interval.label)}</option>`).join("")}
                </select>
              </div>
              <div class="field">
                <label for="auto-max">Max autonomous cycles</label>
                <input id="auto-max" type="number" min="0" step="1" value="${auto.maxCycles ?? 20}" />
              </div>
            </div>
            <div class="row-wrap" style="margin-top:var(--space-3)">
              <button class="btn ${auto.enabled ? "btn-danger" : "btn-primary"}" id="auto-toggle">${auto.enabled ? "Stop auto mode" : "Start auto mode"}</button>
              <span class="tiny faint">${auto.cyclesRun ?? 0} autonomous cycles run${auto.stopReason ? ` · stopped: ${esc(auto.stopReason)}` : ""}</span>
            </div>
            ${reason ? `<div class="banner" style="margin-top:var(--space-3)"><span>⏸</span><div>${esc(reason)}</div></div>` : ""}
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Cycles</span><span class="badge badge-dim">${company.cycles.length}</span></div>
            ${
              company.cycles.length
                ? `<div class="stack">${[...company.cycles]
                    .reverse()
                    .map(
                      (cycle) => `<details class="card flat tight" ${cycle.index === company.cycles.length ? "open" : ""}>
                        <summary style="cursor:pointer">
                          <span class="row-wrap">
                            <strong>Cycle ${cycle.index}</strong>
                            ${statusBadge(cycle.status)}
                            <span class="badge badge-dim">${esc(cycle.trigger)}</span>
                            <span class="tiny faint mono">${money(cycle.stats?.costCents ?? 0)} · ${fmt.tokens(cycle.stats?.tokens ?? 0)} tokens · ${cycle.stats?.issuesDone ?? 0} done</span>
                          </span>
                        </summary>
                        <div class="small muted" style="margin-top:8px"><strong>Focus:</strong> ${esc(cycle.focus || "—")}</div>
                        <div class="md small" style="margin-top:8px">${md(cycle.summary || "_No standup recorded._")}</div>
                        ${
                          cycle.results?.length
                            ? `<div class="chips" style="margin-top:8px">${cycle.results
                                .map((result) => `<span class="chip">${esc(result.key)}: ${esc(result.status)}</span>`)
                                .join("")}</div>`
                            : ""
                        }
                      </details>`,
                    )
                    .join("")}</div>`
                : `<p class="small faint">No cycles yet.</p>`
            }
          </div>
        </div>
        <div class="side-stack">
          <div class="card">
            <div class="card-head"><span class="card-title">Activity log</span></div>
            <div class="timeline" id="company-timeline">
              ${(detail.events ?? [])
                .slice(-60)
                .reverse()
                .map(
                  (event) => `<div class="tl-row ${toneFor(event.type)}">
                    <span class="tl-time">${fmt.time(event.at)}</span>
                    <span class="tl-marker"><span class="tl-dot"></span></span>
                    <span class="tl-body">${esc(event.message ?? event.type)}</span>
                  </div>`,
                )
                .join("")}
            </div>
          </div>
        </div>
      </div>`;
  }

  function renderSettings() {
    const pc = ctx.state?.status?.config?.paperclip ?? {};
    return `
      <div class="split">
        <div class="stack">
          <div class="card">
            <div class="card-head"><span class="card-title">Company</span></div>
            <div class="field"><label for="set-name">Name</label><input id="set-name" value="${esc(company.name)}" /></div>
            <div class="field" style="margin-top:8px"><label for="set-mission">Mission</label><textarea id="set-mission" rows="2">${esc(company.mission)}</textarea></div>
            <div class="field-row" style="margin-top:8px">
              <div class="field">
                <label for="set-approval">Approval policy</label>
                <select id="set-approval">
                  ${[["high", "Board approval for risky work"], ["all", "Every issue"], ["never", "Fully autonomous"]]
                    .map(([value, label]) => `<option value="${value}" ${company.settings.approvalPolicy === value ? "selected" : ""}>${label}</option>`)
                    .join("")}
                </select>
              </div>
              <div class="field"><label for="set-max">Issues per cycle</label><input id="set-max" type="number" min="1" max="8" value="${company.settings.maxIssuesPerCycle}" /></div>
              <div class="field"><label for="set-rework">Rework limit</label><input id="set-rework" type="number" min="0" max="3" value="${company.settings.reworkLimit}" /></div>
              <div class="field">
                <label for="set-status">Status</label>
                <select id="set-status">${["active", "paused"].map((status) => `<option value="${status}" ${company.status === status ? "selected" : ""}>${status}</option>`).join("")}</select>
              </div>
            </div>
            <div class="row-wrap" style="margin-top:var(--space-3)">
              <button class="btn btn-primary" id="save-company">Save</button>
              <button class="btn btn-danger" id="delete-company">Delete company</button>
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <span class="card-title">Paperclip bridge</span>
              <span class="badge ${pc.configured ? "badge-green" : "badge-dim"}">${pc.configured ? `linked · ${esc(pc.baseUrl ?? "")}` : "not linked"}</span>
            </div>
            <p class="small muted">
              Mirror this company into a real Paperclip instance so its agents, goals, issues and budgets live in Paperclip's
              board. Paperclip stays the system of record; NVIDIA NIM stays the inference.
            </p>
            <div class="field" style="margin-top:var(--space-3)"><label for="pc-url">Paperclip API base URL</label><input id="pc-url" value="${esc(pc.baseUrl ?? "http://localhost:3100/api")}" /></div>
            <div class="field" style="margin-top:8px"><label for="pc-token">Board bearer token</label><input id="pc-token" type="password" placeholder="${pc.configured ? "•••• saved" : "paste a Paperclip board token"}" autocomplete="off" /></div>
            <div class="row-wrap" style="margin-top:var(--space-3)">
              <button class="btn btn-sm" id="pc-save">Save</button>
              <button class="btn btn-sm" id="pc-probe">Test connection</button>
              <button class="btn btn-sm" id="pc-preview">Preview mirror</button>
              <button class="btn btn-primary btn-sm" id="pc-mirror">Mirror to Paperclip</button>
            </div>
            <div id="pc-result" style="margin-top:var(--space-3)"></div>
            ${
              company.paperclip
                ? `<div class="banner green" style="margin-top:var(--space-3)"><span>✓</span><div>Mirrored ${fmt.ago(company.paperclip.mirroredAt)} into Paperclip company <code>${esc(company.paperclip.companyId ?? "")}</code> — ${company.paperclip.agents} agents, ${company.paperclip.goals} goals, ${company.paperclip.issues} issues.</div></div>`
                : ""
            }
          </div>
        </div>

        <div class="side-stack">
          <div class="card">
            <div class="card-head"><span class="card-title">What gets mirrored</span></div>
            <ul class="small muted" style="margin:0;padding-left:18px;line-height:1.8">
              <li>Company (name, description, monthly budget)</li>
              <li>Agents with Paperclip roles, budgets and the NIM model pinned in metadata</li>
              <li>Company and team goals with status</li>
              <li>Issues with status, priority and acceptance criteria</li>
            </ul>
            <p class="tiny faint" style="margin-top:8px">Credentials stay in Paperclip's secret store — this app never sends the NVIDIA key to the bridge.</p>
          </div>
          <div class="card">
            <div class="card-head"><span class="card-title">Data on this machine</span></div>
            <dl class="kv">
              <dt>State</dt><dd class="mono tiny">data/companies/${esc(companyId)}/company.json</dd>
              <dt>Audit log</dt><dd class="mono tiny">events.ndjson</dd>
              <dt>Artifacts</dt><dd class="mono tiny">artifacts/</dd>
            </dl>
            <a class="btn btn-sm btn-ghost" style="margin-top:8px" href="/api/companies/${esc(companyId)}/export">Download bundle</a>
          </div>
        </div>
      </div>`;
  }

  /* ------------------------------- bindings -------------------------------- */

  function bindCommon() {
    el.querySelector("#run-cycle")?.addEventListener("click", async () => {
      busy = "cycle";
      paintBody();
      try {
        const result = await api.post(`/api/companies/${companyId}/cycles`, {});
        const done = result.cycle.stats?.issuesDone ?? 0;
        toast(`Cycle ${result.cycle.index} finished — ${done} issue(s) accepted`);
        await load();
      } catch (error) {
        reportError(error);
      } finally {
        busy = null;
        paintBody();
      }
    });

    el.querySelector("#toggle-auto")?.addEventListener("click", () => void toggleAuto());
    el.querySelector("#refresh")?.addEventListener("click", () => load());

    el.querySelectorAll("[data-approve]").forEach((button) => {
      button.addEventListener("click", () => void decide(button.dataset.approve, true));
    });
    el.querySelectorAll("[data-reject]").forEach((button) => {
      button.addEventListener("click", () => void decide(button.dataset.reject, false));
    });

    el.querySelector("#hire")?.addEventListener("click", async () => {
      try {
        await api.post(`/api/companies/${companyId}/agents`, {
          name: el.querySelector("#hire-name").value.trim() || "New hire",
          role: el.querySelector("#hire-role").value,
          title: el.querySelector("#hire-title").value.trim() || el.querySelector("#hire-role").value.toUpperCase(),
          model: el.querySelector("#hire-model").value || null,
          budgetMonthlyCents: Math.round(Number(el.querySelector("#hire-budget").value || 0) * 100),
        });
        toast("Hired");
        await load();
      } catch (error) {
        reportError(error);
      }
    });

    const pick = el.querySelector("#agent-pick");
    if (pick) {
      paintAgentEditor(pick.value);
      pick.addEventListener("change", () => paintAgentEditor(pick.value));
    }

    el.querySelector("#create-issue")?.addEventListener("click", async () => {
      const title = el.querySelector("#issue-title").value.trim();
      if (!title) return toast("Give the issue a title.", "warn");
      try {
        await api.post(`/api/companies/${companyId}/issues`, {
          title,
          description: el.querySelector("#issue-desc").value,
          priority: el.querySelector("#issue-priority").value,
          assigneeAgentId: el.querySelector("#issue-assignee").value,
          acceptanceCriteria: el
            .querySelector("#issue-criteria")
            .value.split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
          needsApproval: el.querySelector("#issue-approval").checked,
        });
        toast("Issue added to the board");
        await load();
      } catch (error) {
        reportError(error);
      }
    });

    el.querySelectorAll("[data-status]").forEach((select) => {
      select.addEventListener("change", async () => {
        try {
          await api.patch(`/api/companies/${companyId}/issues/${select.dataset.status}`, { status: select.value });
          toast("Status updated");
          await load();
        } catch (error) {
          reportError(error);
        }
      });
    });

    el.querySelectorAll("[data-comment]").forEach((button) => {
      button.addEventListener("click", async () => {
        const input = el.querySelector(`[data-comment-input="${button.dataset.comment}"]`);
        const body = input?.value.trim();
        if (!body) return toast("Write a comment first.", "warn");
        try {
          await api.post(`/api/companies/${companyId}/issues/${button.dataset.comment}/comments`, { body });
          toast("Comment posted");
          await load();
        } catch (error) {
          reportError(error);
        }
      });
    });

    el.querySelector("#save-budget")?.addEventListener("click", async () => {
      try {
        await api.patch(`/api/companies/${companyId}`, {
          budgetMonthlyCents: Math.round(Number(el.querySelector("#company-budget").value || 0) * 100),
        });
        toast("Budget updated");
        await load();
      } catch (error) {
        reportError(error);
      }
    });

    el.querySelector("#save-pricing")?.addEventListener("click", async () => {
      try {
        await api.patch(`/api/companies/${companyId}`, {
          settings: {
            pricing: {
              inputCentsPerMTok: Number(el.querySelector("#price-in").value || 0),
              outputCentsPerMTok: Number(el.querySelector("#price-out").value || 0),
            },
          },
        });
        toast("Pricing saved");
        await load();
      } catch (error) {
        reportError(error);
      }
    });

    el.querySelector("#auto-toggle")?.addEventListener("click", () => void toggleAuto(true));

    el.querySelector("#save-company")?.addEventListener("click", async () => {
      try {
        await api.patch(`/api/companies/${companyId}`, {
          name: el.querySelector("#set-name").value.trim(),
          mission: el.querySelector("#set-mission").value,
          status: el.querySelector("#set-status").value,
          settings: {
            approvalPolicy: el.querySelector("#set-approval").value,
            maxIssuesPerCycle: Number(el.querySelector("#set-max").value || 3),
            reworkLimit: Number(el.querySelector("#set-rework").value || 1),
          },
        });
        toast("Company saved");
        await load();
      } catch (error) {
        reportError(error);
      }
    });

    el.querySelector("#delete-company")?.addEventListener("click", async () => {
      if (!confirm(`Delete ${company.name}, its board and its artifacts? This cannot be undone.`)) return;
      try {
        await api.del(`/api/companies/${companyId}`);
        toast("Company deleted");
        ctx.navigate("/companies");
      } catch (error) {
        reportError(error);
      }
    });

    el.querySelector("#pc-save")?.addEventListener("click", async () => {
      try {
        const body = { paperclip: { baseUrl: el.querySelector("#pc-url").value.trim() } };
        const token = el.querySelector("#pc-token").value.trim();
        if (token) body.paperclip.token = token;
        await api.put("/api/settings", body);
        toast("Paperclip bridge saved");
        await ctx.refresh();
        await load();
      } catch (error) {
        reportError(error);
      }
    });

    el.querySelector("#pc-probe")?.addEventListener("click", async () => {
      const host = el.querySelector("#pc-result");
      host.innerHTML = `<span class="spinner"></span> <span class="small faint">probing Paperclip…</span>`;
      try {
        const result = await api.post("/api/paperclip/probe", {
          baseUrl: el.querySelector("#pc-url").value.trim() || undefined,
          token: el.querySelector("#pc-token").value.trim() || undefined,
        });
        host.innerHTML = `<div class="banner green"><span>✓</span><div>Paperclip reachable in ${result.latencyMs}ms · ${result.companies} companies${
          result.sample?.length ? ` (e.g. ${result.sample.map((entry) => esc(entry.name)).join(", ")})` : ""
        }</div></div>`;
      } catch (error) {
        host.innerHTML = `<div class="banner red"><span>✕</span><div><strong>Not reachable.</strong> ${esc(error.message)}${error.hint ? ` — ${esc(error.hint)}` : ""}</div></div>`;
      }
    });

    el.querySelector("#pc-preview")?.addEventListener("click", () => void mirror(true));
    el.querySelector("#pc-mirror")?.addEventListener("click", () => void mirror(false));
  }

  async function mirror(dryRun) {
    const host = el.querySelector("#pc-result");
    host.innerHTML = `<span class="spinner"></span> <span class="small faint">${dryRun ? "building the call plan…" : "mirroring…"}</span>`;
    try {
      const result = await api.post("/api/paperclip/mirror", {
        companyId,
        dryRun,
        baseUrl: el.querySelector("#pc-url").value.trim() || undefined,
        token: el.querySelector("#pc-token").value.trim() || undefined,
      });
      if (result.dryRun) {
        host.innerHTML = `
          <div class="card flat tight">
            <div class="spread"><strong>${result.calls} API calls</strong><span class="badge badge-dim">dry run</span></div>
            <div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Step</th><th>Method</th><th>Path</th></tr></thead><tbody>
              ${result.plan
                .map(
                  (step) => `<tr><td class="tiny">${esc(step.step)}</td><td class="tiny mono">${esc(step.method)}</td><td class="tiny mono">${esc(step.path)}</td></tr>`,
                )
                .join("")}
            </tbody></table></div>
          </div>`;
      } else {
        host.innerHTML = `<div class="banner green"><span>✓</span><div>Mirrored into Paperclip company <code>${esc(result.created.companyId ?? "")}</code> — ${result.created.agents.length} agents, ${result.created.goals.length} goals, ${result.created.issues.length} issues.</div></div>`;
        toast("Company mirrored to Paperclip");
        await load();
      }
    } catch (error) {
      host.innerHTML = `<div class="banner red"><span>✕</span><div><strong>Mirror failed.</strong> ${esc(error.message)}${error.hint ? ` — ${esc(error.hint)}` : ""}</div></div>`;
    }
  }

  async function toggleAuto(fromTab = false) {
    const auto = company.autoMode ?? {};
    try {
      if (auto.enabled) {
        await api.post(`/api/companies/${companyId}/auto`, { enabled: false, reason: "Turned off by the operator" });
        toast("Auto mode stopped");
      } else {
        const interval = Number(el.querySelector("#auto-interval")?.value ?? auto.everyMinutes ?? 15);
        const maxCycles = Number(el.querySelector("#auto-max")?.value ?? auto.maxCycles ?? 20);
        await api.post(`/api/companies/${companyId}/auto`, { enabled: true, everyMinutes: interval, maxCycles });
        toast("Auto mode started — the company will run on a timer");
      }
      await load();
      if (fromTab) tab = "autopilot";
    } catch (error) {
      reportError(error);
    }
  }

  async function decide(approvalId, approved) {
    try {
      await api.post(`/api/companies/${companyId}/approvals/${approvalId}`, { approved, note: approved ? "Approved by the board" : "Rejected by the board" });
      toast(approved ? "Approved — the issue is back on the board" : "Rejected — the issue is blocked");
      await load();
    } catch (error) {
      reportError(error);
    }
  }

  async function load() {
    if (closed) return;
    try {
      detail = await api.get(`/api/companies/${companyId}`);
      company = detail.company;
      artifacts = detail.artifacts;
      paintTabs();
      paintBody();
    } catch (error) {
      if (error.status === 404) {
        toast("This company was deleted", "warn");
        ctx.navigate("/companies");
      }
    }
  }

  if (ctx.state?.models === null || ctx.state?.models === undefined) {
    ctx.state.models = await api.get("/api/models").catch(() => ({ models: [] }));
  }

  paintTabs();
  paintBody();

  if (typeof EventSource !== "undefined") {
    source = new EventSource(`/api/companies/${companyId}/stream`);
    let dragging = false;
    source.addEventListener("event", () => {
      if (!dragging) {
        dragging = true;
        setTimeout(() => {
          dragging = false;
          if (!busy) void load();
        }, 600);
      }
    });
    source.addEventListener("state", (message) => {
      try {
        const next = JSON.parse(message.data);
        if (next?.id === companyId && !busy) {
          company = next;
          paintBody();
        }
      } catch {
        /* ignore malformed frame */
      }
    });
    source.onerror = () => source?.close();
  }

  return () => {
    closed = true;
    source?.close();
  };

  function statCard(label, value, hint) {
    return `<div class="stat"><span class="stat-label">${esc(label)}</span><span class="stat-value">${esc(value)}</span><span class="stat-hint">${esc(hint ?? "")}</span></div>`;
  }

  function toneFor(type) {
    if (/done|completed|approved|created|hired|ready/.test(type)) return "ok";
    if (/failed|blocked|rejected|over_budget|error/.test(type)) return "bad";
    if (/approval|rework|deferred|paused/.test(type)) return "warn";
    return "info";
  }
}
