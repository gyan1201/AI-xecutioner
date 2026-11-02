import { api, esc, reportError, toast } from "../lib.js";

const CAPABILITIES = ["all", "chat", "reasoning", "tool_use", "vision", "embedding", "rerank", "safety", "image", "code"];

export async function render(el, ctx) {
  const [catalog, settings] = await Promise.all([
    api.get("/api/models"),
    api.get("/api/settings").catch(() => ({ roleOverrides: {} })),
  ]);
  let filter = "all";
  let query = "";
  let overrides = { ...(settings.roleOverrides ?? {}) };

  const roleEntries = Object.entries(catalog.roles ?? {});

  el.innerHTML = `
    <div class="spread" style="margin-bottom:var(--space-4)">
      <div>
        <h1 style="font-size:26px">Models & routing</h1>
        <p class="muted small" style="margin-top:6px">
          ${catalog.models.length} models discovered from ${esc(ctx.state.status?.config?.nimBaseUrl ?? "build.nvidia.com")}.
          ${catalog.degraded ? '<span class="badge badge-amber">degraded — curated catalog in use</span>' : ""}
          ${catalog.simulated ? '<span class="badge badge-amber">simulated catalog</span>' : ""}
        </p>
      </div>
      <button class="btn btn-sm" id="discover">Refresh catalog</button>
    </div>

    <div class="card" style="margin-bottom:var(--space-4)">
      <div class="card-head">
        <span class="card-title">Agent routing</span>
        <div class="row">
          <button class="btn btn-sm btn-ghost" id="reset-roles">Reset to discovered</button>
          <button class="btn btn-sm btn-primary" id="save-roles">Save routing</button>
        </div>
      </div>
      <p class="small muted" style="margin-bottom:var(--space-3)">
        Each agent role resolves to the first pinned model that exists in the live catalog. Override any role below; overrides apply to new autopilot runs and the chat lab defaults.
      </p>
      <div class="grid grid-2">
        ${roleEntries
          .map(([role, entry]) => {
            const candidates = catalog.models.filter((model) => model.capabilities.includes(entry.capability));
            const list = candidates.length ? candidates : catalog.models;
            const selected = overrides[role] ?? entry.model;
            return `<div class="field">
              <label for="role-${esc(role)}">
                ${esc(entry.label)} <span class="faint">· ${esc(entry.capability)}</span>
                ${entry.resolvedFrom === "operator" ? '<span class="badge badge-violet">pinned</span>' : ""}
              </label>
              <select id="role-${esc(role)}" data-role="${esc(role)}">
                ${list.map((model) => `<option value="${esc(model.id)}" ${model.id === selected ? "selected" : ""}>${esc(model.id)}</option>`).join("")}
                ${list.some((model) => model.id === selected) ? "" : `<option value="${esc(selected)}" selected>${esc(selected)}</option>`}
              </select>
              <span class="tiny faint">${esc(entry.description ?? "")}</span>
            </div>`;
          })
          .join("")}
      </div>
    </div>

    <div class="card">
      <div class="card-head">
        <span class="card-title">Catalog</span>
        <input id="search" placeholder="Filter by id or publisher…" style="max-width:280px" />
      </div>
      <div class="chips" style="margin-bottom:var(--space-3)">
        ${CAPABILITIES.map((capability) => `<button class="chip ${capability === "all" ? "active" : ""}" data-capability="${capability}">${esc(capability.replace("_", " "))}</button>`).join("")}
      </div>
      <div class="grid grid-3" id="models"></div>
    </div>
  `;

  function paintModels() {
    const host = el.querySelector("#models");
    const filtered = catalog.models.filter((model) => {
      const matchesFilter = filter === "all" || model.capabilities.includes(filter);
      const matchesQuery = !query || `${model.id} ${model.publisher}`.toLowerCase().includes(query);
      return matchesFilter && matchesQuery;
    });
    host.innerHTML = filtered.length
      ? filtered
          .map(
            (model) => `<div class="model-card">
              <span class="publisher">${esc(model.publisher)}${model.curated ? ' · <span class="badge badge-green tiny">curated</span>' : ""}</span>
              <span class="id">${esc(model.id)}</span>
              <div class="chips">
                ${model.capabilities.map((capability) => `<span class="chip">${esc(capability.replace("_", " "))}</span>`).join("")}
                ${model.contextWindow ? `<span class="chip">${Math.round(model.contextWindow / 1000)}k ctx</span>` : ""}
              </div>
            </div>`,
          )
          .join("")
      : `<div class="empty" style="grid-column:1/-1"><h3>No models match</h3><p class="small">Try another capability or clear the filter.</p></div>`;
  }

  el.querySelectorAll("[data-capability]").forEach((chip) => {
    chip.addEventListener("click", () => {
      filter = chip.dataset.capability;
      el.querySelectorAll("[data-capability]").forEach((node) => node.classList.toggle("active", node === chip));
      paintModels();
    });
  });

  el.querySelector("#search").addEventListener("input", (event) => {
    query = event.target.value.trim().toLowerCase();
    paintModels();
  });

  el.querySelector("#save-roles").addEventListener("click", async () => {
    try {
      await api.put("/api/settings", { roleOverrides: overrides });
      toast("Routing saved");
      await ctx.refresh();
    } catch (error) {
      reportError(error);
    }
  });

  el.querySelector("#reset-roles").addEventListener("click", async () => {
    overrides = {};
    try {
      await api.put("/api/settings", { roleOverrides: {} });
      toast("Routing reset to discovered models");
      location.reload();
    } catch (error) {
      reportError(error);
    }
  });

  el.querySelector("#discover").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>`;
    try {
      await api.get("/api/models?refresh=1");
      toast("Catalog refreshed");
      location.reload();
    } catch (error) {
      reportError(error);
      button.disabled = false;
      button.textContent = "Refresh catalog";
    }
  });

  el.querySelectorAll("[data-role]").forEach((select) => {
    select.addEventListener("change", () => {
      overrides[select.dataset.role] = select.value;
    });
  });

  paintModels();
}
