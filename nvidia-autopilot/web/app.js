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

const KEY_PROMPT_FLAG = "nvidia-autopilot.key-prompt-dismissed";

/**
 * If the key database is empty, ask once — the app runs in simulation until a
 * key exists, and saying so beats silently simulating for hours.
 */
function maybeAskForKey() {
  const config = state.status?.config;
  if (!config) return;
  if (config.hasApiKey || config.keys?.count > 0) return;
  if (localStorage.getItem(KEY_PROMPT_FLAG) === "1") return;
  if (document.getElementById("key-veil")) return;
  if (location.hash.includes("/settings")) return;

  const veil = document.createElement("div");
  veil.className = "modal-veil";
  veil.id = "key-veil";
  veil.innerHTML = `
    <div class="modal modal-sm card">
      <div class="card-head">
        <span class="card-title">No NVIDIA API key in the database</span>
        <span class="badge badge-amber">simulation</span>
      </div>
      <div class="modal-body stack">
        <p class="small muted">
          Everything runs without a key, but inference is simulated. Paste your key — or the whole python /
          curl snippet that contains it — and it is stored in <code>data/keys.json</code> (mode 0600) and used in
          the background from now on.
        </p>
        <div class="field">
          <label for="key-prompt-text">Key, env line, or request snippet</label>
          <textarea id="key-prompt-text" rows="5" spellcheck="false" placeholder="nvapi-…&#10;&#10;— or —&#10;export NVIDIA_API_KEY=nvapi-…&#10;&#10;— or the whole snippet —"></textarea>
        </div>
        <div id="key-prompt-result"></div>
        <div class="row-wrap">
          <button class="btn btn-primary" id="key-prompt-save">Store &amp; connect</button>
          <button class="btn btn-ghost" id="key-prompt-settings">Open settings</button>
          <button class="btn btn-ghost btn-sm" id="key-prompt-later">Not now</button>
        </div>
        <p class="tiny faint">Dismissing asks again next launch. The key is never sent to the browser again — only <code>••••1234</code>.</p>
      </div>
    </div>`;
  document.body.appendChild(veil);

  const close = (remember) => {
    if (remember) localStorage.setItem(KEY_PROMPT_FLAG, "1");
    veil.remove();
  };

  veil.querySelector("#key-prompt-later").addEventListener("click", () => close(true));
  veil.querySelector("#key-prompt-settings").addEventListener("click", () => {
    close(false);
    navigate("/settings");
  });
  veil.querySelector("#key-prompt-save").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const text = veil.querySelector("#key-prompt-text").value.trim();
    const result = veil.querySelector("#key-prompt-result");
    if (!text) {
      result.innerHTML = `<div class="banner"><span>◐</span><div>Paste a key first.</div></div>`;
      return;
    }
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> storing`;
    try {
      const stored = await api.post("/api/keys", { text, timeoutMs: 12_000 });
      const verification = stored.verification ?? {};
      if (verification.ok) {
        result.innerHTML = `<div class="banner green"><span>✓</span><div><strong>Stored and verified.</strong> ${verification.modelCount} models available — switching to live inference.</div></div>`;
        setTimeout(() => location.reload(), 900);
      } else if (verification.reason === "unreachable") {
        result.innerHTML = `<div class="banner"><span>◐</span><div><strong>Stored.</strong> This host cannot reach NVIDIA, so simulation stays on until it can.</div></div>`;
        await refreshStatus();
        setTimeout(() => close(false), 1400);
      } else {
        result.innerHTML = `<div class="banner red"><span>✕</span><div><strong>Stored, but not accepted.</strong> ${verification.hint ?? verification.reason ?? ""}</div></div>`;
      }
    } catch (error) {
      result.innerHTML = `<div class="banner red"><span>✕</span><div>${esc(error.message)}${error.hint ? ` ${esc(error.hint)}` : ""}</div></div>`;
    } finally {
      button.disabled = false;
      button.textContent = "Store & connect";
    }
  });
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
  refreshStatus().then(() => maybeAskForKey());
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
