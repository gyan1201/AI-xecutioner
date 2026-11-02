import { api, ago, avatar, esc, icon, money, num, toast } from "../lib.js";
import { modelPill, pageHeader } from "./shared.js";

export const title = "Spend";

export async function render(root, ctx) {
  const ledger = await api(`/api/companies/${ctx.companyId}/ledger`);
  const company = ctx.company;
  const spendSeries = buildSeries(ledger.rows);
  const topModels = ledger.byModel.slice(0, 6);
  const capUsed = ledger.capCents ? Math.min(1, ledger.totalCents / ledger.capCents) : 0;

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Company",
      title: "Spend",
      subtitle: "Every model call writes a ledger row from the NIM usage event — tokens, model, agent, run.",
      actions: `<button class="btn ghost" data-action="refresh">${icon("activity", "nav-icon")} Refresh</button>`,
    })}

    <div class="stat-grid">
      <div class="stat">
        <div class="stat-value">${money(ledger.totalCents)}</div>
        <div class="stat-label">Month spend</div>
        <div class="stat-sub">cap ${money(ledger.capCents)} · ${Math.round(capUsed * 100)}% used</div>
      </div>
      <div class="stat">
        <div class="stat-value">${num(ledger.rows.length)}</div>
        <div class="stat-label">Model calls</div>
        <div class="stat-sub">${num(ledger.rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0))} tokens</div>
      </div>
      <div class="stat">
        <div class="stat-value">${money(ledger.totalCents / Math.max(1, ledger.rows.length), { precise: true })}</div>
        <div class="stat-label">Avg per call</div>
        <div class="stat-sub">across ${ledger.byModel.length} models</div>
      </div>
      <div class="stat">
        <div class="stat-value">${ledger.agents.filter((agent) => agent.ratio > 0.8).length}</div>
        <div class="stat-label">Agents near cap</div>
        <div class="stat-sub">${ledger.agents.filter((agent) => agent.overBudget).length} over budget</div>
      </div>
    </div>

    <div class="split" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);margin-top:16px">
      <div class="card">
        <div class="card-title">Daily spend · last 14 days</div>
        ${spendChart(spendSeries)}
        <div class="chart-x"><span>${spendSeries[0]?.day.slice(5) ?? ""}</span><span>${spendSeries.at(-1)?.day.slice(5) ?? ""}</span></div>
      </div>
      <div class="card">
        <div class="card-title">Spend by model</div>
        ${topModels
          .map(
            (row) => `<div style="padding:5px 0">
              <div class="row-between" style="font-size:12.2px"><span class="mono" style="font-size:11px">${esc(row.model.split("/").pop())}</span><span>${money(row.cents, { precise: true })}</span></div>
              <div class="progress" style="margin-top:3px"><i style="width:${Math.round((row.cents / Math.max(1, topModels[0].cents)) * 100)}%;background:var(--blue)"></i></div>
            </div>`,
          )
          .join("") || `<div class="hint">No spend yet.</div>`}
      </div>
    </div>

    <div class="section-title">Per-agent budgets</div>
    <div class="card pad-0" style="overflow:hidden">
      <table class="table">
        <thead><tr><th>Agent</th><th>Model</th><th style="width:30%">Budget</th><th>Spent</th><th>Cap</th><th></th></tr></thead>
        <tbody>
          ${ledger.agents
            .map(
              (agent) => `<tr data-agent-row="${esc(agent.id)}">
                <td>${avatar(company.agents.find((entry) => entry.id === agent.id) ?? { name: agent.name }, "sm")} <span style="margin-left:4px">${esc(agent.name)}</span></td>
                <td>${modelPill(agent.model)}</td>
                <td>
                  <div class="progress"><i style="width:${Math.round(Math.min(1, agent.ratio) * 100)}%;background:${agent.overBudget ? "var(--red)" : agent.ratio > 0.8 ? "var(--amber)" : "var(--accent)"}"></i></div>
                </td>
                <td class="nowrap">${money(agent.spentCents, { precise: true })}</td>
                <td class="nowrap dim">${money(agent.capCents)}</td>
                <td class="nowrap">${agent.overBudget ? `<span class="pill red">over</span>` : `<button class="btn sm ghost" data-edit-cap="${esc(agent.id)}">Edit cap</button>`}</td>
              </tr>`,
            )
            .join("") || `<tr><td class="hint">No agents.</td></tr>`}
        </tbody>
      </table>
    </div>

    <div class="section-title">Ledger</div>
    <div class="card pad-0" style="overflow:hidden;max-height:420px;overflow-y:auto">
      <table class="table">
        <thead><tr><th>When</th><th>Agent</th><th>Model</th><th>Endpoint</th><th>Tokens</th><th>Cost</th></tr></thead>
        <tbody>
          ${ledger.rows
            .slice(0, 120)
            .map((row) => {
              const agent = company.agents.find((entry) => entry.id === row.agentId);
              return `<tr>
                <td class="dim nowrap" style="font-size:11px">${ago(row.at)}</td>
                <td class="nowrap">${esc(agent?.name ?? "system")}</td>
                <td class="mono" style="font-size:10.5px">${esc(row.model.split("/").pop())}</td>
                <td><span class="tag">${esc(row.endpoint)}</span></td>
                <td class="dim nowrap">${num(row.inputTokens)} / ${num(row.outputTokens)}</td>
                <td class="nowrap">${money(row.costCents, { precise: true })}</td>
              </tr>`;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;

  root.querySelectorAll("[data-edit-cap]").forEach((button) =>
    button.addEventListener("click", async () => {
      const agent = company.agents.find((entry) => entry.id === button.dataset.editCap);
      const next = window.prompt(`Monthly cap for ${agent.name} in cents`, String(agent.monthlyBudgetCents));
      if (next == null) return;
      try {
        await api(`/api/companies/${ctx.companyId}/agents/${agent.id}`, { method: "PATCH", body: { monthlyBudgetCents: Number(next) } });
        await ctx.refresh(true);
        toast("Budget updated");
        render(root, ctx);
      } catch (error) {
        toast(error.message, "error");
      }
    }),
  );
  root.querySelector('[data-action="refresh"]').addEventListener("click", () => render(root, ctx));
}

function buildSeries(rows) {
  const days = {};
  for (let index = 13; index >= 0; index -= 1) {
    const day = new Date(Date.now() - index * 86_400_000).toISOString().slice(0, 10);
    days[day] = { day, cents: 0 };
  }
  for (const row of rows) {
    const day = row.at.slice(0, 10);
    if (days[day]) days[day].cents += row.costCents;
  }
  return Object.values(days);
}

function spendChart(series) {
  const max = Math.max(1, ...series.map((day) => day.cents));
  return `<div class="chart">${series
    .map((day) => `<div class="bar green" style="height:${Math.max(2, Math.round((day.cents / max) * 100))}%" title="${day.day}: ${money(day.cents, { precise: true })}"></div>`)
    .join("")}</div>`;
}
