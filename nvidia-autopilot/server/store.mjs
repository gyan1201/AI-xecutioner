import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { paths, ensureDataDirs } from "./config.mjs";

/**
 * File-backed run + knowledge store.
 *
 * A run directory looks like:
 *   data/runs/<id>/run.json        snapshot (safe to read at any time)
 *   data/runs/<id>/events.ndjson   append-only event log (replayable)
 *   data/runs/<id>/artifacts/*     deliverables produced by agents
 *
 * Self-hosted Paperclip deployments already assume a writable local disk, so
 * this keeps the feature dependency-free. Everything is scoped per run id.
 */

const emitters = new Map();

function emitterFor(runId) {
  if (!emitters.has(runId)) emitters.set(runId, new EventEmitter());
  return emitters.get(runId);
}

function runDir(runId) {
  return join(paths.runs, runId);
}

function safeFilename(name) {
  const base = String(name || "artifact")
    .replace(/[^\w.\- ]+/g, "-")
    .replace(/\s+/g, "-")
    .slice(0, 120);
  return base || "artifact";
}

export function createStore() {
  ensureDataDirs();

  return {
    paths,

    saveRun(run) {
      mkdirSync(runDir(run.id), { recursive: true });
      const snapshot = { ...run, updatedAt: new Date().toISOString() };
      writeFileSync(join(runDir(run.id), "run.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
      emitterFor(run.id).emit("state", snapshot);
      return snapshot;
    },

    getRun(runId) {
      const file = join(runDir(runId), "run.json");
      if (!existsSync(file)) return null;
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },

    listRuns() {
      ensureDataDirs();
      const entries = readdirSync(paths.runs, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      const runs = [];
      for (const entry of entries) {
        const file = join(paths.runs, entry.name, "run.json");
        if (!existsSync(file)) continue;
        try {
          const run = JSON.parse(readFileSync(file, "utf8"));
          runs.push({
            id: run.id,
            goal: run.goal,
            company: run.company,
            status: run.status,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
            usage: run.usage,
            taskCount: run.tasks?.length ?? 0,
            completedTasks: run.tasks?.filter((task) => task.status === "done").length ?? 0,
            simulated: run.simulated,
          });
        } catch {
          /* skip unreadable runs */
        }
      }
      return runs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    deleteRun(runId) {
      const dir = runDir(runId);
      if (!existsSync(dir)) return false;
      emitters.get(runId)?.removeAllListeners();
      emitters.delete(runId);
      lastSeq.delete(runId);
      rmSync(dir, { recursive: true, force: true });
      return true;
    },

    appendEvent(runId, event) {
      mkdirSync(runDir(runId), { recursive: true });
      const record = { ...event, seq: nextSeq(runId), at: new Date().toISOString() };
      appendFileSync(join(runDir(runId), "events.ndjson"), `${JSON.stringify(record)}\n`);
      emitterFor(runId).emit("event", record);
      return record;
    },

    readEvents(runId, { since = 0, limit = 2000 } = {}) {
      const file = join(runDir(runId), "events.ndjson");
      if (!existsSync(file)) return [];
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      const events = [];
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if ((event.seq ?? 0) > since) events.push(event);
          if (events.length >= limit) break;
        } catch {
          /* tolerate a partially written final line */
        }
      }
      return events;
    },

    subscribe(runId, listener) {
      const emitter = emitterFor(runId);
      const onEvent = (event) => listener({ type: "event", event });
      const onState = (run) => listener({ type: "state", run });
      emitter.on("event", onEvent);
      emitter.on("state", onState);
      return () => {
        emitter.off("event", onEvent);
        emitter.off("state", onState);
      };
    },

    writeArtifact(runId, filename, content, meta = {}) {
      const dir = join(runDir(runId), "artifacts");
      mkdirSync(dir, { recursive: true });
      const name = safeFilename(filename);
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
      const file = join(dir, name);
      writeFileSync(file, buffer);
      const record = {
        name,
        bytes: buffer.length,
        sha256: createHash("sha256").update(buffer).digest("hex").slice(0, 16),
        createdAt: new Date().toISOString(),
        ...meta,
      };
      const manifest = join(dir, "manifest.json");
      const existing = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
      writeFileSync(manifest, `${JSON.stringify([...existing.filter((entry) => entry.name !== name), record], null, 2)}\n`);
      return record;
    },

    listArtifacts(runId) {
      const manifest = join(runDir(runId), "artifacts", "manifest.json");
      if (!existsSync(manifest)) return [];
      try {
        return JSON.parse(readFileSync(manifest, "utf8"));
      } catch {
        return [];
      }
    },

    readArtifact(runId, name) {
      const dir = join(runDir(runId), "artifacts");
      const file = join(dir, safeFilename(name));
      if (!existsSync(file)) return null;
      return readFileSync(file);
    },

    artifactPath(runId, name) {
      return join(runDir(runId), "artifacts", safeFilename(name));
    },

    /* ------------------------------- knowledge ------------------------------- */

    knowledgeIndexPath: join(paths.knowledge, "index.json"),

    readKnowledge() {
      const file = join(paths.knowledge, "index.json");
      if (!existsSync(file)) return { documents: [], chunks: [], updatedAt: null };
      try {
        return JSON.parse(readFileSync(file, "utf8"));
      } catch {
        return { documents: [], chunks: [], updatedAt: null };
      }
    },

    writeKnowledge(index) {
      ensureDataDirs();
      writeFileSync(join(paths.knowledge, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
      return index;
    },

    addKnowledgeDocument({ title, text, source = "upload" }) {
      const index = this.readKnowledge();
      const body = String(text ?? "");
      const document = {
        id: randomUUID(),
        title: title || `Document ${(index.documents?.length ?? 0) + 1}`,
        source,
        chars: body.length,
        createdAt: new Date().toISOString(),
        chunks: 0,
      };
      this.writeKnowledge({
        documents: [...(index.documents ?? []), document],
        chunks: index.chunks ?? [],
        pending: [...(index.pending ?? []), { documentId: document.id, text: body }],
        updatedAt: new Date().toISOString(),
      });
      return document;
    },

    removeKnowledgeDocument(documentId) {
      const index = this.readKnowledge();
      return this.writeKnowledge({
        ...index,
        documents: index.documents.filter((doc) => doc.id !== documentId),
        chunks: index.chunks.filter((chunk) => chunk.documentId !== documentId),
        pending: (index.pending ?? []).filter((entry) => entry.documentId !== documentId),
        updatedAt: new Date().toISOString(),
      });
    },
  };
}

/**
 * Sequence numbers are monotonic per run. The last value is cached in memory so
 * appending stays O(1); a cold start recovers it from the tail of the log.
 */
const lastSeq = new Map();

function nextSeq(runId) {
  if (lastSeq.has(runId)) {
    const next = lastSeq.get(runId) + 1;
    lastSeq.set(runId, next);
    return next;
  }
  const file = join(runDir(runId), "events.ndjson");
  if (!existsSync(file)) {
    lastSeq.set(runId, 1);
    return 1;
  }
  const size = statSync(file).size;
  if (!size) {
    lastSeq.set(runId, 1);
    return 1;
  }
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n").filter(Boolean);
  let seq = lines.length;
  try {
    seq = JSON.parse(lines[lines.length - 1]).seq ?? lines.length;
  } catch {
    /* keep the line count as a conservative fallback */
  }
  lastSeq.set(runId, seq + 1);
  return seq + 1;
}
