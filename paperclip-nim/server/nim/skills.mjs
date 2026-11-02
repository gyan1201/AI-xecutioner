/**
 * NVIDIA skills catalog (430 skills, snapshotted from github.com/NVIDIA/skills
 * by scripts/sync-skills.mjs).
 *
 * In Paperclip a skill is a portable instruction bundle an agent can carry. Here
 * the catalog is real: assigning a skill appends its scope to the agent's system
 * prompt and shows up in the run trace, so "which skills produced this answer"
 * is answerable.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths, ROOT } from "../config.mjs";

let cached = null;

export function loadSkills() {
  if (cached) return cached;
  // A custom PAPERCLIP_DATA_DIR may not carry the snapshot, so fall back to the
  // checked-in catalog before giving up.
  const candidates = [paths.skills, join(ROOT, "data", "skills.json")];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return (cached = { source: null, syncedAt: null, count: 0, categories: [], skills: [] });
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    cached = {
      source: raw.source,
      listing: raw.listing,
      syncedAt: raw.syncedAt,
      count: raw.count,
      categories: raw.categories ?? [],
      skills: raw.skills ?? [],
    };
  } catch {
    cached = { source: null, syncedAt: null, count: 0, categories: [], skills: [] };
  }
  return cached;
}

export function getSkill(id) {
  return loadSkills().skills.find((skill) => skill.id === id) ?? null;
}

export function resolveSkills(ids = []) {
  return ids.map((id) => getSkill(id)).filter(Boolean);
}

export function searchSkills({ query = "", category = "", tag = "", limit = 60, offset = 0 } = {}) {
  const catalog = loadSkills();
  const term = query.trim().toLowerCase();
  let skills = catalog.skills;
  if (category) skills = skills.filter((skill) => skill.category === category);
  if (tag) skills = skills.filter((skill) => skill.tags.includes(tag));
  if (term) {
    const scored = skills
      .map((skill) => {
        const haystack = `${skill.id} ${skill.title} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
        let score = 0;
        if (skill.id.includes(term)) score += 6;
        if (skill.title.toLowerCase().includes(term)) score += 4;
        if (skill.description.toLowerCase().includes(term)) score += 2;
        if (haystack.includes(term)) score += 1;
        return { skill, score };
      })
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);
    return { total: scored.length, items: scored.slice(offset, offset + limit).map((row) => row.skill) };
  }
  return { total: skills.length, items: skills.slice(offset, offset + limit) };
}

export function popularTags(limit = 24) {
  const counts = new Map();
  for (const skill of loadSkills().skills) {
    for (const tag of skill.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

/** Compact prompt block describing the skills an agent carries. */
export function skillPrompt(ids = []) {
  const skills = resolveSkills(ids);
  if (!skills.length) return "";
  const lines = skills
    .slice(0, 8)
    .map((skill) => `- ${skill.title} (${skill.category}): ${skill.description.slice(0, 220)}`);
  return `\n\nNVIDIA skills you carry (apply them when relevant, and name the skill you used):\n${lines.join("\n")}`;
}

