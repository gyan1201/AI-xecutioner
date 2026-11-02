import { api, ago, avatar, bars, esc, icon, md, money, num, pct } from "../lib.js";
import { agentChip, emptyState, goalDirection, goalProgress, issueRow, modelPill, pageHeader, spendBar } from "./shared.js";

export const title = "Dashboard";

export async function render(root, ctx) {
  const [dashboard, issuesData] = await Promise.all([
    api(`/api/companies/${ctx.companyId}/dashboard`),
    api(`/api/companies/${ctx.companyId}/issues?status=open&limit=8`),
  ]);
  const company = ctx.company;
  const stats = dashboard.stats;
  const goals = company.goals ?? [];
  const primaryGoal = goals[0];
  const progress = primaryGoal ? goalProgress(primaryGoal) : 0;
  const config = ctx.state.bootstrap?.config;
  const runSeries = dashboard.charts.byDay;

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Dashboard",
      title: `${esc(company.name)}`,
      subtitle: company.mission ? md(company.mission) : "No mission set yet — add one in Settings so agents have something to aim at.",
      actions: `
        <button class="btn ghost" data-action="plan">${icon("spark", "nav-icon")} Plan only</button>
        <button class="btn primary" data-action="cycle">${icon("play", "nav-icon")} Run cycle</button>`,
    })}

    ${config?.mode === "simulation" ? `
      <div class="card" style="border-color:var(--accent-border);background:linear-gradient(90deg,rgba(118,185,0,.07),transparent 60%);margin-bottom:16px">
        <div class="row-between" style="gap:14px;flex-wrap:wrap">
          <div class="row" style="gap:10px">
            <span class="pill accent"><span class="dot"></span>Simulation</span>
            <span style="font-size:12.5px;color:var(--text-2)">${
              config?.keyPresent
                ? `Key ${esc(config.keyHint ?? "")} is saved but not verified from this host, so every model call is served locally. Verify it in Settings to go live — the company, board and ledger are already real.`
                : "No NVIDIA key configured. Every model call is served locally so the agents, ledger, guardrails and blueprints stay fully explorable."
            }</span>
          </div>
          <button class="btn sm" data-action="settings">${config?.keyPresent ? "Open settings" : "Add a key"}</button>
        </div>
      </div>` : ""}

    <div class="stat-grid">
      <div class="stat">
        <div class="row-between"><div class="stat-value">${stats.activeAgents}<small>/${stats.agents}</small></div><span class="stat-icon">${icon("agents", "")}</span></div>
        <div class="stat-label">Agents enabled</div>
        <div class="stat-sub">${dashboard.spend.unlimited ? "running without a spend limit" : `${stats.agents - stats.activeAgents} paused or over budget`}</div>
      </div>
      <div class="stat">
        <div class="row-between"><div class="stat-value">${stats.issuesInProgress}</div><span class="stat-icon">${icon("issues", "")}</span></div>
        <div class="stat-label">Issues in progress</div>
        <div class="stat-sub">${stats.openIssues} open · ${stats.blockedIssues} blocked</div>
      </div>
      <div class="stat">
        <div class="row-between"><div class="stat-value">${money(dashboard.spend.totalCents)}</div><span class="stat-icon">${icon("budget", "")}</span></div>
        <div class="stat-label">Month spend</div>
        <div class="stat-sub">${money(dashboard.spend.weekCents)} this week · ${dashboard.spend.unlimited ? "no limit" : `cap ${money(dashboard.spend.capCents)}`}</div>
      </div>
      <div class="stat">
        <div class="row-between"><div class="stat-value">${stats.pendingApprovals}</div><span class="stat-icon">${icon("approvals", "")}</span></div>
        <div class="stat-label">Pending approvals</div>
        <div class="stat-sub">${dashboard.charts.successRate}% run success rate</div>
      </div>
    </div>

    <div class="split" style="grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);margin-top:18px">
      <div class="card">
        <div class="row-between" style="margin-bottom:10px">
          <div class="card-title" style="margin:0">Run activity · 14 days</div>
          <div class="row" style="gap:10px;font-size:10.5px;color:var(--dim)">
            <span class="row" style="gap:4px"><i style="width:7px;height:7px;border-radius:2px;background:var(--accent);display:inline-block"></i>succeeded</span>
            <span class="row" style="gap:4px"><i style="width:7px;height:7px;border-radius:2px;background:var(--red);display:inline-block"></i>failed</span>
          </div>
        </div>
        ${stackedRunChart(runSeries)}
        <div class="chart-x"><span>${runSeries[0].day.slice(5)}</span><span>${runSeries[Math.floor(runSeries.length / 2)].day.slice(5)}</span><span>${runSeries.at(-1).day.slice(5)}</span></div>
      </div>

      <div class="card">
        <div class="card-title">Primary goal</div>
        ${primaryGoal ? `
          <div style="font-size:14px;font-weight:550;line-height:1.4;margin-bottom:8px">${esc(primaryGoal.title)}</div>
          <div class="progress" style="height:6px"><i style="width:${Math.round(progress * 100)}%"></i></div>
          <div class="row-between" style="margin-top:8px">
            <span style="font-size:12px;color:var(--text-2)">${num(primaryGoal.current)} → ${num(primaryGoal.target)} ${esc(primaryGoal.unit ?? "")}</span>
            <span class="pill accent">${Math.round(progress * 100)}%</span>
          </div>
          <div class="row" style="gap:8px;margin-top:12px">
            <span class="tag">${esc(primaryGoal.metric || "metric")}</span>
            <span class="tag">baseline ${num(primaryGoal.baseline)}</span>
            <span class="tag">${goalDirection(primaryGoal)}</span>
          </div>
          <div class="hint" style="margin-top:10px">Owned by ${esc(company.agents.find((agent) => agent.id === primaryGoal.ownerId)?.name ?? "unassigned")} · due ${primaryGoal.dueAt ? new Date(primaryGoal.dueAt).toLocaleDateString() : "—"}</div>
        ` : `<div class="hint">No goal yet.</div>`}
      </div>
    </div>

    <div class="section-title">Agents</div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(248px,1fr))">
      ${dashboard.agents
        .map(
          (agent) => `
        <div class="card card-hover" data-agent="${esc(agent.id)}" style="cursor:pointer;display:flex;flex-direction:column;gap:9px">
          <div class="row" style="gap:9px">
            ${avatar(agent)}
            <div class="grow" style="min-width:0">
              <div class="row" style="gap:6px"><span style="font-weight:600;font-size:13px">${esc(agent.name)}</span><span class="status-dot ${agent.status}" title="${esc(agent.status)}"></span></div>
              <div class="hint truncate">${esc(agent.title)}</div>
            </div>
          </div>
          <div class="row" style="gap:5px;flex-wrap:wrap">${modelPill(agent.model)}</div>
          ${spendBar(agent.spend, { compact: true })}
          <div class="hint">${agent.lastRun ? `Last run ${ago(agent.lastRun.startedAt)} · ${esc(agent.lastRun.status)}` : "No runs yet"}</div>
        </div>`,
        )
        .join("")}
    </div>

    <div class="split" style="grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);margin-top:20px">
      <div>
        <div class="row-between">
          <div class="section-title" style="margin:0 0 10px">Open issues</div>
          <a class="hint" href="#/issues">View all →</a>
        </div>
        <div class="card pad-0" style="overflow:hidden">
          <table class="table">
            <tbody>
              ${issuesData.issues.slice(0, 8).map(issueRow).join("") || `<tr><td class="muted">No open issues.</td></tr>`}
            </tbody>
          </table>
        </div>

        <div class="row-between" style="margin-top:20px">
          <div class="section-title" style="margin:0 0 10px">Recent cycles</div>
          <span class="hint">${(company.cycleHistory ?? []).length} recorded</span>
        </div>
        <div class="stack">
          ${(dashboard.cycles ?? []).length
            ? dashboard.cycles
                .map(
                  (cycle) => `<div class="card tight">
                    <div class="row-between" style="gap:10px">
                      <div class="grow" style="min-width:0">
                        <div style="font-size:12.5px;font-weight:500" class="truncate">${esc(cycle.focus || "Cycle")}</div>
                        <div class="hint">${ago(cycle.endedAt)} · ${cycle.ran} runs · ${cycle.accepted} accepted · ${cycle.changesRequested} rework · ${money(cycle.costCents ?? 0, { precise: true })}</div>
                      </div>
                      <span class="pill ${cycle.blocked ? "red" : "green"}">${cycle.blocked ? `${cycle.blocked} blocked` : "clean"}</span>
                    </div>
                    ${cycle.standup ? `<div class="prose" style="font-size:12px;margin-top:8px;color:var(--muted)">${esc(cycle.standup.slice(0, 220))}${cycle.standup.length > 220 ? "…" : ""}</div>` : ""}
                  </div>`,
                )
                .join("")
            : `<div class="card"><div class="hint">No cycles yet. Run one and the CEO will pick a focus for the board.</div></div>`}
        </div>
      </div>

      <div class="stack">
        <div>
          <div class="section-title" style="margin:0 0 10px">Board by status</div>
          <div class="card">
            ${dashboard.charts.byStatus
              .map(
                (row) => `<div class="row-between" style="padding:5px 0;font-size:12.3px">
                  <span class="row" style="gap:7px"><i style="width:7px;height:7px;border-radius:50%;background:${statusColor(row.status)}"></i>${esc(statusLabel(row.status))}</span>
                  <span style="color:var(--text-2)">${row.count}</span>
                </div>`,
              )
              .join("")}
            <div class="progress" style="margin-top:10px">
              <i style="width:${Math.round(((stats.openIssues - stats.blockedIssues) / Math.max(1, stats.openIssues)) * 100)}%"></i>
            </div>
            <div class="hint" style="margin-top:6px">${stats.openIssues - stats.blockedIssues} of ${stats.openIssues} open issues are unblocked</div>
          </div>
        </div>

        <div>
          <div class="section-title" style="margin:0 0 10px">Spend by agent</div>
          <div class="card">
            ${dashboard.spend.topAgents.length
              ? dashboard.spend.topAgents
                  .map(
                    (row) => `<div class="row-between" style="padding:5px 0;font-size:12.3px">
                      <span>${esc(row.name)}</span>
                      <span class="mono" style="font-size:11px;color:var(--text-2)">${money(row.cents, { precise: true })}</span>
                    </div>`,
                  )
                  .join("")
              : `<div class="hint">No spend recorded yet.</div>`}
            <div class="hint" style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">Ledger rows are written per model call from the NIM client's usage events.</div>
          </div>
        </div>

        <div>
          <div class="row-between" style="margin-bottom:10px">
            <div class="section-title" style="margin:0">Recent activity</div>
            <a class="hint" href="#/activity">All →</a>
          </div>
          <div class="card">
            ${dashboard.recentActivity.length
              ? dashboard.recentActivity
                  .map((entry) => {
                    const actor = company.agents.find((agent) => agent.id === entry.actorId);
                    return `<div class="row" style="gap:8px;padding:6px 0;align-items:flex-start">
                      ${avatar(actor ?? { name: entry.actorId }, "sm")}
                      <div class="grow" style="min-width:0">
                        <div style="font-size:12.2px;line-height:1.45">${esc(entry.detail || entry.subject)}</div>
                        <div class="hint">${esc(entry.subject)} · ${ago(entry.at)}</div>
                      </div>
                    </div>`;
                  })
                  .join("")
              : `<div class="hint">Nothing yet.</div>`}
          </div>
        </div>
      </div>
    </div>
  `;

  const openIssue = (event) => {
    const id = event.target.closest("[data-issue]")?.dataset.issue;
    if (id) ctx.navigate(`/issues/${id}`);
    const agentId = event.target.closest("[data-agent]")?.dataset.agent;
    if (agentId) ctx.navigate(`/agents/${agentId}`);
  };
  root.addEventListener("click", openIssue);

  root.querySelector('[data-action="cycle"]')?.addEventListener("click", () => ctx.runCycle?.());
  root.querySelector('[data-action="plan"]')?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Planning…";
    try {
      const result = await api(`/api/companies/${ctx.companyId}/plan`, { method: "POST" });
      ctx.toast(`Focus: ${result.plan.focus}`);
      await ctx.refresh(true);
      render(root, ctx);
    } catch (error) {
      ctx.toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Plan only";
    }
  });
  root.querySelector('[data-action="settings"]')?.addEventListener("click", () => ctx.navigate("/settings"));

  return () => root.removeEventListener("click", openIssue);
}

function stackedRunChart(series) {
  const totals = series.map((day) => day.succeeded + day.failed);
  const max = Math.max(1, ...totals);
  return `<div class="chart">${series
    .map((day) => {
      const total = day.succeeded + day.failed;
      const height = Math.max(2, Math.round((total / max) * 100));
      const succeededShare = total ? (day.succeeded / total) * 100 : 0;
      return `<div class="bar" style="height:${height}%;background:#1a1a20;display:flex;flex-direction:column-reverse" title="${day.day}: ${day.succeeded} succeeded, ${day.failed} failed">
        <i style="display:block;height:${succeededShare}%;background:var(--accent);opacity:.85"></i>
        <i style="display:block;height:${100 - succeededShare}%;background:var(--red);opacity:.8"></i>
      </div>`;
    })
    .join("")}</div>`;
}

function statusColor(status) {
  return {
    backlog: "var(--s-backlog)",
    todo: "var(--s-todo)",
    in_progress: "var(--s-progress)",
    in_review: "var(--s-review)",
    done: "var(--s-done)",
    blocked: "var(--s-blocked)",
    cancelled: "#6e7681",
  }[status] ?? "var(--s-backlog)";
}

function statusLabel(status) {
  return status.replace("_", " ").replace(/^./, (char) => char.toUpperCase());
}
