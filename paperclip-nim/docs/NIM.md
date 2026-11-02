# NIM surface

Everything in this app that costs money or produces text goes through `server/nim/client.mjs`. There is exactly one adapter per endpoint family, and every adapter returns the same envelope so calling code never branches on "is this real or simulated".

```js
{ text, reasoning, toolCalls, usage, artifacts, latencyMs, model, simulated, raw }
```

## Endpoint coverage

| Method + path | Client method | Used by |
| --- | --- | --- |
| `POST /chat/completions` | `chat({ model, messages, tools, responseFormat, … })` | agent runs, review, planning, chat, guardrails, translate, parse |
| `POST /chat/completions` (stream) | `chat({ onDelta })` | SSE run trace, agent chat, cycle log |
| `POST /completions` | `complete({ model, prompt })` | Studio → Raw |
| `POST /embeddings` | `embed({ model, input, inputType })` | knowledge ingestion, retrieval, Studio → Embeddings |
| `POST /ranking` | `rerank({ model, query, passages, topN })` | retrieval rerank, Studio → Rerank |
| `POST /genai/{model}` | `generateImage({ model, prompt, width, height, steps, seed })` | image artifacts, Studio → Image |
| `POST /genai/{model}` (video) | `generateVideo(…)` | catalog capability `video` |
| `POST /biology/{task}` | `biology({ model, task, … })` | BioNeMo, Studio → Biology |
| `GET /models` | `listModels()` | catalog sync, key verification |
| `GET /models` + probe chat | `probeModel({ model })` | Models → Probe |
| any path | `raw({ method, path, body })` | Studio → Raw |

Capability → model routing lives in `catalog.mjs`:

```js
DEFAULTS = {
  chat:      "nvidia/nemotron-3-super-120b-a12b",
  reasoning: "nvidia/nemotron-3-ultra-550b-a55b",
  fast:      "nvidia/nemotron-nano-3-30b-a3b",
  vision:    "nvidia/nemotron-3.5-super-vl-120b-a12b",
  code:      "mistralai/codestral-22b-instruct-v0.1",
  embed:     "nvidia/nemotron-3.5-embed-8b",
  rerank:    "nvidia/nv-rerankqa-mistral-4b-v3",
  image:     "google/diffusiongemma-26b-a4b-it",
  safety:    "nvidia/nemotron-3.5-content-safety",
  parse:     "nvidia/nemotron-parse-2.0",
  translate: "nvidia/riva-translate-4b-instruct-v2",
  reward:    "nvidia/nemotron-4-340b-reward",
}
```

Override with `NIM_DEFAULT_CHAT`, `NIM_DEFAULT_EMBED`, … A value that is not in the catalog is ignored, so a typo cannot take the app down.

## Errors

Failures are typed, never raw:

```json
{ "error": "NVIDIA rejected the credential. Check the key in Settings → API keys.",
  "code": "unauthorized", "hint": "..." }
```

* `401/403` → `unauthorized` / `forbidden` (no retry)
* `429/5xx/408` → retried with exponential backoff + jitter, then surfaced
* network failure → `network_error` with the base URL in the message
* `simulation_only` → the endpoint has no offline implementation (HTTP 400 with a hint)

`NimError` carries `status: 0` when the request never left the machine; the route layer maps that to 502 (or 400 for `simulation_only`) so nothing ever tries to `writeHead(0)`.

## Keys

Resolution order, first hit wins:

1. `data/settings.json` → `apiKey` (set from the Settings screen)
2. the active key in the vault (`data/keys.json`, mode `0600`)
3. `NVIDIA_API_KEY` from the environment

`server/nim/intake.mjs` accepts a bare key, an env line (`NVIDIA_API_KEY=nvapi-…`), an `Authorization:` header or a whole curl/SDK snippet, and extracts the `nvapi-…` token. New keys are verified with `GET /models` before being stored, and the UI only ever sees a mask (`nvapi-…3f9c`).