export function suggestSkills({ text = "", category = "", limit = 5 } = {}) {
  const catalog = loadSkills();
  const words = new Set(
    String(text)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
  const scored = catalog.skills.map((skill) => {
    const haystack = `${skill.id} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase();
    let score = category && skill.category === category ? 3 : 0;
    for (const word of words) if (haystack.includes(word)) score += 1;
    return { skill, score };
  });
  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => row.skill);
}

export function skillStats() {
  const catalog = loadSkills();
  const byCategory = {};
  for (const skill of catalog.skills) byCategory[skill.category] = (byCategory[skill.category] ?? 0) + 1;
  return {
    count: catalog.count,
    categories: catalog.categories,
    byCategory,
    syncedAt: catalog.syncedAt,
    source: catalog.source,
    listing: catalog.listing,
  };
}

/* ---------------------------------------------------------------- matching */

/**
 * Which corner of the catalog a domain lives in. A support company needs
 * retrieval and voice skills; a robotics company needs simulation and
 * calibration. Used to keep a hire from arriving with a generic RAG pair
 * because the role title was vague.
 */
const DOMAIN_SIGNALS = [
  { test: /support|contact cent|ticket|triage|reply|help ?desk|customer/i, categories: ["RAG & Retrieval", "Speech & Voice", "Agentic AI & NIM"], words: ["retrieval", "rag", "policy", "voice", "triage", "support", "ticket"] },
  { test: /robot|manipulat|embodied|teleop|physical|humanoid|grasp|sim2real/i, categories: ["Robotics & Simulation", "Vision & Video", "Accelerated Computing"], words: ["robot", "simulation", "calibration", "teleop", "pose", "omniverse", "grasp"] },
  { test: /clinician|patient|clinical|radiolog|imaging|scribe|health/i, categories: ["Healthcare & MedTech", "Speech & Voice", "RAG & Retrieval"], words: ["clinical", "healthcare", "medical", "voice", "phi"] },
  { test: /gene|genomic|protein|drug|molecul|biolog/i, categories: ["Biology & Drug Discovery", "Accelerated Computing"], words: ["protein", "genom", "molecul", "boltz", "diffdock", "parabricks"] },
  { test: /video|camera|stream|cctv|surveillance/i, categories: ["Vision & Video", "Robotics & Simulation"], words: ["video", "stream", "rtsp", "vision", "vlm"] },
  { test: /fraud|security|guardrail|safety|compliance/i, categories: ["Security & Safety", "Agentic AI & NIM"], words: ["guardrail", "safety", "fraud", "policy", "security"] },
  { test: /route|logistic|fleet|delivery|warehouse/i, categories: ["Optimization", "Agentic AI & NIM"], words: ["routing", "cuopt", "optimization", "fleet"] },
  { test: /weather|climate|forecast|earth/i, categories: ["Climate & Earth"], words: ["weather", "climate", "fourcastnet", "earth"] },
];

/* A title says what the person is for; the skill catalogue says what exists.
 * These bridges stop "Implementation Engineer" from scoring on the word
 * "engineer" and landing on whatever sorts first alphabetically. */
const ROLE_SIGNALS = [
  { test: /architect|solution|strateg|principal|lead/i, words: ["blueprint", "architecture", "reference", "deploy", "design", "pipeline"] },
  { test: /implement|engineer|builder|developer|integration/i, words: ["build", "deploy", "pipeline", "integration", "client", "asr", "finetune", "service"] },
  { test: /quality|review|critic|qa|safety|compliance|auditor/i, words: ["eval", "evaluation", "test", "guardrail", "safety", "benchmark", "audit", "red team"] },
  { test: /analyst|research|scientist|data/i, words: ["analysis", "research", "dataset", "report", "metrics"] },
  { test: /sre|ops|delivery|operator|reliability/i, words: ["deploy", "observability", "runtime", "runbook", "incident"] },
];

const STOP_WORDS = new Set(["the", "and", "for", "with", "from", "that", "this", "into", "over", "under", "than", "your", "their", "when", "what", "will", "must", "each"]);

function tokens(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/** Domain categories + vocabulary implied by a company's mission and blueprint. */
export function domainProfile(text = "") {
  const categories = new Set();
  const words = new Set(tokens(text));
  for (const signal of DOMAIN_SIGNALS) {
    if (!signal.test.test(String(text))) continue;
    signal.categories.forEach((category) => categories.add(category));
    signal.words.forEach((word) => words.add(word));
  }
  return { categories: [...categories], words: [...words] };
}

/**
 * Pick skills for one role. Scores on domain category, domain vocabulary and the
 * role's own title, then avoids handing two agents in the same team the same
 * skills — a team where everyone carries `rag-blueprint` has not been staffed.
 */
export function suggestSkillsForRole({ title = "", role = "", domain = "", text = "", used = new Set(), limit = 2 } = {}) {
  const catalog = loadSkills();
  const profile = domainProfile(`${domain} ${text}`);
  const roleWords = new Set(tokens(`${title} ${role}`));
  for (const signal of ROLE_SIGNALS) {
    if (!signal.test.test(`${title} ${role}`)) continue;
    signal.words.forEach((word) => roleWords.add(word));
  }
  const domainWords = new Set([...profile.words, ...tokens(`${domain} ${text}`)]);

  const scored = catalog.skills.map((skill) => {
    const haystack = `${skill.id} ${skill.title} ${skill.description} ${(skill.tags ?? []).join(" ")}`.toLowerCase();
    let score = 0;
    if (profile.categories.includes(skill.category)) score += 6;
    for (const word of roleWords) if (haystack.includes(word)) score += 3;
    for (const word of domainWords) if (haystack.includes(word)) score += 1;
    // A skill from outside the domain's categories can still be right, but it has
    // to out-score everything inside them — otherwise a support hire arrives
    // carrying a robotics skill because one word overlapped.
    if (profile.categories.length && !profile.categories.includes(skill.category)) score *= 0.25;
    return { skill, score, unique: !used.has(skill.id) };
  });

  const ranked = scored
    .filter((row) => row.score > 0)
    .sort((a, b) => Number(b.unique) - Number(a.unique) || b.score - a.score || a.skill.id.localeCompare(b.skill.id));

  const picked = [];
  for (const row of ranked) {
    if (picked.length >= limit) break;
    picked.push(row.skill.id);
  }
  // A role with no signal still gets something specific to the domain rather
  // than nothing at all.
  if (picked.length === 0) {
    for (const skill of catalog.skills) {
      if (!profile.categories.includes(skill.category) || used.has(skill.id)) continue;
      picked.push(skill.id);
      if (picked.length >= limit) break;
    }
  }
  for (const id of picked) used.add(id);
  return picked;
}
