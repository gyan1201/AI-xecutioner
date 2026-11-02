import { api, reportError, esc } from "./lib.js";
import * as dashboard from "./views/dashboard.js";
import * as autopilot from "./views/autopilot.js";
import * as companies from "./views/companies.js";
import * as chat from "./views/chat.js";
import * as knowledge from "./views/knowledge.js";
import * as models from "./views/models.js";
import * as guardrails from "./views/guardrails.js";
import * as studio from "./views/studio.js";
import * as settings from "./views/settings.js";

const ROUTES = [
  { key: "dashboard", path: "/", title: "Mission control", glyph: "◉", view: dashboard },
  { key: "autopilot", path: "/autopilot", title: "Autopilot", glyph: "▶", view: autopilot },
  { key: "companies", path: "/companies", title: "Company OS", glyph: "⌂", view: companies },
  { key: "chat", path: "/chat", title: "Chat lab", glyph: "◍", view: chat },
  { key: "knowledge", path: "/knowledge", title: "Knowledge & RAG", glyph: "▤", view: knowledge },
  { key: "models", path: "/models", title: "Models & routing", glyph: "◈", view: models },
  { key: "guardrails", path: "/guardrails", title: "Guardrails", glyph: "⛨", view: guardrails },
  { key: "studio", path: "/studio", title: "Visual studio", glyph: "❖", view: studio },
  { key: "settings", path: "/settings", title: "Settings", glyph: "⚙", view: settings },
];

const state = {
  status: null,
  models: null,
  loading: true,
};

let cleanup = null;
let statusTimer = null;

const viewEl = document.getElementById("view");
const navEl = document.getElementById("nav");
const crumbEl = document.getElementById("crumb");

function currentRoute() {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [pathname, search = ""] = raw.split("?");
  const [pathPart, ...rest] = pathname.split("/").filter(Boolean);
  const key = pathPart || "dashboard";
  const route = ROUTES.find((entry) => entry.key === key) ?? ROUTES[0];
  return { route, params: rest, hash: raw, search };
}

function renderNav() {
  const active = currentRoute().route.key;
  const activeRuns = state.status?.runs?.active ?? 0;
  navEl.innerHTML = ROUTES.map(
    (entry) => `
      <a class="nav-item ${entry.key === active ? "active" : ""}" href="#${entry.path}">
        <span class="glyph">${entry.glyph}</span>
        <span>${esc(entry.title)}</span>
        ${entry.key === "autopilot" && activeRuns ? `<span class="nav-badge">${activeRuns}</span>` : ""}
      </a>`,
  ).join("");
}

function renderChrome() {
  const modeChip = document.getElementById("mode-chip");
  const modeLabel = document.getElementById("mode-label");
  const modelPill = document.getElementById("model-pill");
  const keyBtn = document.getElementById("key-btn");
  const nodeMeta = document.getElementById("node-meta");

  const config = state.status?.config;
  if (config) {
    if (config.simulation) {
      modeChip.className = "mode-chip sim";
      modeLabel.textContent = "simulation";
      keyBtn.textContent = "Connect NVIDIA key";
    } else {
      modeChip.className = "mode-chip live";
      modeLabel.textContent = `live · ${config.keyHint ?? ""}`;
      keyBtn.textContent = "Key connected";
    }
    const count = state.status?.modelCount ?? 0;
    modelPill.textContent = `${count} models${state.status?.modelsDegraded ? " (cached)" : ""}`;
    modelPill.title = state.status?.modelError ? `Discovery error: ${state.status.modelError}` : "Discovered from build.nvidia.com";
    nodeMeta.textContent = `node ${state.status?.node ?? ""} · ${state.status?.metrics?.calls ?? 0} model calls · ${state.status?.metrics?.errors ?? 0} errors`;
  }
  keyBtn.dataset.keyed = config?.hasApiKey ? "1" : "0";
}

export async function refreshStatus() {
  try {
    state.status = await api.get("/api/status");
  } catch (error) {
    state.status = null;
    reportError(error);
  }
  state.loading = false;
  renderChrome();
  renderNav();
  window.dispatchEvent(new CustomEvent("status:updated", { detail: state.status }));
}

function navigate(path) {
  if (location.hash === `#${path}`) return render();
  location.hash = `#${path}`;
}

function buildContext() {
  return {
    api,
    state,
    navigate,
    refresh: refreshStatus,
    params: currentRoute().params,
    search: currentRoute().search,
    setTitle(title) {
      crumbEl.textContent = title;
      document.title = `${title} · NVIDIA Autopilot`;
    },
  };
}

async function render() {
  const { route, params } = currentRoute();
  crumbEl.textContent = route.title;
  document.title = `${route.title} · NVIDIA Autopilot`;
  renderNav();
  if (typeof cleanup === "function") {
    try {
      cleanup();
    } catch {
      /* view cleanup must never block navigation */
    }
    cleanup = null;
  }
  viewEl.innerHTML = `<div class="card flat center"><span class="spinner"></span> <span class="muted small">loading ${esc(route.title)}…</span></div>`;
  try {
    const maybeCleanup = await route.view.render(viewEl, buildContext(), params);
    cleanup = typeof maybeCleanup === "function" ? maybeCleanup : null;
  } catch (error) {
    reportError(error);
    viewEl.innerHTML = `<div class="empty"><h3>This view failed to load</h3><p>${esc(error?.message ?? error)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
  }
  viewEl.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "instant" });
}

function boot() {
  renderNav();
  refreshStatus();
  render();
  statusTimer = setInterval(refreshStatus, 20_000);
  window.addEventListener("hashchange", render);
  const menuBtn = document.getElementById("menu-btn");
  const rail = document.getElementById("rail");
  menuBtn?.addEventListener("click", () => rail.classList.toggle("open"));
  navEl.addEventListener("click", () => rail.classList.remove("open"));
  document.getElementById("key-btn").addEventListener("click", (event) => {
    event.preventDefault();
    navigate("/settings");
  });
  window.addEventListener("beforeunload", () => clearInterval(statusTimer));
}

boot();
