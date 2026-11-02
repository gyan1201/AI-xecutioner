#!/usr/bin/env node
/**
 * Snapshot the NVIDIA skills catalog.
 *
 * build.nvidia.com/skills lists 430 skills, all authored in
 * github.com/NVIDIA/skills as <skill>/SKILL.md with YAML-ish frontmatter.
 * We fetch the repo tarball, read every SKILL.md, and write a compact
 * `data/skills.json` the app can serve offline. Zero dependencies: the
 * gzip and tar readers below are ~60 lines each.
 *
 *   node scripts/sync-skills.mjs                  # download from GitHub
 *   node scripts/sync-skills.mjs /path/to/repo    # use a local checkout
 */

import { gunzipSync } from "node:zlib";
import { readdirSync, readFileSync, existsSync, writeFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "skills.json");
const TARBALL = "https://codeload.github.com/NVIDIA/skills/tar.gz/refs/heads/main";

const CATEGORY_RULES = [
  ["Biology & Drug Discovery", /(bionemo|biolog|protein|genom|molecul|drug|chemistry|codon|parabricks|cryoem)/i],
  ["Healthcare & MedTech", /(health|clinic|medical|i4h|holoscan|medtech|surgical|patient|dicom|ultrasound|radiolog|nursing)/i],
  ["Networking & DPU", /(doca|bluefield|dpu|rdma|comch|gpudirect|dpdk|packet|network|aerial|ran)/i],
  ["RAG & Retrieval", /(rag|retriev|embedding|rerank|retriever|vector|knowledge)/i],
  ["Robotics & Simulation", /(isaac|robot|omniverse|simulation|physical-ai|cosmos|warp|usd|digital-?twin|anomalygen|cdf-|amc-)/i],
  ["Optimization", /(cuopt|routing|solver|pareto|vrp|tsp|schedule)/i],
  ["Vision & Video", /(vision|video|deepstream|metropolis|vlm|image|camera|detection|nvclip|deplot|dali|multimedia|stream)/i],
  ["Speech & Voice", /(speech|asr|tts|riva|voice|audio|transcri)/i],
  ["Data & RAPIDS", /(cudf|rapids|sql|dataframe|etl|parquet|cuml|nvcomp|pandas|dask|dataset|synthetic|data-designer|data processing)/i],
  ["Accelerated Computing", /(cuda|kernel|nvshmem|cutile|performance|gpu|hpc|nccl|tensorrt|profiler|memory|compiler)/i],
  ["Agentic AI & NIM", /(agent|nemotron|llm|\bnim\b|nemo|finetun|inference|prompt|langchain|langgraph|tool)/i],
  ["Security & Safety", /(security|safety|guardrail|red-team|garak|threat|attestation|zero-trust)/i],
  ["DevOps & Observability", /(devops|kubernetes|docker|deploy|observab|telemetry|cluster|sre|dynamo|helm)/i],
  ["Developer Tools", /(coding|developer|sdk|api|systemverilog|verilog|debug|testing|git|ide|cli)/i],
  ["Climate & Earth", /(earth2|climate|weather|atmos|ocean|geospatial)/i],
  ["Quantum", /(quantum|cuda-?q|qpu)/i],
  ["Automotive", /(automotive|drive\b|autonomous|adas|lidar)/i],
  ["Finance", /(financ|trading|portfolio|fraud)/i],
  ["Telecom", /(telecom|5g|6g|srsran)/i],
  ["Platform & Ecosystem", /.*/],
];

const DROP_TAGS = new Set([
  "read", "write", "edit", "bash", "shell", "grep", "glob", "skill", "skills",
  "claude-code", "cursor", "codex", "nvidia", "python", "setup", "installation",
  "install", "configuration", "troubleshooting", "deployment", "workflow", "io",
]);

function categoryFor(id, description, tags) {
  const haystack = `${id} ${description} ${tags.join(" ")}`;
  for (const [name, pattern] of CATEGORY_RULES) if (pattern.test(haystack)) return name;
  return "General";
}

