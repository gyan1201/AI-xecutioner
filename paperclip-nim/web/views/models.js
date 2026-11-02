import { api, debounce, esc, icon, money, num, openDrawer, toast } from "../lib.js";
import { pageHeader } from "./shared.js";
import { connectCard, openSetupModal } from "./provider-setup.js";

export const title = "Models";

const CAP_ORDER = ["chat", "reasoning", "tools", "code", "vision", "embedding", "rerank", "image", "video", "safety", "parse", "translate", "protein", "reward", "pose", "tabular"];
const CAP_LETTER = { chat: "C", reasoning: "R", tools: "T", code: "O", vision: "V", embedding: "E", rerank: "K", image: "I", video: "D", safety: "S", parse: "P", translate: "X", protein: "B", reward: "W", pose: "Z", tabular: "U" };

export async function render(root, ctx) {
  const query = ctx.query.q ?? "";
  const capability = ctx.query.capability ?? "";
  const family = ctx.query.family ?? "";
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (capability) params.set("capability", capability);
  if (family) params.set("family", family);
  const [data, providerData] = await Promise.all([api(`/api/models?${params}`), api("/api/providers")]);
  ctx.state.models = data.models;
  ctx.state.providers = providerData.providers;
  ctx.state.providerCatalog = providerData.available;

  root.innerHTML = `
    ${pageHeader({
      eyebrow: "NVIDIA NIM",
      title: "Models",
      subtitle: `${data.summary.total} models in the catalog · ${data.live ? `synced live from <span class="mono">/v1/models</span> ${data.syncedAt ? new Date(data.syncedAt).toLocaleTimeString() : ""}` : "offline snapshot — refresh to merge the live /v1/models list"}`,
      actions: `<button class="btn ghost" data-action="refresh">${icon("activity", "nav-icon")} Sync live catalog</button>`,
    })}

    ${connectCard({
      providers: providerData.providers,
      nvidia: { configured: data.nvidiaUnlocked, models: data.catalogTotal ?? data.summary.total, live: providerData.config?.mode === "live" },
    })}

    ${data.error ? `<div class="card" style="border-color:rgba(227,179,65,.3);margin-bottom:14px"><div class="row" style="gap:8px;color:var(--amber-text);font-size:12.5px">${icon("shield", "nav-icon")}<b>Live sync unavailable</b><span style="color:var(--text-2)">${esc(data.error)} — showing the curated snapshot.</span></div></div>` : ""}

    <div class="card" style="margin-bottom:14px">
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <input class="input" id="model-search" style="max-width:300px" placeholder="Search model, family, capability…" value="${esc(query)}" />
        <select class="select" id="family-filter" style="max-width:190px">
          <option value="">All families</option>
          ${data.summary.families.map((entry) => `<option value="${esc(entry.name)}" ${family === entry.name ? "selected" : ""}>${esc(entry.name)} (${entry.count})</option>`).join("")}
        </select>
        <span class="grow"></span>
        <span class="hint">${num(data.models.length)} matching · ${num(data.summary.total)} total</span>
      </div>
      <div class="chips" style="margin-top:10px">
        <button class="chip ${!capability ? "on" : ""}" data-cap="">All capabilities</button>
        ${CAP_ORDER.filter((cap) => data.summary.capabilities[cap])
          .map((cap) => `<button class="chip ${capability === cap ? "on" : ""}" data-cap="${cap}">${esc(CAP_LETTER[cap])} · ${esc(cap)} <span class="dim">${data.summary.capabilities[cap]}</span></button>`)
          .join("")}
      </div>
    </div>

    <div class="card pad-0" style="overflow:hidden">
      <div class="model-row head">
        <span>Model</span><span>Family</span><span>Capabilities</span><span>Context</span><span style="text-align:right">$/1M</span>
      </div>
      <div style="max-height:640px;overflow-y:auto" id="model-list">
        ${data.models
          .map(
            (model) => `<div class="model-row" data-model="${esc(model.id)}" style="cursor:pointer">
              <div style="min-width:0">
                <div class="model-name">${esc(model.name)} ${model.status === "not-in-account" ? `<span class="pill" title="Not returned by /v1/models for this account">hidden</span>` : ""}</div>
                <div class="model-id">${esc(model.id)}</div>
              </div>
              <span class="hint">${esc(model.family)}${model.providerName ? ` <span class="pill" title="${esc(model.baseUrl ?? "")}">${esc(model.providerName)}</span>` : ""}</span>
              <div class="cap-dots">${model.capabilities.map((cap) => `<span class="cap-dot on" title="${esc(cap)}">${esc(CAP_LETTER[cap] ?? "?")}</span>`).join("")}</div>
              <span class="mono hint">${model.contextK ? `${model.contextK}k` : "—"}</span>
              <span class="mono hint" style="text-align:right">${model.rate?.in != null ? `$${model.rate.in}/$${model.rate.out ?? 0}` : "—"}</span>
            </div>`,
          )
          .join("")}
      </div>
    </div>

    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr));margin-top:16px">
      ${Object.entries(data.capabilities)
        .slice(0, 8)
        .map(
          ([key, meta]) => `<div class="card tight">
            <div class="row" style="gap:7px"><span class="cap-dot on">${esc(CAP_LETTER[key] ?? "?")}</span><b style="font-size:12.5px">${esc(meta.label)}</b><span class="tag mono">${esc(meta.endpoint)}</span></div>
            <div class="hint" style="margin-top:6px">${esc(meta.blurb)}</div>
          </div>`,
        )
        .join("")}
    </div>
  `;

  const update = (patch) => {
    const next = new URLSearchParams(location.hash.split("?")[1] ?? "");
    for (const [key, value] of Object.entries(patch)) {
      if (!value) next.delete(key);
      else next.set(key, value);
    }
    location.hash = `/models${next.toString() ? `?${next}` : ""}`;
  };

  root.querySelector("#model-search")?.addEventListener("input", debounce((event) => update({ q: event.target.value }), 320));
  root.querySelector("#family-filter")?.addEventListener("change", (event) => update({ family: event.target.value }));
  root.querySelectorAll("[data-cap]").forEach((chip) => chip.addEventListener("click", () => update({ capability: chip.dataset.cap })));

  root.querySelector('[data-action="open-setup"]')?.addEventListener("click", () =>
    openSetupModal({
      available: ctx.state.providerCatalog ?? [],
      providers: ctx.state.providers ?? [],
      onChanged: async () => {
        await render(root, ctx);
        toast("Configuration saved — models updated", "ok");
      },
    }),
  );

  root.querySelector('[data-action="refresh"]')?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Syncing…";
    try {
      const result = await api("/api/models/refresh", { method: "POST" });
      toast(result.live ? `Synced ${result.count} models from NIM` : `Snapshot only — ${result.error ?? "no key"}`, result.live ? "ok" : "warn");
      render(root, ctx);
    } catch (error) {
      toast(error.message, "error");
      button.disabled = false;
      button.textContent = "Sync live catalog";
    }
  });

  root.querySelectorAll("[data-model]").forEach((row) => row.addEventListener("click", () => showModel(ctx, row.dataset.model, root)));
}

