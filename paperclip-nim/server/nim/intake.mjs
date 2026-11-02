/**
 * Credential intake.
 *
 * People paste keys in every shape: a bare token, an env line, a curl command,
 * a whole Python snippet. Pull the key out, guess a label, never log it.
 */

const KEY_PATTERN = /nvapi-[A-Za-z0-9_-]{16,}/;

export function parseCredentialText(text) {
  const raw = String(text ?? "");
  const match = raw.match(KEY_PATTERN);
  if (!match) return { key: "", label: "API key", source: null };
  const key = match[0];
  let label = "API key";
  const envLine = raw.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/m);
  if (envLine) label = envLine[1];
  else if (/curl/i.test(raw)) label = "Pasted from curl";
  else if (/python|openai/i.test(raw)) label = "Pasted from SDK snippet";
  return { key, label, source: /curl/i.test(raw) ? "curl" : /python|openai/i.test(raw) ? "sdk" : "bare" };
}

export function maskKey(key) {
  if (!key) return "";
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}
