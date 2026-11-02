# NVIDIA Autopilot

**One company goal in. A staffed company that runs itself, out.** Every NVIDIA NIM
capability — chat, reasoning, tool calling, vision, embeddings, reranking,
guardrails, image generation — wired into one control room, with two engines on
top: an **autopilot** that delivers a single goal, and a **Company OS** that
builds the organization (departments, hires, goals, budgets, approvals, board) on
[Paperclip](https://github.com/paperclipai/paperclip)'s operating model and can
mirror it into a live Paperclip instance.

```bash
cd nvidia-autopilot
npm start            # http://localhost:8787
```

No build step, no runtime dependencies, Node ≥ 20. With no API key the app runs
in **deterministic simulation mode** so every screen and the full auto mode are
explorable offline. Add a key from [build.nvidia.com](https://build.nvidia.com)
in **Settings** to switch to live inference.

---

## Company OS — the company, not just the goal

`#/companies` turns one sentence into an operating company:

```bash
curl -s localhost:8787/api/companies -H 'content-type: application/json' -d '{
  "name": "Northwind Labs",
  "goal": "Reach $20k MRR in 90 days with self-serve onboarding, no new headcount.",
  "budgetMonthlyCents": 5000,
  "settings": { "approvalPolicy": "high" }
}'
```

| Layer | What you get |
| --- | --- |
| **Org design** | A NIM strategist designs departments, a roster with titles, managers, capabilities and budget shares, company goals with KPIs, a project and a backlog. Malformed model output falls back to a deterministic blueprint. |
| **People** | Hire, retitle, rebudget, pause, change model or let anyone go. Every agent has a model, an owner and a monthly cap. |
| **Board** | Issues with keys (`NW-3`), priorities, acceptance criteria, `blockedBy` dependencies, comments, deliverables and review verdicts — Paperclip's enums exactly. |
| **Money** | One ledger row per model call with exact tokens; sub-cent precision; `over_budget` agents are skipped; nobody spends past their cap (not even the CEO's planning call). |
| **Approvals** | Risky/public issues park as `blocked` with a board approval; agents can also escalate from inside a tool call. Approving releases the issue to the next cycle. |
| **Cycles** | CEO sets the focus and assignments → employees work with tools and citations → quality lead accepts or sends back (rework limit) → scribe writes an end-of-cycle standup. |
| **Auto mode** | A cycle every N minutes until the budget, the backlog, the approval queue or `maxCycles` stops it — with the reason recorded. Survives a restart. |
| **Paperclip bridge** | Preview then push the company into a real Paperclip server (company → agents → goals → issues) over its REST API; typed, actionable errors when it cannot. |
| **Audit** | `data/companies/<id>/events.ndjson` plus a live SSE stream, artifact downloads and a portable export bundle. |

Full detail: [`docs/company-os.md`](docs/company-os.md).

---

## What auto mode actually does

Give it a goal — *"Make self-serve onboarding reach 20% QoQ activation growth"* —
and the engine runs a staffed operating cycle:

| Step | Agent | What happens |
| --- | --- | --- |
| 1. Screen | Safety | The goal is classified by an NVIDIA safety NIM before any work starts. Restricted goals never reach a planner. |
| 2. Plan | Strategist | Returns strict JSON: objective, KPIs, assumptions, 3–6 work items with owners, dependencies, risk and a **testable definition of done**. |
| 3. Retrieve | Embedder + Reranker | Each work item queries the company knowledge base (embed → cosine shortlist → NIM rerank) so work is grounded and cited `[K1]`, `[K2]`. |
| 4. Execute | Analyst / Operator | Model runs with tool calling: `search_knowledge`, `calculate`, `save_artifact`, `safety_check`, `generate_visual`, `escalate_to_human`. |
| 5. Review | Critic | Scores the deliverable against its definition of done and returns required changes; up to two revision loops. |
| 6. Guardrail | Safety | Every shipped output is screened. Unsafe output blocks the work item. |
| 7. Report | Scribe | Board-ready executive report with KPI scoreboard, risks, open decisions and next actions. |

Humans stay in the loop through **policy, not supervision**:

- **Approval gates** — `never` / `high-risk only` / `every work item`. High-risk
  work (spend, legal, public, irreversible) pauses the run until someone decides.
- **Budget ceilings** — max work items, max tokens, max wall-clock minutes,
  concurrency limit. Breaching a ceiling stops the run with an explicit blocker.
- **Guardrails** — goal + output screening, plus an agent-callable `safety_check`.
- **Full audit trail** — every model call, tool call, guardrail verdict and
  state change is appended to `data/runs/<id>/events.ndjson` and replayable.
- **Resumable** — pause, resume after a restart, cancel, approve/reject.

Every deliverable is written to `data/runs/<id>/artifacts/` and shown in the run
view: markdown plans, memos, playbooks, generated images and the final report.

---

## Every NIM function, and where it lives

| Capability | Endpoint used | Surface |
| --- | --- | --- |
| Chat / reasoning / tool calling | `POST /v1/chat/completions` (stream + non-stream) | Chat lab, autopilot agents |
| Legacy completion | `POST /v1/completions` | `/api/complete` |
| Vision (image in, text out) | `chat/completions` with `image_url` parts | Chat lab → Attach image |
| Structured JSON output | `response_format: {type: json_object}` + tolerant parser | Chat lab, planner, critic |
| Embeddings | `POST /v1/embeddings` with `input_type: query|passage` | Knowledge & RAG |
| Reranking | `POST /v1/ranking` (`{query:{text}, passages:[{text}]}`) | Knowledge & RAG, autopilot |
| Safety / jailbreak / PII | guard models over `chat/completions` | Guardrails, goal + output screening |
| Image generation | `POST {genai}/{publisher}/{model}` → `artifacts[].base64` | Visual studio, `generate_visual` tool |
| Model catalog | `GET /v1/models` | Models & routing |
| Anything else (audio, video, BioNeMo, RAG, NIM functions) | `POST /api/raw` passthrough on the configured NIM base URL | API (`/api/raw`) |

The hosted endpoint is `https://integrate.api.nvidia.com/v1`; visual generation
uses `https://ai.api.nvidia.com/v1/genai`. Point both at a self-hosted NIM
container (`http://localhost:8000/v1`) to keep data on your own GPUs — every
code path is identical.

---

## Quickstart

```bash
# 1. run it (simulation mode: no key needed)
cd nvidia-autopilot && npm start

# 2. optional: seed a demo company (runs on NIM) + a finished autopilot run
node scripts/seed-demo.mjs

# 3. live inference
cp .env.example .env            # or use the Settings screen
export NVIDIA_API_KEY=nvapi-...
npm start
```

Open <http://localhost:8787>. Create a key at
[build.nvidia.com](https://build.nvidia.com) → any model → **Get API key**.

### Connect by pasting anything

**Settings → Connect NVIDIA** takes the whole request snippet, not just the key.
It extracts the credential, the endpoints, the model ids and the request
parameters, verifies the key against NVIDIA, and configures the app — one paste:

```bash
curl -s localhost:8787/api/settings/key -H 'content-type: application/json' -d @- <<'JSON'
{ "text": "headers = {"Authorization": "Bearer nvapi-…"}
payload = {"model": "mistralai/mistral-large-4-1t-a52b", "reasoning_effort": "high"}" }
JSON
```

| Accepted as-is | Extracted |
| --- | --- |
| `nvapi-…` | key |
| `export NVIDIA_API_KEY=nvapi-…`, `NVIDIA_API_KEY: nvapi-…` | key |
| `"Authorization": "Bearer nvapi-…"` (curl, python, JS, Go, YAML) | key |
| `invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"` | base URL (path stripped to `/v1`), so self-hosted `http://localhost:8000/v1` works too |
| `https://ai.api.nvidia.com/v1/genai/{publisher}/{model}` | visual generative AI base URL |
| `"model": "publisher/model-id"`, `model: publisher/model-id` | default chat model + a selectable catalog entry, even when discovery is offline |
| `temperature`, `top_p`, `max_tokens`, `frequency_penalty`, `presence_penalty`, `reasoning_effort` | Chat lab defaults (and a `reasoning_effort` control) |
| `image_url` / `data:image/…` | vision enabled |

Behaviour worth knowing:

- **Verification gates the mode.** The key is tested against `GET /v1/models`
  first. Success ⇒ the app switches to live inference by itself. A rejection
  (401/403/429) or an unreachable host ⇒ the key is still saved, the reason is
  shown, and simulation stays on so nothing breaks — press **Test live** or
  **Go live anyway** when the network allows it.
- **Keys are never echoed.** Responses carry `••••qNQZ` only; the file is
  `data/settings.json` at mode `0600`.
- **Bad input is a 422 with a hint**, not a silent no-op: masked keys, truncated
  keys and prose without a key are all called out.
- `POST /api/settings/key/verify` re-tests the stored credential, and
  `PUT /api/settings` still accepts a plain key for scripts.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `NVIDIA_API_KEY` | — | NIM credential. Empty ⇒ simulation. |
| `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | Chat, embeddings, rerank, models |
| `NVIDIA_GENAI_BASE_URL` | `https://ai.api.nvidia.com/v1/genai` | Visual generative AI |
| `NIM_SIMULATION` | auto | `1` forces simulation even with a key |
| `PORT` | `8787` | HTTP port (binds `0.0.0.0`) |
| `NVIDIA_AUTOPILOT_DATA_DIR` | `./data` | Runs, knowledge index, settings |
| `NVIDIA_TIMEOUT_MS` | `180000` | Per-request timeout |
| `NVIDIA_MAX_CONCURRENCY` | `4` | Upper bound for run concurrency |
| `NVIDIA_PRICE_INPUT_PER_MTOK` / `..._OUTPUT_...` | — | Optional cost estimate |
| `PAPERCLIP_API_BASE` | — | Paperclip API root, e.g. `http://localhost:3100/api` |
| `PAPERCLIP_API_KEY` | — | Paperclip board bearer token |

Settings saved in the UI (`data/settings.json`, mode 0600) take precedence over
the environment. The API key is never returned to the browser — only a masked
hint.

---

## The app

| Screen | What it is for |
| --- | --- |
| **Mission control** | Give a goal, set policy, see what the company is doing right now. |
| **Company OS** | Build a company from a goal, then run its org chart, board, finances, approvals and auto mode — and mirror it into Paperclip. |
| **Autopilot** | Live run timeline, plan, work items, reviews, artifacts, executive report, approvals. |
| **Chat lab** | Streaming playground: model picker, temperature, JSON mode, agent tools, vision attachments. |
| **Knowledge & RAG** | Add company documents, index them, test embed → rerank retrieval with scores. |
| **Models & routing** | Live catalog from `build.nvidia.com`, filter by capability, pin a model per agent role. |
| **Guardrails** | Screen any text with NVIDIA safety models and see the raw verdict. |
| **Visual studio** | Prompt → image via hosted diffusion endpoints, with prompt rewriting by a NIM. |
| **Settings** | Paste-anything key intake, endpoints, cost rates, simulation switch, extracted defaults, data locations. |

Agent roles resolve automatically: the first pinned model that exists in the live
catalog wins, otherwise the highest-capability discovered model, otherwise a
curated default. Every role is pinnable in **Models & routing**.

---

## API

```text
GET    /api/status                 config, roles, counts (never the key)
POST   /api/settings/key           paste a key or snippet → parse, verify, configure
POST   /api/settings/key/verify    re-test the stored credential
GET    /api/models                 live catalog + capability labels + role routing
POST   /api/chat                   chat completion
POST   /api/chat/stream            SSE token stream
POST   /api/embeddings             embeddings
POST   /api/rerank                 rerank + ordered passages
POST   /api/images                 image generation
POST   /api/guardrails             safety verdict
POST   /api/raw                    any other NIM endpoint (path-only)

GET    /api/knowledge              documents + index stats
POST   /api/knowledge              add a document
POST   /api/knowledge/index        chunk + embed pending documents
POST   /api/knowledge/search       retrieve (cosine + rerank)

POST   /api/autopilot              start a goal
GET    /api/autopilot              list runs
GET    /api/autopilot/:id          run + artifacts + events
GET    /api/autopilot/:id/stream   SSE run events
POST   /api/autopilot/:id/{pause,resume,cancel,approve}
GET    /api/autopilot/:id/artifacts/:name

GET    /api/companies              list companies with counts + auto-mode state
POST   /api/companies              build a company from { name, goal, ... }
GET    /api/companies/:id          company + summary + artifacts + events
PATCH  /api/companies/:id          name, mission, budget, status, settings
DELETE /api/companies/:id
POST   /api/companies/:id/agents   hire        PATCH/DELETE .../agents/:agentId
POST   /api/companies/:id/issues   add         PATCH .../issues/:issueId
POST   /api/companies/:id/issues/:issueId/comments
POST   /api/companies/:id/cycles   run one cycle (async: true supported)
POST   /api/companies/:id/auto     { enabled, everyMinutes, maxCycles }
POST   /api/companies/:id/approvals/:approvalId   { approved, note }
GET    /api/companies/:id/{events,stream,export,artifacts/:name}
POST   /api/paperclip/{probe,mirror}
```

Start a run:

```bash
curl -s localhost:8787/api/autopilot -H 'content-type: application/json' -d '{
  "goal": "Cut support resolution time in half without adding headcount",
  "company": "Northwind Labs",
  "companyContext": "12 agents, Zendesk, no new hires this quarter",
  "options": { "maxSteps": 5, "requireApproval": "high", "maxTokens": 200000 }
}'
```

---

## Architecture

```text
nvidia-autopilot/
├─ server/
│  ├─ index.mjs        HTTP server, SSE broadcast, lifecycle
│  ├─ routes.mjs       REST surface (no framework, no deps)
│  ├─ runtime.mjs      service wiring, model cache, role overrides
│  ├─ nim.mjs          NVIDIA NIM client: retries, timeouts, SSE, errors
│  ├─ autopilot.mjs    plan → execute → review → report state machine
│  ├─ tools.mjs        agent tool runtime (incl. a safe expression parser)
│  ├─ retrieval.mjs    chunk → embed → cosine → rerank RAG
│  ├─ catalog.mjs      model presets, capability inference, role routing, tools
│  ├─ company/         Company OS: store.mjs (state, ledger, approvals),
│  │                   org.mjs (goal → org design), service.mjs (cycles, auto mode)
│  ├─ paperclip.mjs    Paperclip REST bridge (preview, mirror, typed errors)
│  ├─ keyintake.mjs    find key/endpoints/models/params in any pasted text
│  ├─ store.mjs        file-backed runs, events, artifacts, knowledge
│  ├─ config.mjs       settings precedence + 0600 secret storage
│  └─ sim.mjs          deterministic offline NIM simulator
├─ web/                dependency-free SPA (ES modules, hash routing)
│  ├─ app.js  lib.js  styles.css  index.html
│  └─ views/           dashboard, autopilot, chat, knowledge, models,
│                      guardrails, studio, companies, settings
├─ scripts/seed-demo.mjs
└─ test/               46 tests: engine, tools, retrieval, company, bridge, credential intake, HTTP, UI
```

Design choices worth knowing:

- **No runtime dependencies.** The server is `node:http` + `node:fs`; the UI is
  plain ES modules. Nothing to audit, nothing to upgrade, runs anywhere Node runs.
- **File-backed state.** Self-hosted, single-node, inspectable. `events.ndjson`
  is append-only so a run can be replayed event by event after a restart.
- **Simulation is a first-class mode**, not a stub: deterministic plans, reviews,
  guardrails, embeddings and images so the whole product can be demoed in CI.
- **Provider-agnostic by construction** — every NIM call goes through
  `nim.mjs`, so swapping the base URL to a self-hosted NIM changes nothing else.

---

## Tests

```bash
npm test                                      # 46 tests, no network, no key
npm i --no-save jsdom && npm test             # + UI render smoke test
```

Covers: role resolution and capability inference, the calculator parser,
chunking/similarity, JSON recovery, a full goal run end-to-end (plan, tools,
reviews, guardrails, report, artifacts, event ordering), pause/resume/cancel,
approval gating, budget hard-stops, company creation and cycles, auto mode limits,
per-agent budgets, the Paperclip bridge (dry run, mirror, error hints), credential
intake (snippet/bare-key/env-line parsing, verification that separates a bad key
from an unreachable host, and never echoing the secret), every HTTP route, and
that each view — including every Company OS tab — renders against the live API.

---

## Security and operating notes

- **No authentication.** Run it on a trusted network or behind your own proxy.
  It is a single-operator console, not a multi-tenant service.
- **Secrets stay local.** The key lives in `data/settings.json` (mode 0600) or the
  environment, and is only ever sent to the NIM base URL you configure.
- **Tool execution is server-side.** Models can only call the six declared tools;
  artifact filenames are sanitised, the calculator is a real parser (no `eval`),
  and `/api/raw` accepts paths, never URLs.
- **Costs are estimates.** NVIDIA prices vary per model — set your rate in
  Settings; token counts are always exact.
- **Not included as first-class UI:** audio, video and BioNeMo NIMs. They are
  reachable through `/api/raw` today; the client and catalog are structured so a
  dedicated panel is additive rather than a rewrite.

---

## Paperclip, both directions

This repository also contains [Paperclip](../paperclip), the agent-company control
plane. The two integrate in both directions:

- **Here → Paperclip.** Company OS mirrors a company into a live Paperclip server
  (company, agents with budgets, goals, issues) over its REST API — preview the
  calls first, then push. See [`docs/company-os.md`](docs/company-os.md#4-the-paperclip-bridge).
- **NVIDIA models → Paperclip agents.** NIM is OpenAI-compatible, so Paperclip
  agents can run on NVIDIA models without patching its provider enum — connect NIM
  as a **Chat Completions API** gateway. See
  [`docs/paperclip-integration.md`](docs/paperclip-integration.md) for the exact
  endpoint, env key and model ids, plus using this app as the retrieval/autopilot
  sidecar next to a Paperclip board.

Licence: MIT (inherited from this repository).
