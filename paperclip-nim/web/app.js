/**
 * Shell: routing, chrome, company switching, command palette and the live
 * event stream. Views get a context object and own their own DOM.
 */

import {
  $, api, avatar, closeDrawer, closeModal, debounce, esc, icon, loading, md, modal, money, openDrawer, stream, subscribeEvents, toast,
} from "./lib.js";

import * as dashboard from "./views/dashboard.js";
import * as inbox from "./views/inbox.js";
import * as issues from "./views/issues.js";
import * as issue from "./views/issue.js";
import * as agents from "./views/agents.js";
import * as agent from "./views/agent.js";
import * as org from "./views/org.js";
import * as goals from "./views/goals.js";
import * as projects from "./views/projects.js";
import * as routines from "./views/routines.js";
import * as approvals from "./views/approvals.js";
import * as budget from "./views/budget.js";
import * as activity from "./views/activity.js";
import * as knowledge from "./views/knowledge.js";
import * as skills from "./views/skills.js";
import * as blueprints from "./views/blueprints.js";
import * as models from "./views/models.js";
import * as studio from "./views/studio.js";
import * as settings from "./views/settings.js";

const ROUTES = [
  { key: "dashboard", label: "Dashboard", icon: "dashboard", section: "Work", view: dashboard },
  { key: "inbox", label: "Inbox", icon: "inbox", section: "Work", view: inbox },
  { key: "issues", label: "Issues", icon: "issues", section: "Work", view: issues },
  { key: "goals", label: "Goals", icon: "goals", section: "Work", view: goals },
  { key: "projects", label: "Projects", icon: "projects", section: "Work", view: projects },
  { key: "routines", label: "Routines", icon: "routines", section: "Work", view: routines },
  { key: "agents", label: "Agents", icon: "agents", section: "Team", view: agents },
  { key: "org", label: "Org chart", icon: "org", section: "Team", view: org },
  { key: "approvals", label: "Approvals", icon: "approvals", section: "Team", view: approvals },
  { key: "skills", label: "Skills", icon: "skills", section: "NVIDIA NIM", view: skills },
  { key: "blueprints", label: "Blueprints", icon: "blueprints", section: "NVIDIA NIM", view: blueprints },
  { key: "models", label: "Models", icon: "models", section: "NVIDIA NIM", view: models },
  { key: "studio", label: "Studio", icon: "studio", section: "NVIDIA NIM", view: studio },
  { key: "knowledge", label: "Knowledge", icon: "knowledge", section: "NVIDIA NIM", view: knowledge },
  { key: "budget", label: "Spend", icon: "budget", section: "Company", view: budget },
  { key: "activity", label: "Activity", icon: "activity", section: "Company", view: activity },
  { key: "settings", label: "Settings", icon: "settings", section: "Company", view: settings },
];

const state = {
  bootstrap: null,
  companyId: null,
  company: null,
  route: null,
  running: false,
  eventHandlers: new Set(),
  cleanup: null,
  lastRefresh: 0,
};

const viewEl = $("#view");
const navEl = $("#nav");
const crumbsEl = $("#crumbs");
const sidebarFoot = $("#sidebar-foot");
const modeChip = $("#mode-chip");

const navigate = (path) => {
  if (location.hash === `#${path}`) render();
  else location.hash = path;
};

const context = {
  state,
  api,
  navigate,
  stream,
  toast,
  refresh: (force = false) => refreshCompany(force),
  subscribe(handler) {
    state.eventHandlers.add(handler);
    return () => state.eventHandlers.delete(handler);
  },
  get company() {
    return state.company;
  },
  get companyId() {
    return state.companyId;
  },
  runCycle: () => openCycleRunner(),
  newIssue: () => openNewIssue(),
};

/* ------------------------------------------------------------------ route */

