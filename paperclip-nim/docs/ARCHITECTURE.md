# Architecture and invariants

## Shape

```
HTTP request ──► routes.mjs ──► engine / service ──► store (JSON + NDJSON)
                                    │
                                    ├── nim client ──► NIM (live) or sim.mjs
                                    └── usage.mjs (AsyncLocalStorage) ──► ledger rows
```

* **`store.mjs`** owns durability: one JSON document per company, rewritten on save, plus event-bus publication. Writes are serialised through `store.withCompany`, so a run and a ledger append cannot interleave with a UI patch.
* **`engine.mjs`** owns behaviour: `planOnly`, `planCycle`, `runIssue`, `chat`, `runRoutine`, `decideApproval`, the scheduler.
* **`service.mjs`** owns read models: the shapes the UI renders. Views never stitch entity state together themselves.
* **`domain/launch.mjs`** owns the full-auto planning step: it reads the goal, ranks the 37 blueprints (curated intents + weighted lexical overlap), rewrites the winner's team and backlog around the goal, and validates a model-authored draft when one is available. It is pure — no store, no network — so the same brief always produces the same company.
* **`nim/client.mjs`** is the only place that speaks HTTP to NVIDIA, and the only place that knows about live vs simulated.
* **`web/`** is a thin client: 20 view modules with `render(root, ctx)`, a hash router, one SSE firehose, and helpers in `lib.js`.

## The launch loop

`POST /api/launch` is the front door: name + goal + optional keys in, a working company out. It is deliberately the same machinery as everything else — it configures providers through `configureProviderInput` (shared with `/api/providers/apply`), creates the company through `createCompany({ plan })`, and runs the first cycle through `planCycle`. No private code path, which means anything it builds can be edited by hand afterwards.

1. **Configure** — each pasted credential becomes a vault entry + provider row; verification is best effort and never blocks the launch.
2. **Plan** — `planForGoal` ranks blueprints against the goal. Live mode may instead ask the strategist for a JSON org (`normalizeDraft` repairs or rejects it; the blueprint plan is always the fallback).
3. **Create** — one agent per role (real names, two matched NVIDIA skills each), a goal whose title is the user's goal, and a backlog of six or so issues with acceptance criteria.
4. **Run** — the first cycle is the normal cycle path; a failure is reported as a step, not as a failed launch.

Progress is emitted as SSE `step` / `progress` frames with stable ids (`brief`, `provider`, `plan`, `company`, `auto`, `cycle`, `done`), so a client can replace a step in place instead of appending duplicates.

## The run loop

`runIssue` is the core product behaviour. It is intentionally deterministic in its ordering:

1. **Plan** — resolve assignee, budget gate (only when a cap is set), approval gate.
2. **Guardrail (input)** — safety NIM over the issue brief.
3. **Retrieve** — chunk the knowledge base, embed, cosine search, rerank.
4. **Tools** — the agent may call `knowledge_search`, `calculator`, `create_artifact`, `generate_image`, `check_safety`, `escalate` or `update_issue`, bounded by `MAX_TOOL_HOPS` (3).
5. **Deliverable** — streamed completion, saved as a run output and an artifact.
6. **Guardrail (output)** — a failing output stops the run before review.
7. **Quality review** — a critic agent returns JSON `{verdict, score, findings[], measurement}`; a rejection returns the issue to `todo`, records the attempt, and the next run is labelled `Review attempt: N`. An accepted measurement is written to the goal: the first one sets the baseline, later ones move `current`, and the goal keeps the history with its source.

Every model call is wrapped in `withUsageContext({ companyId, runId, agentId, sink })`. The sink writes a ledger row from the NIM usage event, so **the ledger is derived from real usage, not estimated after the fact** — including simulated usage, which keeps the spend screens honest in demo mode.

Invariants worth keeping:

* Money is stored in cents with two decimals (`0.52`, not `1`); never round to whole cents or simulated spend disappears.
* A measurement is evidence, not a claim: only an accepted issue records one, the first sets the baseline, later ones move `current`, and a unit that does not match the goal is ignored. A run that only quotes an older number does not move the metric.
* A blocked run is still a run with a trace, but it never appends a ledger row.
* `run.steps[]` is the audit trail. If a step is not in `steps`, it did not happen.
* Events are published after state is saved, so a subscriber that refetches sees the new state.

## Simulation boundary

Only `nim/client.mjs` and `nim/sim.mjs` know about simulation. Agent code passes a model id and messages; it gets text back. This is what makes simulation useful:

* the whole product is explorable with no key and no egress;
* tests assert on behaviour, not on canned strings;
* a missing key is a routing decision, not an error path.

The UI surfaces the flag (`simulated` pill in Studio, "simulated" in run metadata) so nobody mistakes the demo for inference.

## Working with the views

`ctx` is the contract a view receives:

```js
{ state, api, stream, navigate, toast, refresh, subscribe,
  company, companyId, route, params, query, runCycle, newIssue }
```

* `render(root, ctx)` may return a cleanup function (e.g. unsubscribe from events).
* Views must not cache company state across renders; call `ctx.refresh(true)` after mutations and re-render.
* Shared presentation lives in `views/shared.js` (`pageHeader`, `issueRow`, `runTrace`, `modelPill`, …). Keep its exports in sync with imports — a missing export is a blank screen.
* CSS is a single design system in `styles.css`: tokens (`--bg`, `--border`, `--text`, `--dim`, `--accent: #76b900`), then layout, then components. Prefer existing classes (`card`, `pill`, `chip`, `kv`, `progress`, `trace-step`, `tile-grid`, `split`, `stack`) over inline styles.

## Testing

```bash
npm test                       # 79 tests
node --test test/engine.test.mjs
```

* `test/company.test.mjs` — goal-sentence metrics, distinct skills per hire, blueprint routing for physical AI, routine dispatch, fair scheduling, computed goal progress, measured baselines/current values, board replenishment.
* `test/catalog.test.mjs` — 97 models / 430 skills / 37 blueprints, capability coverage, defaults resolve, live merge, blueprint model references.
* `test/engine.test.mjs` — seed, full run, review attempt, unlimited spend + budget gate, plan, cycle + standup, approvals, knowledge search, agent CRUD, embedding geometry.
* `test/api.test.mjs` — every route group over HTTP, including full auto: blueprint match, staffed launch, SSE step stream, key configuration without echo, and a first cycle.
* `test/api.test.mjs` — boots the real server on an ephemeral port and walks the HTTP surface, including SSE runs and cycles.

Every test writes to `PAPERCLIP_DATA_DIR` in a temp directory, so `data/` is never touched and tests can run in parallel with the dev server.

## Known trade-offs

* **JSON documents, not a database.** Fine for a single-process demo; `store.flush()` and per-company documents keep it predictable, but a multi-writer deployment would need real transactions.
* **In-memory retrieval index.** Chunks are cached per company and invalidated on knowledge writes; large corpora would want a vector store.
* **Curated metadata.** Prices and context windows are estimates. IDs and capabilities can be refreshed from the live `/v1/models`; prices cannot.
* **No auth.** It binds `0.0.0.0` and has no login: run it on a trusted network or behind a proxy.
