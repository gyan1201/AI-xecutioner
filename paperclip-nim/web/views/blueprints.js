import { api, debounce, esc, icon, num, openDrawer, toast } from "../lib.js";
import { pageHeader } from "./shared.js";

export const title = "Blueprints";

const FUNCTION_LABELS = {
  chat: "chat",
  reasoning: "reasoning",
  tools: "tools",
  vision: "vision",
  embedding: "embed",
  rerank: "rerank",
  image: "image",
  video: "video",
  safety: "safety",
  parse: "parse",
  translate: "translate",
  protein: "protein",
  reward: "reward",
  code: "code",
  pose: "pose",
  tabular: "tabular",
};

export async function render(root, ctx) {
  const category = ctx.query.category ?? "";
  const query = ctx.query.q ?? "";
  const params = new URLSearchParams();
  if (category) params.set("category", category);
  if (query) params.set("q", query);
  const data = await api(`/api/blueprints?${params}`);
  const company = ctx.company;

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "NVIDIA NIM",
      title: "Blueprints",
      subtitle: `${data.stats.count} reference architectures from build.nvidia.com, localised into teams you can deploy onto this board. Each one names the NIM endpoints it uses.`,
      actions: `<button class="btn ghost" data-action="catalog">${icon("external", "nav-icon")} build.nvidia.com/blueprints</button>`,
    })}

    <div class="card" style="margin-bottom:14px">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <input class="input" id="bp-search" style="max-width:300px" placeholder="Search blueprints…" value="${esc(query)}" />
        <span class="grow"></span>
        <span class="hint">${data.blueprints.length} shown</span>
      </div>
      <div class="chips" style="margin-top:10px">
        <button class="chip ${!category ? "on" : ""}" data-category="">All</button>
        ${data.stats.categories.map((entry) => `<button class="chip ${category === entry ? "on" : ""}" data-category="${esc(entry)}">${esc(entry)}</button>`).join("")}
      </div>
    </div>

    <div class="tile-grid">
      ${data.blueprints
        .map(
          (blueprint) => `<div class="tile" data-blueprint="${esc(blueprint.id)}">
            <div class="row" style="gap:6px"><span class="tag on">${esc(blueprint.category)}</span><span class="tag">${esc(blueprint.industry)}</span></div>
            <h3>${esc(blueprint.name)}</h3>
            <p>${esc(blueprint.summary)}</p>
            <div class="tile-foot">
              ${blueprint.functions.slice(0, 4).map((fn) => `<span class="tag">${esc(FUNCTION_LABELS[fn] ?? fn)}</span>`).join("")}
              ${blueprint.functions.length > 4 ? `<span class="tag">+${blueprint.functions.length - 4}</span>` : ""}
              <span class="grow"></span>
              <span class="hint">${blueprint.team.length} agents</span>
            </div>
          </div>`,
        )
        .join("") || `<div class="hint">No blueprints matched.</div>`}
    </div>
  `;

  root.querySelector("#bp-search")?.addEventListener(
    "input",
    debounce((event) => {
      const next = new URLSearchParams();
      if (event.target.value) next.set("q", event.target.value);
      if (category) next.set("category", category);
      location.hash = `/blueprints${next.toString() ? `?${next}` : ""}`;
    }, 300),
  );
  root.querySelectorAll("[data-category]").forEach((chip) =>
    chip.addEventListener("click", () => {
      const next = new URLSearchParams();
      if (query) next.set("q", query);
      if (chip.dataset.category) next.set("category", chip.dataset.category);
      location.hash = `/blueprints${next.toString() ? `?${next}` : ""}`;
    }),
  );
  root.querySelector('[data-action="catalog"]')?.addEventListener("click", () => window.open("https://build.nvidia.com/blueprints", "_blank", "noreferrer"));

  root.querySelectorAll("[data-blueprint]").forEach((tile) =>
    tile.addEventListener("click", () => showBlueprint(ctx, tile.dataset.blueprint, root)),
  );
}

async function showBlueprint(ctx, id, root) {
  const { blueprint } = await api(`/api/blueprints/${encodeURIComponent(id)}`);
  const company = ctx.company;
  openDrawer({
    title: blueprint.name,
    subtitle: `${blueprint.category} · ${blueprint.industry}`,
    body: `
      <div class="stack">
        <div class="prose" style="font-size:13px">${esc(blueprint.summary)}</div>

        <div>
          <div class="card-title">NIM endpoints used</div>
          <div class="chips">${blueprint.functions.map((fn) => `<span class="tag on">${esc(fn)}</span>`).join("")}</div>
        </div>

        <div>
          <div class="card-title">Team</div>
          <div class="stack" style="gap:6px">
            ${blueprint.team
              .map(
                (member) => `<div class="row-between" style="border:1px solid var(--border);border-radius:7px;padding:8px 10px">
                  <div><div style="font-size:12.5px;font-weight:500">${esc(member.name)}</div><div class="hint">${esc(member.title)} · ${esc(member.role)}</div></div>
                  <span class="mono hint" style="font-size:10px">${esc(member.model.split("/").pop())}</span>
                </div>`,
              )
              .join("")}
          </div>
        </div>

        <div>
          <div class="card-title">Pipeline</div>
          <div class="trace">
            ${blueprint.steps
              .map((step, index) => `<div class="trace-step"><span class="trace-index">${index + 1}</span><div class="grow"><div class="trace-label">${esc(step)}</div></div></div>`)
              .join("")}
          </div>
        </div>

        <div>
          <div class="card-title">Backlog created on deploy</div>
          <div class="stack" style="gap:5px">
            ${blueprint.backlog
              .map(
                (item) => `<div class="row" style="gap:7px;font-size:12.2px"><span class="pill ${item.priority === "high" ? "amber" : ""}">${esc(item.priority)}</span>${esc(item.title)}</div>`,
              )
              .join("")}
          </div>
        </div>

        <div class="card" style="border-color:var(--accent-border);background:rgba(118,185,0,.04)">
          <div class="card-title">Deploy into ${esc(company.name)}</div>
          <p class="hint" style="margin-bottom:9px">Adds ${blueprint.team.length} agents, a goal and ${blueprint.backlog.length} issues to the board. Nothing runs until you press go.</p>
          <button class="btn primary block" data-deploy="${esc(blueprint.id)}">${icon("play", "nav-icon")} Deploy team & backlog</button>
          <label class="chips" style="margin-top:9px;font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:7px">
            <input type="checkbox" id="deploy-run" /> Run the first issue immediately after deploying
          </label>
        </div>
      </div>
    `,
  });

  document.querySelector("[data-deploy]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const runFirst = document.querySelector("#deploy-run")?.checked;
    button.disabled = true;
    button.textContent = "Deploying…";
    try {
      const result = await api(`/api/companies/${ctx.companyId}/blueprints/${blueprint.id}`, { method: "POST" });
      await ctx.refresh(true);
      toast(`${blueprint.name}: ${result.agents} agents, ${result.issues} issues`);
      if (runFirst) {
        const newIssue = (result.company.issues ?? []).find((issue) => issue.source === `blueprint:${blueprint.id}`);
        if (newIssue) {
          const { stream } = await import("../lib.js");
          toast(`Running ${newIssue.key}…`);
          await stream(`/api/companies/${ctx.companyId}/issues/${newIssue.id}/run?stream=1`, {}, {});
          await ctx.refresh(true);
        }
      }
      document.querySelector("#drawer-root")?.click();
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Deploy team & backlog";
    }
  });
}
