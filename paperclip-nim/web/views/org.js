import { api, avatar, esc, icon, money, num } from "../lib.js";
import { modelPill, pageHeader } from "./shared.js";

export const title = "Org chart";

export async function render(root, ctx) {
  const { agents } = await api(`/api/companies/${ctx.companyId}/org`);
  const roots = agents.filter((agent) => !agent.reportsTo || !agents.some((entry) => entry.id === agent.reportsTo));

  const node = (agent) => {
    const reports = agents.filter((entry) => entry.reportsTo === agent.id);
    return `<div style="margin-bottom:10px">
      <div class="org-node" data-agent="${esc(agent.id)}" style="cursor:pointer">
        ${avatar(agent)}
        <div class="grow" style="min-width:0">
          <div class="row" style="gap:6px"><span style="font-weight:600;font-size:13px">${esc(agent.name)}</span><span class="status-dot ${agent.status}"></span></div>
          <div class="hint truncate">${esc(agent.title)} · ${agent.openIssues} open · ${money(agent.spend.spentCents, { precise: true })}</div>
        </div>
        ${modelPill(agent.model)}
      </div>
      ${reports.length ? `<div class="org-branch">${reports.map(node).join("")}</div>` : ""}
    </div>`;
  };

  const totalSpend = agents.reduce((sum, agent) => sum + agent.spend.spentCents, 0);
  const cap = agents.reduce((sum, agent) => sum + agent.spend.capCents, 0);
  const skills = agents.reduce((sum, agent) => sum + agent.skills, 0);

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Team",
      title: "Org chart",
      subtitle: `${agents.length} agents · ${agents.filter((agent) => !agent.reportsTo).length} top-level · ${skills} NVIDIA skills assigned`,
      actions: `<a class="btn ghost" href="#/agents">${icon("agents", "nav-icon")} Roster</a>`,
    })}

    <div class="grid" style="grid-template-columns:minmax(0,1.5fr) minmax(0,1fr)">
      <div class="card">
        <div class="card-title">Reporting lines</div>
        ${roots.map(node).join("") || `<div class="hint">No agents yet.</div>`}
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-title">Roster economics</div>
          <div class="kv"><span class="k">Agents</span><span class="v">${agents.length}</span></div>
          <div class="kv"><span class="k">Active</span><span class="v">${agents.filter((agent) => agent.status === "active").length}</span></div>
          <div class="kv"><span class="k">Combined spend</span><span class="v">${money(totalSpend, { precise: true })}</span></div>
          <div class="kv"><span class="k">Combined cap</span><span class="v">${money(cap)}</span></div>
          <div class="kv"><span class="k">Open issues</span><span class="v">${agents.reduce((sum, agent) => sum + agent.openIssues, 0)}</span></div>
          <div class="kv"><span class="k">Skills assigned</span><span class="v">${skills}</span></div>
        </div>
        <div class="card">
          <div class="card-title">Roles</div>
          ${["strategist", "operator", "analyst", "critic"]
            .map((role) => {
              const count = agents.filter((agent) => agent.role === role).length;
              return `<div class="kv"><span class="k">${esc(role)}</span><span class="v">${count}</span></div>`;
            })
            .join("")}
        </div>
        <div class="card">
          <div class="card-title">Models in use</div>
          ${[...new Set(agents.map((agent) => agent.model))]
            .map((model) => `<div class="kv"><span class="k mono" style="font-size:10.5px">${esc(model.split("/").pop())}</span><span class="v">${agents.filter((agent) => agent.model === model).length}</span></div>`)
            .join("")}
        </div>
      </div>
    </div>
  `;

  const open = (event) => {
    const id = event.target.closest("[data-agent]")?.dataset.agent;
    if (id) ctx.navigate(`/agents/${id}`);
  };
  root.addEventListener("click", open);
  return () => root.removeEventListener("click", open);
}
