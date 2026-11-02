/* Shared browser helpers: API client, SSE, markdown, formatting, toasts. */

export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function request(path, { method = "GET", body, signal } = {}) {
  const response = await fetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text.slice(0, 400) };
  }
  if (!response.ok) {
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.hint = payload?.hint;
    error.detail = payload?.body;
    throw error;
  }
  return payload;
}

export const api = {
  get: (path, options) => request(path, options),
  post: (path, body, options) => request(path, { ...options, method: "POST", body }),
  patch: (path, body, options) => request(path, { ...options, method: "PATCH", body }),
  put: (path, body, options) => request(path, { ...options, method: "PUT", body }),
  del: (path, options) => request(path, { ...options, method: "DELETE" }),
};

export const fmt = {
  tokens(value) {
    const number = Number(value ?? 0);
    if (!Number.isFinite(number)) return "0";
    if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`;
    if (number >= 1_000) return `${(number / 1_000).toFixed(1)}k`;
    return String(number);
  },
  number(value) {
    return Number(value ?? 0).toLocaleString();
  },
  money(value) {
    if (value == null || !Number.isFinite(Number(value))) return "—";
    return `$${Number(value).toFixed(2)}`;
  },
  time(value) {
    if (!value) return "—";
    const date = new Date(value);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  },
  date(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  },
  ago(value) {
    if (!value) return "—";
    const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
    if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
    return `${Math.round(seconds / 86_400)}d ago`;
  },
  duration(start, end) {
    if (!start) return "—";
    const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
  },
  bytes(value) {
    const number = Number(value ?? 0);
    if (number < 1024) return `${number} B`;
    if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} KB`;
    return `${(number / (1024 * 1024)).toFixed(1)} MB`;
  },
};

const STATUS_TONE = {
  completed: "green",
  completed_with_issues: "amber",
  executing: "blue",
  planning: "violet",
  reporting: "violet",
  queued: "dim",
  paused: "amber",
  awaiting_approval: "amber",
  blocked: "amber",
  failed: "red",
  cancelled: "dim",
  done: "green",
  running: "blue",
  pending: "dim",
};

export function statusBadge(status) {
  const tone = STATUS_TONE[status] ?? "dim";
  const live = ["executing", "planning", "reporting", "running"].includes(status);
  return `<span class="badge badge-${tone}">${live ? '<span class="status-dot pulse"></span>' : ""}${esc(status.replace(/_/g, " "))}</span>`;
}

export function riskBadge(risk) {
  const tone = risk === "high" ? "red" : risk === "medium" ? "amber" : "green";
  return `<span class="badge badge-${tone}">${esc(risk)} risk</span>`;
}

/* --------------------------------- markdown -------------------------------- */

function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

function tableFrom(lines) {
  const rows = lines
    .filter((line) => !/^\s*\|?[\s:-]+\|/.test(line) || !line.includes("-"))
    .map((line) => line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim()));
  if (!rows.length) return "";
  const [head, ...body] = rows;
  return `<div class="table-wrap"><table><thead><tr>${head
    .map((cell) => `<th>${inline(cell)}</th>`)
    .join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

/** Compact, dependency-free markdown renderer for model output. */
export function md(source) {
  const text = String(source ?? "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^```/.test(line)) {
      const buffer = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index])) buffer.push(lines[index++]);
      index += 1;
      out.push(`<pre><code>${esc(buffer.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) {
      index += 1;
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      out.push("<hr/>");
      index += 1;
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      const level = line.match(/^#+/)[0].length;
      out.push(`<h${level}>${inline(line.replace(/^#+\s*/, ""))}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buffer = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) buffer.push(lines[index++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${md(buffer.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const buffer = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) buffer.push(lines[index++].replace(/^\s*[-*]\s+/, ""));
      out.push(`<ul>${buffer.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const buffer = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) buffer.push(lines[index++].replace(/^\s*\d+\.\s+/, ""));
      out.push(`<ol>${buffer.map((item) => `<li>${inline(item)}</li>`).join("")}</ol>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const buffer = [];
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) buffer.push(lines[index++]);
      out.push(tableFrom(buffer));
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      !/^\s*$/.test(lines[index]) &&
      !/^(#{1,4}\s|```|>\s?|\s*[-*]\s+|\s*\d+\.\s+|\s*\|.*\|\s*$)/.test(lines[index])
    ) {
      paragraph.push(lines[index++]);
    }
    out.push(`<p>${paragraph.map(inline).join("<br/>")}</p>`);
  }
  return out.join("\n");
}

/* ----------------------------------- SSE ----------------------------------- */

/** POST-based SSE reader (EventSource cannot send a JSON body). */
export async function streamChat(body, { onEvent, signal } = {}) {
  const response = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(text.slice(0, 300) || `Stream failed (${response.status})`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trim());
      }
      if (!data.length) continue;
      let payload;
      try {
        payload = JSON.parse(data.join("\n"));
      } catch {
        continue;
      }
      onEvent?.(event, payload);
    }
  }
}

export function watchRun(runId, { onEvent, onState, onError } = {}) {
  const source = new EventSource(`/api/autopilot/${runId}/stream`);
  source.addEventListener("event", (message) => {
    try {
      onEvent?.(JSON.parse(message.data));
    } catch {
      /* ignore malformed frame */
    }
  });
  source.addEventListener("state", (message) => {
    try {
      onState?.(JSON.parse(message.data));
    } catch {
      /* ignore */
    }
  });
  source.onerror = () => {
    onError?.();
    source.close();
  };
  return () => source.close();
}

/* ---------------------------------- toasts --------------------------------- */

export function toast(message, kind = "info", timeout = 4200) {
  const host = document.getElementById("toasts");
  if (!host) return;
  const node = document.createElement("div");
  node.className = `toast ${kind === "error" ? "error" : kind === "warn" ? "warn" : ""}`;
  node.textContent = message;
  host.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    setTimeout(() => node.remove(), 200);
  }, timeout);
}

export function reportError(error) {
  toast(error?.hint ? `${error.message} ${error.hint}` : error?.message ?? String(error), "error", 7000);
}

/* --------------------------------- utilities -------------------------------- */

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied to clipboard");
  } catch {
    toast("Clipboard is unavailable in this browser", "warn");
  }
}

export function download(name, content, type = "text/markdown") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function debounce(fn, delay = 200) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function optionList(values, selected, { valueKey = "id", labelKey = "id" } = {}) {
  return values
    .map((value) => {
      const id = typeof value === "string" ? value : value[valueKey];
      const label = typeof value === "string" ? value : value[labelKey];
      return `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(label)}</option>`;
    })
    .join("");
}
