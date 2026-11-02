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