function parseRoute() {
  const raw = location.hash.replace(/^#/, "") || "/dashboard";
  const [pathname, search = ""] = raw.split("?");
  const parts = pathname.split("/").filter(Boolean);
  const key = parts[0] ?? "dashboard";
  const params = parts.slice(1);
  const query = Object.fromEntries(new URLSearchParams(search));
  return { key, params, query, raw };
}

function resolveView(route) {
  if (route.key === "issues" && route.params.length) return { view: issue, meta: { key: "issues", label: "Issues" } };
  if (route.key === "agents" && route.params.length) return { view: agent, meta: { key: "agents", label: "Agents" } };
  const found = ROUTES.find((entry) => entry.key === route.key) ?? ROUTES[0];
  return { view: found.view, meta: { key: found.key, label: found.label } };
}

/* ------------------------------------------------------------------- nav */

function renderNav() {
  const route = parseRoute();
  const activeKey = route.key;
  const groups = new Map();
  for (const entry of ROUTES) {
    if (!groups.has(entry.section)) groups.set(entry.section, []);
    groups.get(entry.section).push(entry);
  }
  const stats = state.company?.stats ?? {};
  const inboxCount = (stats.pendingApprovals ?? 0) + (stats.blockedIssues ?? 0);
  const badgeFor = (key) => {
    if (key === "inbox" && inboxCount) return `<span class="nav-badge ${stats.pendingApprovals ? "hot" : ""}">${inboxCount}</span>`;
    if (key === "issues" && stats.openIssues) return `<span class="nav-badge">${stats.openIssues}</span>`;
    if (key === "approvals" && stats.pendingApprovals) return `<span class="nav-badge hot">${stats.pendingApprovals}</span>`;
    return "";
  };
  const agentList = (state.company?.agents ?? []).slice(0, 5);

  navEl.innerHTML = [...groups.entries()]
    .map(([section, entries]) => {
      const items = entries
        .filter((entry) => entry.key !== "agents" || true)
        .map(
          (entry) => `
          <a class="nav-item ${activeKey === entry.key ? "active" : ""}" href="#/${entry.key}" data-nav="${entry.key}">
            ${icon(entry.icon)}
            <span class="label">${esc(entry.label)}</span>
            ${badgeFor(entry.key)}
          </a>`,
        )
        .join("");
      const agentBlock =
        section === "Team"
          ? `<div class="nav-section">Roster</div>${agentList
              .map(
                (member) => `
              <a class="nav-item" href="#/agents/${member.id}" style="${activeKey === "agents" && route.params[0] === member.id ? "background:#17171c" : ""}">
                ${avatar(member, "sm")}
                <span class="label">${esc(member.name)}</span>
                <span class="status-dot ${member.status}"></span>
              </a>`,
              )
              .join("")}<a class="nav-item" href="#/agents"><span class="nav-icon"></span><span class="label muted">All agents</span></a>`
          : "";
      return `<div class="nav-section">${esc(section)}</div>${items}${agentBlock}`;
    })
    .join("");
}

function renderChrome() {
  const route = parseRoute();
  const { meta } = resolveView(route);
  const config = state.bootstrap?.config;
  const mode = config?.mode ?? "simulation";
  modeChip.className = `mode-chip ${mode === "live" ? "live" : ""}`;
  modeChip.innerHTML = `<span class="dot"></span>${mode === "live" ? "LIVE NIM" : "SIMULATION"}`;
  modeChip.title =
    mode === "live"
      ? `Calling ${config.baseUrl} with key ${config.keyHint}`
      : "No NVIDIA key — every model call is served by the deterministic simulator. Add a key in Settings.";

  const companyName = state.company?.name ?? "Paperclip";
  const crumbs = [`<a href="#/dashboard">${esc(companyName)}</a>`];
  const detail = route.params[0];
  if (meta.key !== "dashboard") crumbs.push(`<a href="#/${meta.key}">${esc(meta.label)}</a>`);
  if (detail) {
    const label =
      state.company?.issues?.find((entry) => entry.id === detail || entry.key === detail)?.key ??
      state.company?.agents?.find((entry) => entry.id === detail)?.name ??
      detail;
    crumbs.push(`<span class="current">${esc(label)}</span>`);
  } else if (meta.key !== "dashboard") {
    crumbs[crumbs.length - 1] = `<span class="current">${esc(meta.label)}</span>`;
  }
  crumbsEl.innerHTML = crumbs.join('<span class="sep">/</span>');

  const stats = state.company?.stats ?? {};
  sidebarFoot.innerHTML = `
    <div class="mode-row">${icon("shield", "nav-icon")}<span>Guardrails <b>${state.company?.settings?.guardrails?.safetyCheck ? "on" : "off"}</b></span></div>
    <div class="mode-row">${icon("budget", "nav-icon")}<span>Spend <b>${money(stats.spentCents ?? 0)}</b> / ${money(stats.monthlyBudgetCents ?? 0)}</span></div>
    <div class="mode-row">${icon("org", "nav-icon")}<span>${stats.activeAgents ?? 0} active · ${stats.pendingApprovals ?? 0} approvals</span></div>`;
}

/* --------------------------------------------------------------- company */

async function loadCompany(force = false) {
  if (!state.companyId) return;
  if (!force && state.company) return;
  state.company = await api(`/api/companies/${state.companyId}`);
  document.title = `${state.company.name} · Paperclip × NIM`;
  $("#company-name").textContent = state.company.name;
}

async function refreshCompany(force = false) {
  if (!state.companyId) return;
  const now = Date.now();
  if (!force && now - state.lastRefresh < 900) return;
  state.lastRefresh = now;
  try {
    state.company = await api(`/api/companies/${state.companyId}`);
    renderNav();
    renderChrome();
  } catch (error) {
    console.warn("[company refresh]", error.message);
  }
}

/* ------------------------------------------------------------------ render */

async function render() {
  const route = parseRoute();
  state.route = route;
  const { view, meta } = resolveView(route);
  state.cleanup?.();
  state.cleanup = null;
  state.eventHandlers.clear();

  const loadingEl = document.createElement("div");
  loadingEl.innerHTML = loading();
  if (!state.company) viewEl.innerHTML = loadingEl.innerHTML;

  try {
    await loadCompany();
    renderNav();
    renderChrome();
    const cleanup = await view.render(viewEl, { ...context, route, params: route.params, query: route.query });
    if (typeof cleanup === "function") state.cleanup = cleanup;
  } catch (error) {
    console.error(error);
    viewEl.innerHTML = `<div class="empty"><h3>Could not load this view</h3><p>${esc(error.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
  }
}

/* ------------------------------------------------------------ interactions */

function openNewIssue() {
  const company = state.company;
  if (!company) return;
  const agents = company.agents ?? [];
  const projects = company.projects ?? [];
  modal({
    title: "New issue",
    submitLabel: "Create issue",
    body: `
      <div class="field"><label for="title">Title</label><input class="input" id="title" name="title" required placeholder="What needs to happen?" maxlength="160" /></div>
      <div class="field"><label for="description">Context</label><textarea class="textarea" id="description" name="description" placeholder="Why this matters, constraints, links…"></textarea></div>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div class="field"><label>Assignee</label><select class="select" name="assigneeId">${agents
          .map((member) => `<option value="${esc(member.id)}" ${member.role === "operator" ? "selected" : ""}>${esc(member.name)} · ${esc(member.title)}</option>`)
          .join("")}</select></div>
        <div class="field"><label>Priority</label><select class="select" name="priority">${["urgent", "high", "medium", "low"]
          .map((priority) => `<option value="${priority}" ${priority === "medium" ? "selected" : ""}>${priority}</option>`)
          .join("")}</select></div>
      </div>
      <div class="field"><label>Project</label><select class="select" name="projectId"><option value="">No project</option>${projects
        .map((project) => `<option value="${esc(project.id)}">${esc(project.name)}</option>`)
        .join("")}</select></div>
      <div class="field"><label for="acceptance">Definition of done (one per line)</label><textarea class="textarea" id="acceptance" name="acceptance" placeholder="Deliverable linked in the issue&#10;Numbers show a source"></textarea></div>
    `,
    async onSubmit(data) {
      const acceptance = String(data.acceptance ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const created = await api(`/api/companies/${state.companyId}/issues`, {
        method: "POST",
        body: { ...data, acceptance, status: "todo" },
      });
      await refreshCompany(true);
      toast(`${created.issue.key} created`);
      navigate(`/issues/${created.issue.id}`);
    },
  });
}

function openCycleRunner() {
  if (state.running) return;
  const company = state.company;
  if (!company) return;
  if ((company.agents ?? []).length === 0) {
    toast("Add an agent before running a cycle", "warn");
    return;
  }
  state.running = true;
  openDrawer({
    title: "Run a cycle",
    subtitle: "The CEO plans, the team works, quality reviews, the ledger records",
    body: `
      <div class="stack">
        <div class="row-between">
          <span class="pill accent"><span class="dot"></span>in progress</span>
          <span class="hint" id="cycle-elapsed">0.0s</span>
        </div>
        <div class="live-output" id="cycle-log">Starting cycle…\n</div>
        <div class="hint" id="cycle-stream"></div>
        <div class="hint">Issues chosen by the strategist's focus, then ranked by status and priority. Budget and guardrails are enforced per run.</div>
      </div>`,
  });
  const log = $("#cycle-log");
  const started = Date.now();
  const timer = setInterval(() => {
    const elapsed = $("#cycle-elapsed");
    if (elapsed) elapsed.textContent = `${((Date.now() - started) / 1000).toFixed(1)}s`;
  }, 100);
  let text = "";
  let streamed = 0;
  const append = (line) => {
    text = `${text}${line}\n`;
    if (log) {
      log.textContent = text;
      log.scrollTop = log.scrollHeight;
    }
  };
  const unsubscribe = subscribeEvents((event) => {
    if (event.companyId !== state.companyId) return;
    const payload = event.payload ?? {};
    if (event.type === "cycle.planning") append("▸ Strategist is planning the cycle…");
    if (event.type === "cycle.planned") append(`▸ Focus: ${payload.plan?.focus ?? "—"}`);
    if (event.type === "run.started") append(`▸ Run started on ${payload.issueId ? "an issue" : "the board"}`);
    if (event.type === "run.step") append(`   · ${payload.label}${payload.detail ? ` — ${payload.detail}` : ""}`);
    if (event.type === "run.succeeded") append(`   ✓ run finished (${payload.verdict ?? "no review"})`);
    if (event.type === "ledger.recorded") append(`   $ ${money(payload.row?.costCents ?? 0, { precise: true })} ${payload.row?.model ?? ""}`);
    if (event.type === "cycle.finished") append("▸ Cycle finished");
  });

  (async () => {
    try {
      const result = await stream(`/api/companies/${state.companyId}/cycle?stream=1`, { maxIssues: 3 }, {
        onDelta: (chunk) => {
          streamed += chunk.length;
          const counter = $("#cycle-stream");
          if (counter) counter.textContent = `${streamed.toLocaleString()} characters streamed from the team…`;
        },
      });
      append("");
      append(`Focus: ${result?.plan?.focus ?? "—"}`);
      for (const row of result?.results ?? []) {
        append(`${row.verdict === "accepted" ? "✓" : row.error || row.blocked ? "✕" : "·"} ${row.key ?? row.issueId} — ${row.status ?? row.error ?? ""}${row.costCents != null ? ` · ${money(row.costCents, { precise: true })}` : ""}`);
      }
      if (result?.standup) {
        append("");
        append(result.standup.replace(/\n{2,}/g, "\n"));
      }
      toast("Cycle complete");
      await refreshCompany(true);
      if (parseRoute().key === "dashboard" || parseRoute().key === "issues") render();
    } catch (error) {
      append(`✕ ${error.message}`);
      toast(error.message, "error");
    } finally {
      clearInterval(timer);
      unsubscribe();
      state.running = false;
      const pill = document.querySelector("#drawer-root .pill");
      if (pill) {
        pill.className = "pill green";
        pill.innerHTML = '<span class="dot"></span>complete';
      }
    }
  })();
}

function companyMenu() {
  const host = $("#sidebar");
  document.querySelector(".menu")?.remove();
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.style.left = "12px";
  menu.style.top = "52px";
  const companies = state.bootstrap?.companies ?? [];
  menu.innerHTML = `
    <div class="menu-label">Companies</div>
    ${companies
      .map(
        (company) => `<div class="menu-item" data-company="${esc(company.id)}">
          <span class="avatar sm" style="background:${company.id === state.companyId ? "#76b900" : "#2a2a32"};color:${company.id === state.companyId ? "#0a0a0a" : "#c8c8d0"}">${esc(company.name.slice(0, 1))}</span>
          <span class="grow truncate">${esc(company.name)}</span>
          ${company.id === state.companyId ? icon("check", "") : ""}
        </div>`,
      )
      .join("")}
    <div class="menu-sep"></div>
    <div class="menu-item" data-action="new-company">${icon("plus", "")} New company</div>
    <div class="menu-item" data-action="settings">${icon("settings", "")} Company settings</div>`;
  host.append(menu);
  menu.addEventListener("click", async (event) => {
    const companyId = event.target.closest("[data-company]")?.dataset.company;
    const action = event.target.closest("[data-action]")?.dataset.action;
    menu.remove();
    if (companyId && companyId !== state.companyId) {
      await api(`/api/companies/${companyId}/activate`, { method: "POST" });
      state.companyId = companyId;
      state.company = null;
      await boot({ keepRoute: true });
      toast("Switched company");
    }
    if (action === "new-company") newCompanyModal();
    if (action === "settings") navigate("/settings");
  });
  setTimeout(() => {
    const close = (event) => {
      if (!menu.contains(event.target)) {
        menu.remove();
        document.removeEventListener("click", close);
      }
    };
    document.addEventListener("click", close);
  }, 0);
}

export function newCompanyModal() {
  modal({
    title: "New company",
    submitLabel: "Create company",
    wide: true,
    body: `
      <div class="field"><label for="name">Name</label><input class="input" id="name" name="name" required placeholder="e.g. Northwind Labs" maxlength="80" /></div>
      <div class="field"><label for="mission">Mission</label><textarea class="textarea" id="mission" name="mission" placeholder="What is this company here to do? One sentence an agent can act on."></textarea></div>
      <div class="field"><label for="budgetMonthlyCents">Monthly budget (cents)</label><input class="input" id="budgetMonthlyCents" name="budgetMonthlyCents" type="number" min="100" step="100" value="2400" /><div class="hint">$24.00. Agents get their own caps inside this.</div></div>
      <div class="field"><label>Start from a blueprint (optional)</label><select class="select" name="blueprintId"><option value="">Blank slate — starter team of three</option>${(state.blueprintList ?? [])
        .map((blueprint) => `<option value="${esc(blueprint.id)}">${esc(blueprint.name)} — ${esc(blueprint.category)}</option>`)
        .join("")}</select></div>
    `,
    async onSubmit(data) {
      const created = await api("/api/companies", { method: "POST", body: data });
      state.bootstrap = await api("/api/bootstrap");
      state.companyId = created.company.id;
      state.company = created.company;
      toast(`${created.company.name} created`);
      navigate("/dashboard");
      await render();
    },
  });
  if (!state.blueprintList) {
    api("/api/blueprints").then((data) => {
      state.blueprintList = data.blueprints;
      const select = document.querySelector('select[name="blueprintId"]');
      if (select) {
        select.innerHTML = `<option value="">Blank slate — starter team of three</option>${data.blueprints
          .map((blueprint) => `<option value="${esc(blueprint.id)}">${esc(blueprint.name)} — ${esc(blueprint.category)}</option>`)
          .join("")}`;
      }
    });
  }
}

/* --------------------------------------------------------- command palette */

let paletteItems = [];

function openPalette() {
  const root = $("#palette");
  root.hidden = false;
  const input = $("#palette-input");
  input.value = "";
  input.focus();
  buildPalette("");
}

function closePalette() {
  $("#palette").hidden = true;
}

function buildPalette(term) {
  const company = state.company;
  const items = [];
  for (const route of ROUTES) items.push({ kind: "page", label: route.label, icon: route.icon, action: () => navigate(`/${route.key}`) });
  for (const issue of (company?.issues ?? []).slice(0, 80)) {
    items.push({
      kind: "issue",
      label: `${issue.key} ${issue.title}`,
      meta: issue.status,
      icon: "issues",
      action: () => navigate(`/issues/${issue.id}`),
    });
  }
  for (const member of company?.agents ?? []) {
    items.push({ kind: "agent", label: `${member.name} · ${member.title}`, icon: "agents", action: () => navigate(`/agents/${member.id}`) });
  }
  for (const blueprint of state.blueprintList ?? []) {
    items.push({ kind: "blueprint", label: blueprint.name, icon: "blueprints", action: () => navigate(`/blueprints?q=${encodeURIComponent(blueprint.name)}`) });
  }
  items.push({ kind: "action", label: "Run a cycle now", icon: "play", action: () => openCycleRunner() });
  items.push({ kind: "action", label: "New issue", icon: "plus", action: () => openNewIssue() });
  items.push({ kind: "action", label: "New company", icon: "plus", action: () => newCompanyModal() });
  const needle = term.trim().toLowerCase();
  paletteItems = items.filter((item) => !needle || item.label.toLowerCase().includes(needle)).slice(0, 40);
  const results = $("#palette-results");
  results.innerHTML = paletteItems
    .map((item, index) => `<div class="palette-item ${index === 0 ? "on" : ""}" data-index="${index}">${icon(item.icon, "nav-icon")}<span class="grow truncate">${esc(item.label)}</span><span class="kind">${esc(item.kind)}</span></div>`)
    .join("") || `<div class="palette-item">No matches</div>`;
  results.querySelectorAll("[data-index]").forEach((node) => {
    node.addEventListener("click", () => {
      const item = paletteItems[Number(node.dataset.index)];
      closePalette();
      item?.action();
    });
  });
}

/* ------------------------------------------------------------------- boot */

async function boot({ keepRoute = false } = {}) {
  viewEl.innerHTML = loading("Connecting to the control room…");
  try {
    state.bootstrap = await api("/api/bootstrap");
    state.companyId = state.bootstrap.activeCompanyId ?? state.bootstrap.companies[0]?.id ?? null;
    state.company = null;
    if (!state.companyId) {
      viewEl.innerHTML = `<div class="empty"><h3>No company yet</h3><p>Create one to staff a board of NIM agents.</p><button class="btn primary" id="create-first">Create a company</button></div>`;
      $("#create-first")?.addEventListener("click", newCompanyModal);
      return;
    }
    if (!keepRoute && !location.hash) location.hash = "/dashboard";
    await render();
    window.__pcBooted = true;
    api("/api/blueprints").then((data) => {
      state.blueprintList = data.blueprints;
    });
  } catch (error) {
    console.error(error);
    viewEl.innerHTML = `<div class="empty"><h3>The server did not answer</h3><p>${esc(error.message)}</p><button class="btn" onclick="location.reload()">Retry</button></div>`;
  }
}

/* -------------------------------------------------------------- listeners */

window.addEventListener("hashchange", render);
$("#company-switch").addEventListener("click", companyMenu);
$("#new-issue").addEventListener("click", openNewIssue);
/* ---------------------------------------------------------------- theme */

const THEME_KEY = "paperclip-theme";

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function applyTheme(theme, { persist = true } = {}) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", next === "dark" ? "#060607" : "#ffffff");
  const toggle = $("#theme-toggle");
  if (toggle) {
    toggle.title = next === "dark" ? "Switch to light theme" : "Switch to dark theme";
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-pressed", String(next === "dark"));
  }
  if (persist) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode — the choice simply does not persist */
    }
  }
}

function toggleTheme() {
  applyTheme(currentTheme() === "dark" ? "light" : "dark");
}

$("#theme-toggle")?.addEventListener("click", toggleTheme);
applyTheme(currentTheme(), { persist: false });

$("#global-search").addEventListener("click", openPalette);
$("#run-cycle").addEventListener("click", openCycleRunner);

$("#palette").addEventListener("click", (event) => {
  if (event.target.id === "palette") closePalette();
});
$("#palette-input").addEventListener("input", (event) => buildPalette(event.target.value));
$("#palette-input").addEventListener("keydown", (event) => {
  const nodes = [...document.querySelectorAll(".palette-item[data-index]")];
  const current = nodes.findIndex((node) => node.classList.contains("on"));
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = event.key === "ArrowDown" ? Math.min(nodes.length - 1, current + 1) : Math.max(0, current - 1);
    nodes.forEach((node) => node.classList.remove("on"));
    nodes[next]?.classList.add("on");
    nodes[next]?.scrollIntoView({ block: "nearest" });
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const node = nodes[current === -1 ? 0 : current];
    node?.click();
  }
});

document.addEventListener("keydown", (event) => {
  const typing = /input|textarea|select/i.test(event.target.tagName) || event.target.isContentEditable;
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openPalette();
    return;
  }
  if (event.key === "Escape") {
    closePalette();
    closeModal();
    closeDrawer();
    return;
  }
  if (typing) return;
  if (event.key.toLowerCase() === "c") {
    event.preventDefault();
    openNewIssue();
  }
  if (event.key === "?") {
    toast("⌘K search · C new issue · Esc close", "warn");
  }
});

// Re-render chrome on any event that changes board state.
let refreshQueued = false;
subscribeEvents((event) => {
  for (const handler of state.eventHandlers) {
    try {
      handler(event);
    } catch (error) {
      console.warn("[event handler]", error);
    }
  }
  if (!event.companyId || event.companyId !== state.companyId) return;
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    refreshCompany();
  }, 400);
});

boot();
