/**
 * Company store: one JSON document per company + an append-only NDJSON audit
 * log. Small enough to keep hot in memory, durable enough to survive a
 * restart, and readable enough to `cat` when something goes wrong.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { ensureDirs, loadSettings, paths, saveSettings } from "./config.mjs";

export function newId(prefix = "id") {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function createEventBus({ bufferSize = 300 } = {}) {
  const subscribers = new Set();
  const buffer = [];
  let sequence = 0;
  return {
    publish(event) {
      const enriched = { ...event, seq: (sequence += 1), at: event.at ?? nowIso() };
      buffer.push(enriched);
      if (buffer.length > bufferSize) buffer.shift();
      for (const listener of subscribers) {
        try {
          listener(enriched);
        } catch {
          /* a broken SSE client must never break the engine */
        }
      }
      return enriched;
    },
    subscribe(listener, { replay = 0 } = {}) {
      subscribers.add(listener);
      if (replay > 0) {
        const recent = buffer.slice(-replay);
        for (const event of recent) {
          try {
            listener(event);
          } catch {
            /* ignore */
          }
        }
      }
      return () => subscribers.delete(listener);
    },
    recent(limit = 50) {
      return buffer.slice(-limit);
    },
    get size() {
      return subscribers.size;
    },
  };
}

export function createStore({ bus } = {}) {
  ensureDirs();
  const cache = new Map();
  const pending = new Map();

  const companyDir = (id) => join(paths.companies, id);
  const companyFile = (id) => join(companyDir(id), "company.json");
  const eventsFile = (id) => join(companyDir(id), "events.ndjson");

  function atomicWrite(file, contents) {
    mkdirSync(join(file, ".."), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, contents);
    renameSync(temp, file);
  }

  function listCompanies() {
    if (!existsSync(paths.companies)) return [];
    return readdirSync(paths.companies, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(companyFile(entry.name)))
      .map((entry) => {
        const doc = getCompany(entry.name);
        if (!doc) return null;
        return {
          id: doc.id,
          name: doc.name,
          mission: doc.mission,
          createdAt: doc.createdAt,
          agents: doc.agents?.length ?? 0,
          issues: doc.issues?.length ?? 0,
          openIssues: (doc.issues ?? []).filter((issue) => !["done", "cancelled"].includes(issue.status)).length,
          spentCents: Math.round((doc.ledger ?? []).reduce((sum, row) => sum + row.costCents, 0)),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  function getCompany(id) {
    if (!id) return null;
    if (cache.has(id)) return cache.get(id);
    const file = companyFile(id);
    if (!existsSync(file)) return null;
    try {
      const doc = JSON.parse(readFileSync(file, "utf8"));
      cache.set(id, doc);
      return doc;
    } catch {
      return null;
    }
  }

  function saveCompany(doc) {
    if (!doc?.id) throw new Error("Company document needs an id");
    doc.updatedAt = nowIso();
    cache.set(doc.id, doc);
    if (pending.has(doc.id)) clearTimeout(pending.get(doc.id));
    const timer = setTimeout(() => {
      pending.delete(doc.id);
      atomicWrite(companyFile(doc.id), `${JSON.stringify(doc, null, 2)}\n`);
    }, 25);
    timer.unref?.();
    pending.set(doc.id, timer);
    return doc;
  }

  function flush() {
    for (const [id, timer] of pending) {
      clearTimeout(timer);
      const doc = cache.get(id);
      if (doc) atomicWrite(companyFile(id), `${JSON.stringify(doc, null, 2)}\n`);
    }
    pending.clear();
  }

  function createCompany(doc) {
    mkdirSync(companyDir(doc.id), { recursive: true });
    saveCompany(doc);
    flush();
    const settings = loadSettings();
    if (!settings.activeCompanyId) saveSettings({ activeCompanyId: doc.id });
    bus?.publish({ type: "company.created", companyId: doc.id, payload: { id: doc.id, name: doc.name } });
    return doc;
  }

  function deleteCompany(id) {
    cache.delete(id);
    if (pending.has(id)) {
      clearTimeout(pending.get(id));
      pending.delete(id);
    }
    rmSync(companyDir(id), { recursive: true, force: true });
    const settings = loadSettings();
    if (settings.activeCompanyId === id) {
      const remaining = listCompanies();
      saveSettings({ activeCompanyId: remaining[0]?.id ?? null });
    }
    bus?.publish({ type: "company.deleted", companyId: id, payload: { id } });
  }

  /** Append to the audit trail without blocking the caller. */
  function audit(companyId, event) {
    try {
      mkdirSync(companyDir(companyId), { recursive: true });
      appendFileSync(eventsFile(companyId), `${JSON.stringify({ ...event, at: event.at ?? nowIso() })}\n`);
    } catch {
      /* auditing must never take a run down */
    }
  }

  function readAudit(companyId, limit = 200) {
    const file = eventsFile(companyId);
    if (!existsSync(file)) return [];
    try {
      const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      return lines.slice(-limit).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }).filter(Boolean).reverse();
    } catch {
      return [];
    }
  }

  function activeCompany() {
    const settings = loadSettings();
    const companies = listCompanies();
    const selected = companies.find((company) => company.id === settings.activeCompanyId) ?? companies[0];
    return selected ? getCompany(selected.id) : null;
  }

  /** Mutate a company document under a lock so concurrent runs cannot interleave. */
  const locks = new Map();
  async function withCompany(id, mutator) {
    const previous = locks.get(id) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    locks.set(id, previous.then(() => current));
    await previous;
    try {
      const doc = getCompany(id);
      if (!doc) {
        const error = new Error(`Company ${id} not found`);
        error.status = 404;
        throw error;
      }
      const result = await mutator(doc);
      saveCompany(doc);
      return result;
    } finally {
      release();
      if (locks.get(id) === current) locks.delete(id);
    }
  }

  return {
    listCompanies,
    getCompany,
    saveCompany,
    createCompany,
    deleteCompany,
    activeCompany,
    audit,
    readAudit,
    withCompany,
    flush,
    setActive(id) {
      saveSettings({ activeCompanyId: id });
    },
    resetAll({ keepSettings = true } = {}) {
      flush();
      rmSync(paths.companies, { recursive: true, force: true });
      cache.clear();
      ensureDirs();
      if (!keepSettings) saveSettings({ activeCompanyId: null });
    },
  };
}