function showModel(ctx, modelId, root) {
  const model = (ctx.state.models ?? []).find((entry) => entry.id === modelId);
  if (!model) return;
  openDrawer({
    title: model.name,
    subtitle: model.id,
    body: `
      <div class="stack">
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <span class="pill accent">${esc(model.family)}</span>
          ${model.verified ? `<span class="pill green">verified live</span>` : `<span class="pill">snapshot</span>`}
          ${model.capabilities.map((cap) => `<span class="tag on">${esc(cap)}</span>`).join("")}
        </div>
        <div class="prose" style="font-size:13px">${esc(model.note || "No notes.")}</div>
        <div class="card tight">
          <div class="kv"><span class="k">Endpoint</span><span class="v mono">${esc(endpointFor(model))}</span></div>
          <div class="kv"><span class="k">Context</span><span class="v">${model.contextK ? `${model.contextK}k tokens` : "—"}</span></div>
          <div class="kv"><span class="k">Rate (in/out)</span><span class="v mono">$${model.rate?.in ?? 0} / $${model.rate?.out ?? 0} per 1M</span></div>
          <div class="kv"><span class="k">Vendor</span><span class="v">${esc(model.vendor)}</span></div>
          <div class="kv"><span class="k">Provider</span><span class="v">${esc(model.providerName ?? "NVIDIA NIM (default)")}</span></div>
          <div class="kv"><span class="k">Source</span><span class="v">${esc(model.source)}</span></div>
          ${model.baseUrl ? `<div class="kv"><span class="k">Base URL</span><span class="v mono" style="font-size:11px;word-break:break-all">${esc(model.baseUrl)}</span></div>` : ""}
        </div>
        <div class="row" style="gap:7px;flex-wrap:wrap">
          <button class="btn primary sm" data-probe="${esc(model.id)}">Probe with a real call</button>
          <a class="btn sm ghost" href="#/studio?model=${encodeURIComponent(model.id)}">Open in studio →</a>
          <button class="btn sm ghost" data-add-key="${esc(model.providerId ?? "nvidia")}">${icon("terminal", "nav-icon")} Add a key for ${esc(model.providerName ?? "NVIDIA")}</button>
        </div>
        <div id="probe-result"></div>
      </div>
    `,
  });
  document.querySelector("[data-add-key]")?.addEventListener("click", (event) => {
    openSetupModal({
      available: ctx.state.providerCatalog ?? [],
      providers: ctx.state.providers ?? [],
      onChanged: async () => {
        if (root) await render(root, ctx);
        toast("Configuration saved", "ok");
      },
    });
    event.currentTarget.blur();
  });

  document.querySelector("[data-probe]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = "Probing…";
    const target = document.querySelector("#probe-result");
    try {
      const result = await api("/api/models/probe", { method: "POST", body: { model: model.id } });
      target.innerHTML = `<div class="card tight"><div class="row" style="gap:7px"><span class="pill ${result.ok ? "green" : "red"}">${result.ok ? "ok" : "failed"}</span><span class="hint">${result.latencyMs}ms</span></div><div class="hint" style="margin-top:6px">${esc(result.ok ? `sample: “${result.sample}”` : result.error)}</div></div>`;
    } catch (error) {
      target.innerHTML = `<div class="hint" style="color:var(--red)">${esc(error.message)}</div>`;
    } finally {
      button.disabled = false;
      button.textContent = "Probe with a real call";
    }
  });
}

function endpointFor(model) {
  if (model.capabilities.includes("embedding")) return "/v1/embeddings";
  if (model.capabilities.includes("rerank")) return "/v1/ranking";
  if (model.capabilities.includes("image") || model.capabilities.includes("video")) return `/v1/genai/${model.id}`;
  if (model.capabilities.includes("protein")) return "/v1/biology/*";
  return "/v1/chat/completions";
}
