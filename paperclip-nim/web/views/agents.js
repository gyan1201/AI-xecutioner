import { api, avatar, esc, icon, modal, toast } from "../lib.js";
import { modelPill, pageHeader, spendBar } from "./shared.js";

export const title = "Agents";

export async function render(root, ctx) {
  const { agents } = await api(`/api/companies/${ctx.companyId}/agents`);
  const company = ctx.company;
  const models = (ctx.state.models ?? []).slice(0, 400);

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "Team",
      title: "Agents",
      subtitle: `${agents.length} on the roster · ${agents.filter((agent) => agent.status === "active").length} enabled · every agent runs on a NVIDIA NIM model`,
      actions: `<button class="btn primary" data-action="hire">${icon("plus", "nav-icon")} Hire agent</button>`,
    })}

    <div class="tile-grid">
      ${agents
        .map(
          (agent) => `
        <div class="card card-hover" data-agent="${esc(agent.id)}" style="cursor:pointer;display:flex;flex-direction:column;gap:11px">
          <div class="row" style="gap:10px">
            ${avatar(agent, "lg")}
            <div class="grow" style="min-width:0">
              <div class="row" style="gap:6px">
                <span style="font-weight:600;font-size:13.5px">${esc(agent.name)}</span>
                <span class="status-dot ${agent.status}" title="${esc(agent.status)}"></span>
              </div>
              <div class="hint truncate">${esc(agent.title)} · ${esc(agent.role)}</div>
            </div>
            <span class="pill">${agent.openIssues ?? 0} open</span>
          </div>
          <div class="hint" style="min-height:32px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(agent.description || "No remit written yet.")}</div>
          <div class="row" style="gap:5px;flex-wrap:wrap">${modelPill(agent.model)}<span class="tag">${agent.skills?.length ?? 0} skills</span></div>
          ${spendBar(agent.spend, { compact: true })}
        </div>`,
        )
        .join("")}
    </div>
  `;

  const open = (event) => {
    const id = event.target.closest("[data-agent]")?.dataset.agent;
    if (id) ctx.navigate(`/agents/${id}`);
  };
  root.addEventListener("click", open);

  root.querySelector('[data-action="hire"]').addEventListener("click", () => hireModal(ctx, models));

  return () => root.removeEventListener("click", open);
}

function hireModal(ctx, models) {
  const company = ctx.company;
  const agentOptions = company.agents.map((agent) => `<option value="${esc(agent.id)}">${esc(agent.name)}</option>`).join("");
  const modelOptions = (models.length ? models : [{ id: "nvidia/nemotron-3-super-120b-a12b", name: "Nemotron 3 Super", family: "Nemotron" }])
    .map((model) => `<option value="${esc(model.id)}">${esc(model.name)} · ${esc(model.family)}</option>`)
    .join("");
  modal({
    title: "Hire an agent",
    wide: true,
    submitLabel: "Add to roster",
    body: `
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="field"><label>Name</label><input class="input" name="name" required placeholder="e.g. Maya Rao" /></div>
        <div class="field"><label>Title</label><input class="input" name="title" placeholder="e.g. Staff Engineer" /></div>
      </div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="field"><label>Role</label><select class="select" name="role">
          <option value="operator">Operator — does the work</option>
          <option value="analyst">Analyst — researches and grounds</option>
          <option value="critic">Critic — reviews work</option>
          <option value="strategist">Strategist — plans cycles</option>
        </select></div>
        <div class="field"><label>Reports to</label><select class="select" name="reportsTo"><option value="">Nobody</option>${agentOptions}</select></div>
      </div>
      <div class="field"><label>Model</label><select class="select" name="model">${modelOptions}</select></div>
      <div class="field"><label>Remit</label><textarea class="textarea" name="description" placeholder="What this agent owns, and what good looks like."></textarea></div>
      <div class="field"><label>Instructions</label><textarea class="textarea" name="instructions" placeholder="How this agent should behave: format, constraints, evidence rules."></textarea></div>
      <div class="field"><label>Monthly budget (cents)</label><input class="input" type="number" name="monthlyBudgetCents" value="200" min="0" step="50" /><div class="hint">$2.00/month. Agents stop running when they hit the cap.</div></div>
      <div class="field"><label>Capabilities</label>
        <div class="chips" id="cap-chips">
          ${["chat", "tools", "vision", "embedding", "rerank", "image", "safety", "parse", "translate", "code"]
            .map((cap) => `<button type="button" class="chip ${["chat", "tools"].includes(cap) ? "on" : ""}" data-cap="${cap}">${cap}</button>`)
            .join("")}
        </div>
      </div>
    `,
    async onSubmit(data) {
      const capabilities = [...document.querySelectorAll("#cap-chips .chip.on")].map((chip) => chip.dataset.cap);
      const agent = await api(`/api/companies/${ctx.companyId}/agents`, { method: "POST", body: { ...data, capabilities } });
      await ctx.refresh(true);
      toast(`${agent.agent.name} hired`);
      ctx.navigate(`/agents/${agent.agent.id}`);
    },
  });
  document.querySelectorAll("#cap-chips .chip").forEach((chip) =>
    chip.addEventListener("click", () => chip.classList.toggle("on")),
  );
}