/** Parse the tiny YAML subset used by SKILL.md frontmatter. */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { data: {}, body: raw };
  const data = {};
  let listKey = null;
  for (const line of match[1].split(/\r?\n/)) {
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && listKey) {
      if (!Array.isArray(data[listKey])) data[listKey] = [];
      data[listKey].push(listItem[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value = rawValue.trim().replace(/^["']|["']$/g, "");
    if (value === "") {
      listKey = key;
      data[key] = [];
      continue;
    }
    listKey = null;
    data[key] = value;
  }
  return { data, body: raw.slice(match[0].length) };
}

function summarize(body) {
  const role = body.match(/##\s*(?:Role|Purpose|Overview|What this skill does)\s*\n+([\s\S]{40,600}?)\n\n/);
  if (role) return role[1].replace(/\s+/g, " ").trim().slice(0, 320);
  const paragraphs = body
    .replace(/^#.*$/gm, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 80 && !p.startsWith("-") && !p.startsWith("*") && !p.startsWith("|") && !p.startsWith(">"));
  return (paragraphs[0] ?? "").slice(0, 320);
}

function titleFor(body, id) {
  const heading = body.match(/^#\s+(.+)$/m);
  if (heading && heading[1].length <= 90) return heading[1].trim();
  return id.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** --- minimal tar reader (ustar, no PAX sparse files) --- */
function readTar(buffer) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.toString("utf8", 0, 100).replace(/\0/g, "").trim();
    const size = parseInt(header.toString("utf8", 124, 136).replace(/\0/g, "").trim(), 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefixRaw = header.toString("utf8", 345, 500).replace(/\0/g, "").trim();
    const fullName = prefixRaw ? `${prefixRaw}/${name}` : name;
    const dataStart = offset + 512;
    const data = buffer.subarray(dataStart, dataStart + size);
    if (type === "0" || type === "\0" || type === "") entries.push({ path: fullName, data });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function collectFromDisk(repoPath) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "SKILL.md") files.push({ path: relative(repoPath, full), data: readFileSync(full) });
    }
  };
  walk(repoPath);
  return files;
}

async function loadEntries() {
  const local = process.argv[2];
  if (local) {
    if (!existsSync(local) || !statSync(local).isDirectory()) throw new Error(`Not a directory: ${local}`);
    console.log(`· reading SKILL.md files from ${local}`);
    return collectFromDisk(local);
  }
  console.log(`· downloading ${TARBALL}`);
  const response = await fetch(TARBALL, { headers: { "user-agent": "paperclip-nim-sync" } });
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  const archive = Buffer.from(await response.arrayBuffer());
  console.log(`· ${(archive.length / 1e6).toFixed(1)} MB gzip, unpacking`);
  return readTar(gunzipSync(archive));
}

const entries = await loadEntries();
const skills = [];
for (const entry of entries) {
  const parts = entry.path.split("/").filter(Boolean);
  if (parts.at(-1) !== "SKILL.md" || !parts.includes("skills") || parts.length < 3) continue;
  const id = parts.at(-2);
  const raw = entry.data.toString("utf8");
  const { data, body } = parseFrontmatter(raw);
  const tags = (Array.isArray(data.tags) ? data.tags : []).filter((tag) => tag.length <= 28);
  const publicTags = tags.filter((tag) => !DROP_TAGS.has(tag.toLowerCase())).slice(0, 6);
  let description = String(data.description ?? "").replace(/\s+/g, " ").trim();
  if (!description || /^[>|][-+]?$/.test(description)) description = "";
  skills.push({
    id: String(data.name ?? id),
    title: titleFor(body, id),
    description: description || summarize(body),
    summary: summarize(body),
    category: categoryFor(id, description, tags),
    tags: publicTags,
    license: String(data.license ?? "see repository"),
    source: `https://github.com/NVIDIA/skills/tree/main/${dirname(entry.path)}`,
  });
}

skills.sort((a, b) => a.id.localeCompare(b.id));
const deduped = [...new Map(skills.map((skill) => [skill.id, skill])).values()];
const categories = [...new Set(deduped.map((skill) => skill.category))].sort();
const payload = {
  source: "https://github.com/NVIDIA/skills",
  listing: "https://build.nvidia.com/skills",
  syncedAt: new Date().toISOString(),
  count: deduped.length,
  categories,
  skills: deduped,
};
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`✔ wrote ${deduped.length} skills across ${categories.length} categories → ${relative(ROOT, OUT)}`);
