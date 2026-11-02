# HTTP API

Base URL: `http://localhost:8790`. All responses are JSON unless noted. Errors look like `{ "error": "...", "code": "...", "hint": "..." }` with a 4xx/5xx status.

Two endpoints stream: `…/cycle?stream=1`, `…/issues/:issueId/run?stream=1`, `…/agents/:agentId/chat` and `/api/events`. They emit `text/event-stream` frames named `delta`, `done`, `error`, `event`, `ping`.

## System

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | uptime, mode, company count |
| GET | `/api/status` | NIM status, catalog, skills/blueprints counts, companies |
| GET | `/api/bootstrap` | everything the shell needs to render: companies, active company, counts, public config (no keys), capability map |
| GET | `/api/events?replay=0` | SSE firehose of engine events (`run.step`, `ledger.recorded`, `cycle.finished`, …) |

## Companies

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/api/companies` | list + `activeCompanyId` |
| POST | `/api/companies` | `{ name, mission?, blueprintId?, budgetMonthlyCents? }` |
| GET | `/api/companies/:id` | full document: agents, issues, goals, projects, runs, ledger, approvals, activity, routines, knowledge, artifacts |
| PATCH | `/api/companies/:id` | `{ name?, mission?, settings? }` — settings include `approvalPolicy`, `monthlyBudgetCents`, `cycleMinutes`, `maxCycles`, `reworkLimit`, `autoMode`, `guardrails`, `defaultModels` |
| DELETE | `/api/companies/:id` | deletes the document, activates the next company |
| POST | `/api/companies/:id/activate` | switch the active company |
| GET | `/api/companies/:id/dashboard` | `stats`, `agents`, `charts.byDay` (14 days), `recentActivity`, `recentIssues`, `spend`, `cycles` |
| GET | `/api/companies/:id/inbox` | `items[]` of approvals / blocked issues / failed runs |
| GET | `/api/companies/:id/ledger` | `rows[]` (newest first) + `totalCents` |
| GET | `/api/companies/:id/org` | `agents[]` with `reportsTo` for tree building |
| GET | `/api/companies/:id/export` | portable bundle (re-importable) |
| POST | `/api/companies/:id/auto` | `{ enabled? }` toggle the scheduler |
| POST | `/api/companies/import` | import a bundle |

## Cycles and planning

| Method | Path | Body / notes |
| --- | --- | --- |
| POST | `/api/companies/:id/cycle` | `{ maxIssues? }`; `?stream=1` for SSE. Returns `{ plan, results[], cycle, standup, company }` |
| POST | `/api/companies/:id/plan` | planning call only: `{ plan, run, applied }` |

`plan` = `{ focus, rationale, assignments[{ title, owner, why, priority }], risks[], citations[] }`. Assignment titles are bare board titles; `applied` counts issues reassigned/reprioritised.

## Agents

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/companies/:id/agents` | roster with `spend` and `openIssues` |
| POST | `/api/companies/:id/agents` | `{ name, title, role, reportsTo?, model, description?, instructions?, monthlyBudgetCents?, capabilities?, skills? }` |
| GET | `/api/companies/:id/agents/:agentId` | profile: agent, spend, issues, runs, state, skills |
| PATCH | `/api/companies/:id/agents/:agentId` | any editable field |
| DELETE | `/api/companies/:id/agents/:agentId` | reassigns open work |
| PUT | `/api/companies/:id/agents/:agentId/skills` | `{ skills: [skillId] }` |
| POST | `/api/companies/:id/agents/:agentId/chat` | SSE. Body `{ message, issueId? }`; `done` carries `{ text, citations, tools, run }` |

## Issues

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/companies/:id/issues` | query: `status`, `assigneeId`, `projectId`, `goalId`, `q`, `limit` |
| POST | `/api/companies/:id/issues` | `{ title, description?, priority?, status?, assigneeId?, projectId?, goalId?, acceptance? }` |
| GET | `/api/companies/:id/issues/:issueId` | issue + comments + runs + artifacts + approvals |
| PATCH | `/api/companies/:id/issues/:issueId` | any field |
| DELETE | `/api/companies/:id/issues/:issueId` | |
| POST | `/api/companies/:id/issues/:issueId/comments` | `{ body }` |
| POST | `/api/companies/:id/issues/:issueId/run` | `?stream=1`. Returns `{ run, issue, verdict, blocked, reason }` |

A run executes seven steps and appends `run.steps[]`. `verdict` is `{ verdict: "accepted" \| "changes_requested", score, reviewerId, summary }`. Blocked runs return `blocked: true` with a human-readable `reason` (budget, approval, guardrail) and never charge the ledger.

## Approvals

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/companies/:id/approvals` | pending + decided, each with its issue |
| POST | `/api/companies/:id/approvals/:approvalId/decide` | `{ decision: "approve" \| "deny", note? }` |

## Goals, projects, routines, knowledge

