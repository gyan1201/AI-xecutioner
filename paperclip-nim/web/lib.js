/* Shared client helpers: API, formatting, icons, markdown, charts, overlays. */

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/* ------------------------------------------------------------------- api */

export async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(data?.error ?? `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.code = data?.code;
    error.hint = data?.hint;
    throw error;
  }
  return data;
}

/**
 * POST + read an SSE response. Returns a promise that resolves when the stream
 * ends; handlers get typed events.
 */
export async function stream(path, body, { onDelta, onEvent, signal } = {}) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body ?? {}),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = `${response.status} ${response.statusText}`;
    try {
      message = JSON.parse(text)?.error ?? message;
    } catch {
      /* keep default */
    }
    throw new Error(message);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let failure = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const lines = frame.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!dataLine) continue;
      const type = eventLine ? eventLine.slice(6).trim() : "message";
      let payload = null;
      try {
        payload = JSON.parse(dataLine.slice(5).trim());
      } catch {
        payload = null;
      }
      if (type === "delta") onDelta?.(payload?.chunk ?? "");
      if (type === "done") result = payload;
      if (type === "error") failure = payload;
      onEvent?.(type, payload);
    }
  }
  if (failure) {
    const error = new Error(failure.message ?? "Stream failed");
    error.code = failure.code;
    throw error;
  }
  return result;
}

export function subscribeEvents(onEvent) {
  const source = new EventSource("/api/events?replay=0");
  source.addEventListener("event", (message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch {
      /* ignore malformed frame */
    }
  });
  return () => source.close();
}

/* --------------------------------------------------------------- format */

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function money(cents, { precise = false } = {}) {
  const value = (Number(cents) || 0) / 100;
  const abs = Math.abs(value);
  // Sub-cent spends keep their precision; anything normal reads as dollars.
  if (abs > 0 && abs < 0.1) return `$${value.toFixed(precise ? 4 : 3).replace(/0+$/, "")}`;
  return `$${value.toFixed(2)}`;
}

export function num(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}

export function pct(value, digits = 0) {
  return `${(Number(value) * 100).toFixed(digits)}%`;
}

export function ago(iso) {
  if (!iso) return "—";
  const delta = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(delta)) return "—";
  if (delta < 45) return "just now";
  if (delta < 3600) return `${Math.round(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.round(delta / 3600)}h ago`;
  if (delta < 86400 * 7) return `${Math.round(delta / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function dateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function initials(name) {
  return String(name ?? "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

export function avatar(person = {}, extra = "") {
  const name = person.name ?? person.actorId ?? "?";
  const accent = person.accent ?? colorFor(name);
  return `<span class="avatar ${extra}" style="background:${esc(accent)}">${esc(initials(name))}</span>`;
}

export function colorFor(seed) {
  const palette = ["#76b900", "#4ec9b0", "#6995ff", "#e3b341", "#ffa657", "#c678dd", "#ff7b72", "#8b949e"];
  let hash = 0;
  for (const char of String(seed ?? "")) hash = (hash * 31 + char.charCodeAt(0)) % 997;
  return palette[hash % palette.length];
}

export const STATUS_META = {
  backlog: { label: "Backlog", color: "#8b949e", pill: "" },
  todo: { label: "Todo", color: "#8b949e", pill: "" },
  in_progress: { label: "In progress", color: "#6995ff", pill: "blue" },
  in_review: { label: "In review", color: "#e3b341", pill: "amber" },
  done: { label: "Done", color: "#3fb950", pill: "green" },
  blocked: { label: "Blocked", color: "#ff7b72", pill: "red" },
  cancelled: { label: "Cancelled", color: "#6e7681", pill: "" },
};

export const PRIORITY_META = {
  urgent: { label: "Urgent", color: "#ff7b72", pill: "red" },
  high: { label: "High", color: "#ffa657", pill: "amber" },
  medium: { label: "Medium", color: "#e3b341", pill: "" },
  low: { label: "Low", color: "#8b949e", pill: "" },
};

export function statusPill(status) {
  const meta = STATUS_META[status] ?? { label: status, pill: "" };
  return `<span class="pill ${meta.pill}"><span class="dot" style="background:${meta.color}"></span>${esc(meta.label)}</span>`;
}

export function priorityPill(priority) {
  const meta = PRIORITY_META[priority] ?? { label: priority, pill: "" };
  return `<span class="pill ${meta.pill}">${esc(meta.label)}</span>`;
}

/* -------------------------------------------------------------- markdown */

function inline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

/** Small, safe markdown renderer: escape first, then structure. */
export function md(source) {
  if (!source) return "";
  const blocks = [];
  let text = String(source).replace(/\r\n/g, "\n");
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = blocks.length;
    blocks.push(`<pre><code class="lang-${esc(language)}">${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000BLOCK${index}\u0000`;
  });
  const lines = esc(text).split("\n");
  const out = [];
  let paragraph = [];
  let list = null;
  let quote = [];
  let table = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${inline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.type}>${list.items.map((item) => `<li>${inline(item)}</li>`).join("")}</${list.type}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${inline(quote.join(" "))}</blockquote>`);
      quote = [];
    }
  };
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push(
      `<table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows
        .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table>`,
    );
    table = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
    flushTable();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(4, heading[1].length);
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      flushAll();
      out.push("<hr />");
      continue;
    }
    const quoteMatch = line.match(/^>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      flushList();
      quote.push(quoteMatch[1]);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      flushQuote();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(bullet[1]);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      flushQuote();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    if (/^\|.*\|$/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushQuote();
      const cells = line.trim().slice(1, -1).split("|").map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
      if (!table) table = [];
      table.push(cells);
      continue;
    }
    if (table) flushTable();
    if (line.match(/^\s{2,}\S/)) {
      paragraph.push(line.trim());
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }
  flushAll();
  return out.join("\n").replace(/\u0000BLOCK(\d+)\u0000/g, (_, index) => blocks[Number(index)]);
}

/* ---------------------------------------------------------------- charts */

export function bars(values, { color = "green", height = 108 } = {}) {
  const max = Math.max(1, ...values);
  return `<div class="chart" style="height:${height}px">${values
    .map((value) => `<div class="bar ${color}" style="height:${Math.max(2, Math.round((value / max) * 100))}%" title="${value}"></div>`)
    .join("")}</div>`;
}

export function stackedBars(series, { height = 108 } = {}) {
  const totals = series[0].values.map((_, index) => series.reduce((sum, entry) => sum + (entry.values[index] ?? 0), 0));
  const max = Math.max(1, ...totals);
  return `<div class="chart" style="height:${height}px">${totals
    .map((total, index) => {
      const parts = series
        .map((entry) => {
          const value = entry.values[index] ?? 0;
          const share = total ? (value / total) * 100 : 0;
          return `<i style="display:block;height:${(value / max) * 100}%;background:${entry.color};opacity:.9"></i>`;
        })
        .join("");
      return `<div class="bar" style="height:${Math.max(2, Math.round((total / max) * 100))}%;display:flex;flex-direction:column-reverse;background:#1a1a20">${parts}</div>`;
    })
    .join("")}</div>`;
}

export function donut(segments, { size = 92, thickness = 10 } = {}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0) || 1;
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const arcs = segments
    .map((segment) => {
      const length = (segment.value / total) * circumference;
      const arc = `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="none" stroke="${segment.color}" stroke-width="${thickness}" stroke-dasharray="${length} ${circumference - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 ${size / 2} ${size / 2})" />`;
      offset += length;
      return arc;
    })
    .join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img">${arcs}</svg>`;
}

/* ----------------------------------------------------------------- icons */

const ICONS = {
  dashboard: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
  inbox: '<path d="M2 9.5h3l1 2h4l1-2h3"/><path d="M3 3h10l1.5 6.5v3a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-3L3 3z"/>',
  issues: '<circle cx="8" cy="8" r="5.6"/><path d="M8 5.2v3.6l2.3 1.4"/>',
  routines: '<path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M13 2.5V5h-2.5"/>',
  goals: '<circle cx="8" cy="8" r="5.6"/><circle cx="8" cy="8" r="2.6"/><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15"/>',
  projects: '<path d="M2 4.5h4.5l1.3 1.8H14v6.2a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5z"/>',
  agents: '<circle cx="5.5" cy="6" r="2.3"/><path d="M1.8 13c.3-2 1.9-3.2 3.7-3.2S8.9 11 9.2 13"/><circle cx="11.4" cy="6.4" r="1.9"/><path d="M10 9.4c1.8 0 3.3 1.1 3.6 3"/>',
  org: '<rect x="6" y="1.5" width="4" height="3" rx="1"/><rect x="1.5" y="11" width="4" height="3" rx="1"/><rect x="10.5" y="11" width="4" height="3" rx="1"/><path d="M8 4.5v3M3.5 11V9h9v2"/>',
  skills: '<path d="M8 1.8l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 10.5l-3.4 1.8.7-3.8L2.5 5.8l3.8-.5L8 1.8z"/>',
  blueprints: '<path d="M2.5 2.5h5v5h-5zM8.5 8.5h5v5h-5z"/><path d="M7.5 5h2.5a1 1 0 0 1 1 1v2.5"/>',
  models: '<path d="M8 1.8l5.4 3.1v6.2L8 14.2 2.6 11.1V4.9L8 1.8z"/><path d="M2.6 4.9L8 8l5.4-3.1M8 8v6.2"/>',
  studio: '<path d="M2.5 3.5h11v9h-11z"/><path d="M5.5 7l2 2 3.4-3.4"/>',
  settings: '<circle cx="8" cy="8" r="2.3"/><path d="M8 1.6v1.7M8 12.7v1.7M1.6 8h1.7M12.7 8h1.7M3.5 3.5l1.2 1.2M11.3 11.3l1.2 1.2M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2"/>',
  budget: '<rect x="1.8" y="3.5" width="12.4" height="9" rx="1.5"/><path d="M1.8 6.5h12.4M10.5 10h1.6"/>',
  activity: '<path d="M1.5 8h2.7l1.6-4.2 3 8.6 1.6-4.4h3.1"/>',
  knowledge: '<path d="M3 2.5h7.5L13 5v8.5H3z"/><path d="M10.5 2.5V5H13M5.3 8h5.4M5.3 10.5h3.6"/>',
  approvals: '<path d="M3 2.5h10v11H3z"/><path d="M5.4 8l1.8 1.8 3.4-3.6"/>',
  search: '<circle cx="7" cy="7" r="4.4"/><path d="M10.3 10.3L14 14"/>',
  play: '<path d="M5 3.6l7 4.4-7 4.4z"/>',
  check: '<path d="M3 8.4l3.2 3.2L13 4.8"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  external: '<path d="M9 3h4v4M13 3L7 9M11 10.5V13H3V5h2.5"/>',
  spark: '<path d="M8 2l1.5 4.2L14 7.7l-4.2 1.6L8 13.5 6.2 9.3 2 7.7l4.2-1.5L8 2z"/>',
  shield: '<path d="M8 2l5 2v4.2c0 3-2.1 5-5 6-2.9-1-5-3-5-6V4l5-2z"/>',
  clock: '<circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.4"/>',
  terminal: '<path d="M2.5 3.5h11v9h-11z"/><path d="M5 6.5l1.8 1.8L5 10M8.5 10h2.5"/>',
  image: '<rect x="2.5" y="3" width="11" height="10" rx="1.2"/><circle cx="6" cy="6.4" r="1.1"/><path d="M3.5 11.5l3-3 2.2 2.2 1.7-1.7 2.1 2.5"/>',
};

export function icon(name, cls = "nav-icon") {
  const path = ICONS[name] ?? ICONS.dashboard;
  return `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

/* -------------------------------------------------------------- overlays */

let toastTimer = 0;
export function toast(message, kind = "ok") {
  const host = document.getElementById("toasts");
  if (!host) return;
  const node = document.createElement("div");
  node.className = `toast ${kind === "ok" ? "" : kind}`;
  node.textContent = message;
  host.append(node);
  clearTimeout(toastTimer);
  setTimeout(() => node.remove(), 4200);
  while (host.children.length > 4) host.firstElementChild.remove();
}

export function closeModal() {
  const root = document.getElementById("modal-root");
  root.hidden = true;
  root.innerHTML = "";
}

export function modal({ title, body, footer, onSubmit, submitLabel = "Save", wide = false }) {
  const root = document.getElementById("modal-root");
  root.hidden = false;
  root.innerHTML = `
    <div class="modal" style="${wide ? "width:min(760px,96vw)" : ""}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2><button class="icon-btn" data-close>${icon("x", "")}</button></div>
      <form class="modal-body" id="modal-form">${body}</form>
      <div class="modal-foot">
        <button class="btn ghost" type="button" data-close>Cancel</button>
        ${footer ?? `<button class="btn primary" type="submit" form="modal-form">${esc(submitLabel)}</button>`}
      </div>
    </div>`;
  root.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", closeModal));
  root.addEventListener("click", (event) => {
    if (event.target === root) closeModal();
  });
  const form = root.querySelector("#modal-form");
  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      const submit = root.querySelector('button[type="submit"]');
      if (submit) {
        submit.disabled = true;
        submit.textContent = "Working…";
      }
      const keepOpen = await onSubmit?.(data, form);
      if (!keepOpen) closeModal();
    } catch (error) {
      toast(error.message, "error");
      const submit = root.querySelector('button[type="submit"]');
      if (submit) {
        submit.disabled = false;
        submit.textContent = submitLabel;
      }
    }
  });
  setTimeout(() => form?.querySelector("input, textarea, select")?.focus(), 40);
  return root;
}

export function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    root.hidden = false;
    root.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-head"><h2>${esc(title)}</h2></div>
        <div class="modal-body"><div class="prose">${md(message)}</div></div>
        <div class="modal-foot">
          <button class="btn ghost" data-no>Cancel</button>
          <button class="btn ${danger ? "danger" : "primary"}" data-yes>${esc(confirmLabel)}</button>
        </div>
      </div>`;
    const done = (value) => {
      closeModal();
      resolve(value);
    };
    root.querySelector("[data-no]").onclick = () => done(false);
    root.querySelector("[data-yes]").onclick = () => done(true);
    root.addEventListener("click", (event) => {
      if (event.target === root) done(false);
    });
  });
}

export function openDrawer({ title, subtitle = "", body }) {
  const root = document.getElementById("drawer-root");
  root.hidden = false;
  root.innerHTML = `
    <div class="drawer" role="dialog" aria-modal="true">
      <div class="drawer-head">
        <div>
          <div style="font-size:14px;font-weight:600">${esc(title)}</div>
          ${subtitle ? `<div class="hint">${esc(subtitle)}</div>` : ""}
        </div>
        <button class="icon-btn" data-close>${icon("x", "")}</button>
      </div>
      <div class="drawer-body">${body}</div>
    </div>`;
  root.querySelector("[data-close]").onclick = closeDrawer;
  root.addEventListener("click", (event) => {
    if (event.target === root) closeDrawer();
  });
}

export function closeDrawer() {
  const root = document.getElementById("drawer-root");
  root.hidden = true;
  root.innerHTML = "";
}

/* --------------------------------------------------------------- helpers */

export function debounce(fn, wait = 220) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function loading(label = "Loading…") {
  return `<div class="splash"><div class="spinner"></div><div>${esc(label)}</div></div>`;
}

export function errorState(message) {
  return `<div class="empty"><h3>Something went wrong</h3><p>${esc(message)}</p><button class="btn" onclick="location.reload()">Reload</button></div>`;
}

export function copy(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast("Copied"),
    () => toast("Could not copy", "error"),
  );
}

export function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(220, textarea.scrollHeight)}px`;
}
