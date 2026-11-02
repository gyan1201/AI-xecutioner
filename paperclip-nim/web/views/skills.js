import { api, debounce, esc, icon, num, openDrawer, toast } from "../lib.js";
import { pageHeader } from "./shared.js";

export const title = "Skills";

export async function render(root, ctx) {
  const query = ctx.query.q ?? "";
  const category = ctx.query.category ?? "";
  const limit = Number(ctx.query.limit ?? 48);
  const params = new URLSearchParams({ limit: String(limit) });
  if (query) params.set("q", query);
  if (category) params.set("category", category);
  const data = await api(`/api/skills?${params}`);
  const meta = data.meta;

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "NVIDIA NIM",
      title: "Skills",
      subtitle: `${num(meta.count)} NVIDIA-authored skills, snapshotted from <a href="${esc(meta.source ?? "#")}" target="_blank" rel="noreferrer">github.com/NVIDIA/skills</a>. Assign one to an agent and it becomes part of that agent's operating instructions.`,
      actions: `<button class="btn ghost" data-action="refresh">${icon("activity", "nav-icon")} Reload catalog</button>`,
    })}

    <div class="card" style="margin-bottom:14px">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <input class="input" id="skill-search" style="max-width:320px" placeholder="Search 430 skills — cuDF, RAG, DeepStream, Boltz2…" value="${esc(query)}" />
        <span class="grow"></span>
        <span class="hint">${num(data.total)} match${data.total === 1 ? "" : "es"} · synced ${meta.syncedAt ? new Date(meta.syncedAt).toLocaleDateString() : "—"}</span>
      </div>
      <div class="chips" style="margin-top:10px">
        <button class="chip ${!category ? "on" : ""}" data-category="">All</button>
        ${meta.categories
          .map((entry) => `<button class="chip ${category === entry ? "on" : ""}" data-category="${esc(entry)}">${esc(entry)} <span class="dim">${meta.byCategory?.[entry] ?? ""}</span></button>`)
          .join("")}
      </div>
    </div>

    <div class="tile-grid">
      ${data.items
        .map(
          (skill) => `<div class="tile" data-skill="${esc(skill.id)}">
            <div class="row" style="gap:6px"><span class="tag on">${esc(skill.category)}</span></div>
            <h3>${esc(skill.title)}</h3>
            <p>${esc(skill.description.slice(0, 190))}${skill.description.length > 190 ? "…" : ""}</p>
            <div class="tile-foot">
              ${skill.tags.slice(0, 3).map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}
              <span class="grow"></span>
              <span class="hint mono" style="font-size:10px">${esc(skill.id.slice(0, 22))}</span>
            </div>
          </div>`,
        )
        .join("") || `<div class="hint">No skills matched that search.</div>`}
    </div>

    ${data.items.length < data.total ? `<div style="text-align:center;margin-top:18px"><button class="btn" data-action="more">Load more (${num(data.total - data.items.length)} left)</button></div>` : ""}
  `;

  root.querySelector("#skill-search")?.addEventListener(
    "input",
    debounce((event) => {
      const next = new URLSearchParams();
      if (event.target.value) next.set("q", event.target.value);
      if (category) next.set("category", category);
      location.hash = `/skills${next.toString() ? `?${next}` : ""}`;
    }, 320),
  );

  root.querySelectorAll("[data-category]").forEach((chip) =>
    chip.addEventListener("click", () => {
      const next = new URLSearchParams();
      if (query) next.set("q", query);
      if (chip.dataset.category) next.set("category", chip.dataset.category);
      location.hash = `/skills${next.toString() ? `?${next}` : ""}`;
    }),
  );

  root.querySelector('[data-action="more"]')?.addEventListener("click", () => {
    const next = new URLSearchParams(location.hash.split("?")[1] ?? "");
    next.set("limit", String(limit + 48));
    location.hash = `/skills?${next}`;
  });

  root.querySelector('[data-action="refresh"]')?.addEventListener("click", async () => {
    try {
      const meta = await api("/api/skills/meta");
      ctx.toast(`${meta.count} skills in the catalog`);
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
    }
  });

  root.querySelectorAll("[data-skill]").forEach((tile) =>
    tile.addEventListener("click", () => showSkill(ctx, tile.dataset.skill, root)),
  );
}

async function showSkill(ctx, skillId, root) {
  const [{ skill }, { agents }] = await Promise.all([
    api(`/api/skills/${encodeURIComponent(skillId)}`),
    api(`/api/companies/${ctx.companyId}/agents`),
  ]);
  const company = ctx.company;
  openDrawer({
    title: skill.title,
    subtitle: `${skill.category} · ${skill.license}`,
    body: `
      <div class="stack">
        <div class="chips"><span class="tag on">${esc(skill.category)}</span>${skill.tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join("")}</div>
        <div class="prose" style="font-size:13px">${esc(skill.description)}</div>
        ${skill.summary ? `<div class="card tight"><div class="card-title">From the skill</div><div class="hint" style="font-size:12px;line-height:1.6">${esc(skill.summary)}</div></div>` : ""}
        <div class="field">
          <label>Assign to an agent</label>
          <div class="stack" style="gap:6px">
            ${agents
              .map(
                (agent) => `<div class="row-between" style="border:1px solid var(--border);border-radius:7px;padding:7px 9px">
                  <span class="row" style="gap:7px"><span class="avatar sm" style="background:${esc(agent.accent)}">${esc(agent.name.split(" ").map((part) => part[0]).join("").slice(0, 2))}</span><span style="font-size:12.5px">${esc(agent.name)}</span><span class="hint">${esc(agent.title)}</span></span>
                  ${agent.skills?.includes(skill.id)
                    ? `<span class="pill accent">assigned</span>`
                    : `<button class="btn sm" data-assign="${esc(agent.id)}">Assign</button>`}
                </div>`,
              )
              .join("")}
          </div>
        </div>
        <div class="row" style="gap:8px">
          <a class="btn sm ghost" href="${esc(skill.source)}" target="_blank" rel="noreferrer">${icon("external", "nav-icon")} Source on GitHub</a>
          <a class="btn sm ghost" href="https://build.nvidia.com/skills" target="_blank" rel="noreferrer">${icon("external", "nav-icon")} build.nvidia.com</a>
        </div>
      </div>
    `,
  });
  document.querySelectorAll("[data-assign]").forEach((button) =>
    button.addEventListener("click", async () => {
      const agent = agents.find((entry) => entry.id === button.dataset.assign);
      const skills = [...new Set([...(agent.skills ?? []), skill.id])].slice(0, 12);
      await api(`/api/companies/${ctx.companyId}/agents/${agent.id}/skills`, { method: "PUT", body: { skills } });
      await ctx.refresh(true);
      toast(`Skill assigned to ${agent.name}`);
      showSkill(ctx, skillId, root);
    }),
  );
}