## Providers

`server/nim/providers.mjs` is the "one key, every model" layer. A provider is a base URL plus a key shape; the registry ships NVIDIA NIM, OpenAI, Groq, OpenRouter, Together, Mistral, DeepSeek, Fireworks, Perplexity and Anthropic, and any OpenAI-compatible host can be added as a custom endpoint.

Detection reads pasted snippets — Python, cURL, an env line, or a bare key — and returns the provider, base URL, key and model:

| Signal | Example | Strength |
| --- | --- | --- |
| base URL host | `base_url="https://integrate.api.nvidia.com/v1"` | conclusive |
| vendor key prefix | `nvapi-…`, `gsk_…`, `sk-or-v1-…`, `sk-ant-…`, `pplx-…` | conclusive |
| SDK import | `from groq import Groq` | indicative |
| plain `sk-…` | OpenAI-style keys are shared by several vendors | ambiguous, ask the user |

`OpenAI(base_url="…/chat/completions")` is collapsed to the provider root, `os.environ["NVIDIA_API_KEY"]` is reported as "nothing to extract, paste the key itself", and an unknown host becomes a custom OpenAI-compatible provider.

Connections live in `data/providers.json` (keys stay in `data/keys.json`). At call time the client resolves a model id to its provider and uses that base URL and key; everything else keeps using the NIM default, so adding a Groq key never repoints NVIDIA inference.

## From a goal to a blueprint

Full auto has to choose *which* of the 36 reference architectures a one-line goal describes. `blueprints.mjs` exposes `rankBlueprints(goal)`, which scores every blueprint on two signals:

* **Curated intents** — a table mapping the words people actually type to a blueprint (`support`, `helpdesk`, `ticket`, `response time` → Customer Service Voice Agent; `fraud`, `chargeback`, `self-checkout` → Retail Loss Prevention). This is what stops "cut support response time" landing on the knowledge copilot because it happens to contain the word "copilot".
* **Weighted lexical overlap** — name and category count more than prose, and a single token's contribution is capped, so a keyword repeated across a summary cannot outvote a domain match.

The winner supplies the roles, the models per role, and the NIM endpoint families the company will call. `launch.mjs` then rewrites the demo copy around the user's goal, replaces template names ("Blueprint Lead") with real ones, assigns two matching NVIDIA skills per agent, and composes the backlog: a metric/baseline issue, one issue per endpoint family the blueprint needs, the build steps, and a review gate — each with acceptance criteria.

In live mode the strategist model may draft the org instead (`draftMessages` → JSON → `normalizeDraft`). Anything malformed, over-sized, or referencing a model that is not in the catalog is repaired or discarded, and the deterministic blueprint plan is used. Simulation never invents a draft, so demos are reproducible.

## Simulation

`sim.mjs` implements every family locally:

* hash-seeded RNG, so the same prompt always produces the same answer (tests are stable)
* the same *shapes* as the real API — usage tokens, tool calls, verdict JSON, artifact data URIs
* embeddings are 1024-dim hashed bag-of-words vectors: cosine similarity behaves like a real embedding space, which is what retrieval needs
* every envelope is flagged `simulated: true`, and the UI prints "simulated" wherever a model call is shown

This is why the demo works with no network. It is not a claim to be a model.

## Adding a model

1. Append to `SNAPSHOT` in `server/nim/catalog.mjs`:

```js
{ id: "nvidia/new-nim", caps: "crto", ctx: 256, rate: "mid", family: "Nemotron", note: "What it is good at." }
```

`caps` letters: `c` chat · `r` reasoning · `t` tools · `o` code · `v` vision · `e` embedding · `k` rerank · `i` image · `d` video · `s` safety · `p` parse · `x` translate · `b` protein · `w` reward · `u` tabular · `z` pose.

2. Or do nothing: **Models → Sync live catalog** merges `GET /v1/models` and adds unknown IDs with inferred capabilities.