| Method | Path | Notes |
| --- | --- | --- |
| GET/POST | `/api/companies/:id/goals` | `{ title, metric?, unit?, baseline?, current?, target?, ownerId? }` |
| PATCH | `/api/companies/:id/goals/:goalId` | |
| GET/POST | `/api/companies/:id/projects` | `{ name, description?, color? }` |
| PATCH | `/api/companies/:id/projects/:projectId` | |
| GET/POST | `/api/companies/:id/routines` | `{ name, agentId?, instruction?, cadenceMinutes?, enabled? }` |
| PATCH | `/api/companies/:id/routines/:routineId` | |
| POST | `/api/companies/:id/routines/:routineId/run` | runs the routine now, returns the run |
| GET/POST | `/api/companies/:id/knowledge` | `{ title, body, tags? }` |
| PATCH/DELETE | `/api/companies/:id/knowledge/:docId` | re-embeds on update |
| POST | `/api/companies/:id/knowledge/search` | `{ query, topK? }` → `passages[]` with `score` and `rerankScore` |

## NVIDIA catalogs

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/models` | query: `q`, `capability`, `family`, `refresh=1`. Returns `models`, `summary`, `capabilities`, `live`, `error` |
| POST | `/api/models/refresh` | merge the live `/v1/models` list |
| POST | `/api/models/probe` | `{ model }` → `{ ok, latencyMs, sample }` |
| GET | `/api/skills` | query: `q`, `category`, `tag`, `limit`, `offset` → `{ total, items, meta }` |
| GET | `/api/skills/meta` | counts, categories, source, syncedAt |
| GET | `/api/skills/:skillId` | full skill incl. instructions |
| GET | `/api/skills/suggest` | `?q=` or `?text=` → ranked skills worth assigning |
| GET | `/api/blueprints` | query: `q`, `category` → `{ blueprints, stats }` |
| GET | `/api/blueprints/:blueprintId` | one blueprint |
| POST | `/api/companies/:id/blueprints/:blueprintId` | deploy: staffs agents, creates a goal + backlog, returns the plan |

## Providers (one key, every model)

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/providers` | `{ providers, available, connected, nvidia, config }` — connections, the provider registry, and how many models are wired |
| POST | `/api/providers/detect` | `{ text }` → detection only, no writes: `{ providerId, provider, baseUrl, model, keyMasked, hasKey, confidence, signals, warnings }`. The raw key is never returned |
| POST | `/api/providers/apply` | `{ text?, providerId?, key?, model?, baseUrl?, label? }` → detects, stores the key in the vault (0600), records the connection, adds the model, returns `{ ok, message, provider, model, verified, detail, config }` |
| POST | `/api/providers/:providerId/models` | `{ model }` — add another model to a connection (idempotent) |
| DELETE | `/api/providers/:providerId` | remove the connection and its stored key |

`POST /api/providers/apply` accepts a bare key as well as a snippet, so "add one NVIDIA key → unlock all 97 models" is a single call:

```bash
curl -X POST localhost:8790/api/providers/apply \
  -H 'Content-Type: application/json' \
  -d '{"providerId":"nvidia","key":"nvapi-..."}'
```

Verification is best effort: when the host cannot reach the provider the connection is still saved (the UI says so, and NVIDIA stays in simulation until the key is verified or `simulationOverride` is turned off).

## Studio (raw NIM calls)

| Method | Path | Body |
| --- | --- | --- |
| POST | `/api/studio/chat` | `{ model?, system?, prompt?, messages?, temperature?, maxTokens? }` |
| POST | `/api/studio/embed` | `{ model?, input \| input[], inputType? }` → `dimensions`, `preview[{ nonzero, norm, top[[dim, value]] }]` |
| POST | `/api/studio/rerank` | `{ model?, query, passages[] , topN? }` → `rankings[]` |
| POST | `/api/studio/image` | `{ model?, prompt, width?, height?, steps?, seed? }` → `artifacts[{ mimeType, dataUri }]` |
| POST | `/api/studio/safety` | `{ model?, text }` → `{ verdict, score, rationale, categories }` |
| POST | `/api/studio/parse` | `{ model?, image, prompt? }` |
| POST | `/api/studio/translate` | `{ model?, text, source?, target? }` |
| POST | `/api/studio/biology` | `{ model?, task, sequence }` |
| POST | `/api/studio/raw` | `{ method?, path, body?, query? }` — passthrough; in simulation `/chat/completions`, `/completions`, `/embeddings`, `/ranking` and `/models` are answered locally, everything else is a typed 400 |

## Settings, keys, data

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/settings` | public config + settings (never the key) |
| PATCH | `/api/settings` | `{ baseUrl?, simulationOverride? }` |
| GET | `/api/keys` | vault entries (id, label, mask, active, verified, modelCount) |
| POST | `/api/keys` | `{ text, label? }` — parses any snippet, verifies, stores 0600 |
| PATCH | `/api/keys/:keyId` | `{ active: true }` |
| DELETE | `/api/keys/:keyId` | |
| POST | `/api/keys/verify` | verifies the resolved key (400 when there is none) |
| POST | `/api/data/reset` | `{ confirm: "RESET" }` re-seeds the demo company |
| POST | `/api/data/prune` | removes orphaned company directories |

## Static

`GET /` and any non-`/api/` path serve `web/`. Unknown client-side routes fall back to `index.html`; traversal outside `web/` is rejected with 403.
