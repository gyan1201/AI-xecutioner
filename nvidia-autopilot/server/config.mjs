import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Runtime configuration.
 *
 * Precedence: explicit runtime settings (data/settings.json, written by the UI)
 * > environment variables > defaults. Keys are never logged or returned to the
 * browser; /api/settings only reports whether one is present and its last 4
 * characters.
 */
const DEFAULTS = {
  nimBaseUrl: "https://integrate.api.nvidia.com/v1",
  genaiBaseUrl: "https://ai.api.nvidia.com/v1/genai",
  port: 8787,
  simulation: null, // null = auto (simulate only when no key is configured)
  requestTimeoutMs: 180_000,
  maxConcurrency: 4,
  pricing: { inputPerMTok: null, outputPerMTok: null },
};

function envBoolean(value) {
  if (value == null || value === "") return null;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function envNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function dataDir() {
  return resolve(process.env.NVIDIA_AUTOPILOT_DATA_DIR || join(ROOT, "data"));
}

export const paths = {
  data: dataDir(),
  runs: join(dataDir(), "runs"),
  settings: join(dataDir(), "settings.json"),
  knowledge: join(dataDir(), "knowledge"),
};

export function ensureDataDirs() {
  for (const dir of [paths.data, paths.runs, paths.knowledge]) {
    mkdirSync(dir, { recursive: true });
  }
}

export function readRuntimeSettings() {
  try {
    if (!existsSync(paths.settings)) return {};
    const parsed = JSON.parse(readFileSync(paths.settings, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeRuntimeSettings(patch) {
  ensureDataDirs();
  const next = { ...readRuntimeSettings(), ...patch };
  writeFileSync(paths.settings, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(paths.settings, 0o600);
  } catch {
    /* best effort on platforms without POSIX modes */
  }
  return next;
}

/**
 * @returns {{
 *   apiKey: string,
 *   hasApiKey: boolean,
 *   simulation: boolean,
 *   nimBaseUrl: string,
 *   genaiBaseUrl: string,
 *   port: number,
 *   requestTimeoutMs: number,
 *   maxConcurrency: number,
 *   pricing: {inputPerMTok: number|null, outputPerMTok: number|null},
 * }}
 */
export function loadConfig() {
  const runtime = readRuntimeSettings();
  const apiKey = String(runtime.apiKey || process.env.NVIDIA_API_KEY || "").trim();
  const envSimulation = envBoolean(process.env.NIM_SIMULATION);
  const runtimeSimulation = typeof runtime.simulation === "boolean" ? runtime.simulation : null;
  const explicit = runtimeSimulation ?? envSimulation;
  return {
    apiKey,
    hasApiKey: apiKey.length > 0,
    // Simulation is available on demand, and is the default when no key exists
    // so the whole product (including auto mode) can be explored offline.
    simulation: explicit ?? apiKey.length === 0,
    nimBaseUrl: String(runtime.nimBaseUrl || process.env.NVIDIA_BASE_URL || DEFAULTS.nimBaseUrl).replace(/\/+$/, ""),
    genaiBaseUrl: String(
      runtime.genaiBaseUrl || process.env.NVIDIA_GENAI_BASE_URL || DEFAULTS.genaiBaseUrl,
    ).replace(/\/+$/, ""),
    port: envNumber(runtime.port || process.env.PORT, DEFAULTS.port),
    requestTimeoutMs: envNumber(process.env.NVIDIA_TIMEOUT_MS, DEFAULTS.requestTimeoutMs),
    maxConcurrency: envNumber(process.env.NVIDIA_MAX_CONCURRENCY, DEFAULTS.maxConcurrency),
    pricing: {
      inputPerMTok:
        envNumber(process.env.NVIDIA_PRICE_INPUT_PER_MTOK, null) ??
        envNumber(runtime.pricing?.inputPerMTok, null),
      outputPerMTok:
        envNumber(process.env.NVIDIA_PRICE_OUTPUT_PER_MTOK, null) ??
        envNumber(runtime.pricing?.outputPerMTok, null),
    },
  };
}

export function publicConfig(config = loadConfig()) {
  return {
    nimBaseUrl: config.nimBaseUrl,
    genaiBaseUrl: config.genaiBaseUrl,
    simulation: config.simulation,
    hasApiKey: config.hasApiKey,
    keyHint: config.apiKey ? `••••${config.apiKey.slice(-4)}` : null,
    pricing: config.pricing,
    maxConcurrency: config.maxConcurrency,
  };
}
