/**
 * Configuration + credential storage.
 *
 * The API key never reaches the browser: the UI only ever sees a mask and a
 * verification state. Keys live in data/keys.json (mode 0600) and can be
 * rotated without a restart because every NIM call reads `resolve()`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
/** PAPERCLIP_DATA_DIR keeps tests (and throwaway demos) out of the real state. */
export const DATA_DIR = process.env.PAPERCLIP_DATA_DIR ? resolve(process.env.PAPERCLIP_DATA_DIR) : join(ROOT, "data");
export const paths = {
  root: ROOT,
  data: DATA_DIR,
  companies: join(DATA_DIR, "companies"),
  settings: join(DATA_DIR, "settings.json"),
  keys: join(DATA_DIR, "keys.json"),
  providers: join(DATA_DIR, "providers.json"),
  skills: join(DATA_DIR, "skills.json"),
  blueprints: join(DATA_DIR, "blueprints.json"),
  web: join(ROOT, "web"),
};

export function ensureDirs() {
  for (const dir of [paths.data, paths.companies]) mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonPrivate(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows / mounted volumes */
  }
}

export function maskKey(key) {
  if (!key) return "";
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

function sanitizeBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "https://integrate.api.nvidia.com/v1";
  let url;
  try {
    url = new URL(raw);
  } catch {
    const error = new Error("NIM base URL must be a valid http(s) URL.");
    error.status = 400;
    throw error;
  }
  if (!/^https?:$/.test(url.protocol)) {
    const error = new Error("NIM base URL must use http or https.");
    error.status = 400;
    throw error;
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`.replace(/\/+$/, "");
}

export function loadSettings() {
  ensureDirs();
  const stored = readJson(paths.settings, {});
  return {
    baseUrl: stored.baseUrl ?? process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1",
    apiKey: stored.apiKey ?? "",
    simulationOverride: stored.simulationOverride ?? false,
    activeCompanyId: stored.activeCompanyId ?? null,
    defaultRouting: stored.defaultRouting ?? {},
    telemetry: stored.telemetry ?? { runEvents: true },
    createdAt: stored.createdAt ?? new Date().toISOString(),
  };
}

export function saveSettings(patch) {
  const current = loadSettings();
  const next = { ...current, ...patch };
  if (patch?.baseUrl !== undefined) next.baseUrl = sanitizeBaseUrl(patch.baseUrl);
  writeJsonPrivate(paths.settings, next);
  return next;
}

/* -------------------------------------------------------------- key vault */

export function loadVault() {
  ensureDirs();
  const stored = readJson(paths.keys, { keys: [] });
  const keys = Array.isArray(stored.keys) ? stored.keys : [];
  return keys.map((entry) => ({
    id: entry.id,
    label: entry.label ?? "API key",
    key: entry.key,
    providerId: entry.providerId ?? null,
    baseUrl: entry.baseUrl ?? null,
    active: Boolean(entry.active),
    verified: Boolean(entry.verified),
    modelCount: entry.modelCount ?? null,
    lastCheckedAt: entry.lastCheckedAt ?? null,
    createdAt: entry.createdAt ?? new Date().toISOString(),
  }));
}

export function saveVault(keys) {
  writeJsonPrivate(paths.keys, { keys });
  return keys;
}

export function vaultView() {
  const keys = loadVault();
  return keys.map((key) => ({
    id: key.id,
    label: key.label,
    providerId: key.providerId,
    baseUrl: key.baseUrl,
    hint: maskKey(key.key),
    active: key.active,
    verified: key.verified,
    modelCount: key.modelCount,
    lastCheckedAt: key.lastCheckedAt,
    createdAt: key.createdAt,
  }));
}

/**
 * The active key for a provider. NVIDIA (and legacy entries saved before
 * providers existed, which have no `providerId`) are the default, so a Groq or
 * OpenAI key can never silently take over NIM inference.
 */
export function activeVaultKey({ providerId = "nvidia" } = {}) {
  const keys = loadVault();
  const matches = (key) => (providerId === "nvidia" ? !key.providerId || key.providerId === "nvidia" : key.providerId === providerId);
  return keys.find((key) => key.active && matches(key)) ?? keys.find((key) => matches(key)) ?? null;
}

export function addVaultKey({ key, label = "API key", providerId = null, baseUrl = null, verified = false, modelCount = null }) {
  const keys = loadVault();
  // Pasting the same key twice (or re-running Quick Setup) must not pile up
  // identical vault rows.
  const duplicate = keys.find((entry) => entry.key === key);
  if (duplicate) {
    saveVault(
      keys.map((entry) =>
        entry.id === duplicate.id
          ? { ...entry, label: label || entry.label, providerId: providerId ?? entry.providerId, baseUrl: baseUrl ?? entry.baseUrl, verified: verified || entry.verified, modelCount: modelCount ?? entry.modelCount }
          : entry,
      ),
    );
    if (providerId === "nvidia" || providerId === null) saveSettings({ apiKey: key });
    return duplicate.id;
  }
  const id = `key_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const sameProvider = keys.filter((entry) => (providerId ? entry.providerId === providerId : !entry.providerId));
  // A provider key becomes "active" only if its provider has no active key yet:
  // adding a Groq key must not repoint NIM inference at Groq.
  const makeActive = sameProvider.length === 0;
  const next = [
    ...keys.map((entry) => (makeActive ? { ...entry, active: false } : entry)),
    {
      id,
      key,
      label: label || "API key",
      providerId,
      baseUrl,
      active: makeActive,
      verified,
      modelCount,
      lastCheckedAt: verified ? new Date().toISOString() : null,
      createdAt: new Date().toISOString(),
    },
  ];
  saveVault(next);
  if (makeActive && (!providerId || providerId === "nvidia")) saveSettings({ apiKey: key });
  return id;
}

export function setActiveVaultKey(id) {
  const keys = loadVault();
  const target = keys.find((entry) => entry.id === id);
  if (!target) {
    const error = new Error("Unknown API key");
    error.status = 404;
    throw error;
  }
  // Only NVIDIA keys drive the default NIM credential; others stay provider-scoped.
  saveVault(
    keys.map((entry) =>
      entry.providerId === target.providerId || (!entry.providerId && !target.providerId)
        ? { ...entry, active: entry.id === id }
        : entry,
    ),
  );
  if (!target.providerId || target.providerId === "nvidia") saveSettings({ apiKey: target.key });
  return vaultView();
}

export function removeVaultKey(id) {
  const keys = loadVault();
  const removed = keys.find((entry) => entry.id === id);
  const next = keys.filter((entry) => entry.id !== id);
  saveVault(next);
  if (removed?.active) {
    const sameProvider = next.filter((entry) => (entry.providerId ?? null) === (removed.providerId ?? null));
    const fallback = sameProvider[0];
    if (!removed.providerId || removed.providerId === "nvidia") saveSettings({ apiKey: fallback?.key ?? "" });
    if (fallback) saveVault(next.map((entry) => (entry.id === fallback.id ? { ...entry, active: true } : entry)));
  }
  return vaultView();
}

/** Resolve the credential in precedence order: explicit setting → active vault → env. */
export function resolveCredential() {
  const settings = loadSettings();
  if (settings.apiKey) return { key: settings.apiKey, source: "settings" };
  const vault = activeVaultKey();
  if (vault?.key) return { key: vault.key, source: "vault" };
  if (process.env.NVIDIA_API_KEY) return { key: process.env.NVIDIA_API_KEY, source: "env" };
  return { key: "", source: "none" };
}

export function runtimeConfig() {
  const settings = loadSettings();
  const { key, source } = resolveCredential();
  const forceSimulation = process.env.FORCE_SIMULATION === "1" || settings.simulationOverride;
  return {
    baseUrl: settings.baseUrl,
    apiKey: key,
    keySource: source,
    keyHint: maskKey(key),
    simulation: forceSimulation || !key,
    simulationOverride: settings.simulationOverride,
    timeoutMs: Number(process.env.NIM_TIMEOUT_MS ?? 180_000),
    maxRetries: Number(process.env.NIM_MAX_RETRIES ?? 3),
    port: Number(process.env.PORT ?? 8790),
  };
}

export function publicConfig() {
  const cfg = runtimeConfig();
  const vault = vaultView();
  return {
    mode: cfg.simulation ? "simulation" : "live",
    baseUrl: cfg.baseUrl,
    keySource: cfg.keySource,
    keyHint: cfg.keyHint,
    keyPresent: Boolean(cfg.apiKey),
    simulationOverride: cfg.simulationOverride,
    vault,
    hasVaultKey: vault.length > 0,
    port: cfg.port,
    paths: { data: paths.data },
  };
}

/* ------------------------------------------------------- data hygiene */

export function pruneOrphanCompanies(validIds) {
  if (!existsSync(paths.companies)) return [];
  const removed = [];
  for (const entry of readdirSync(paths.companies, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (validIds.includes(entry.name)) continue;
    rmSync(join(paths.companies, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}

export function fileMode(file) {
  try {
    return (statSync(file).mode & 0o777).toString(8);
  } catch {
    return null;
  }
}

/**
 * One-time boot migrations.
 * Keys pasted before the vault existed live in settings.json; move them into the
 * vault so rotation and multi-account work without an operator doing anything.
 */
export function runMigrations() {
  try {
    ensureDirs();
    const settings = loadSettings();
    if (settings.apiKey) {
      const vault = loadVault();
      if (!vault.length) {
        writeJsonPrivate(paths.keys, {
          keys: [
            {
              id: `key_legacy`,
              key: settings.apiKey,
              label: "Migrated key",
              active: true,
              verified: false,
              modelCount: null,
              lastCheckedAt: null,
              createdAt: new Date().toISOString(),
            },
          ],
        });
      }
    }
  } catch (error) {
    console.warn("[config] migration skipped:", error?.message);
  }
}
