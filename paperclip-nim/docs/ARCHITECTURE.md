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
* **`nim/client.mjs`** is the only place that speaks HTTP to NVIDIA, and the only place that knows about live vs simulated.
* **`web/`** is a thin client: 19 view modules with `render(root, ctx)`, a hash router, one SSE firehose, and helpers in `lib.js`.

## The run loop

`runIssue` is the core product behaviour. It is intentionally deterministic in its ordering:

1. **Plan** — resolve assignee, budget gate (only when a cap is set), approval gate.
2. **Guardrail (input)** — safety NIM over the issue brief.
3. **Retrieve** — chunk the knowledge base, embed, cosine search, rerank.
4. **Tools** — the agent may call `knowledge_search`, `calculator`, `create_artifact`, `generate_image`, `check_safety`, `escalate` or `update_issue`, bounded by `MAX_TOOL_HOPS` (3).
5. **Deliverable** — streamed completion, saved as a run output and an artifact.
6. **Guardrail (output)** — a failing output stops the run before review.
7. **Quality review** — a critic agent returns JSON `{verdict, score, findings[]}`; a rejection returns the issue to `todo`, records the attempt, and the next run is labelled `Review attempt: N`.

Every model call is wrapped in `withUsageContext({ companyId, runId, agentId, sink })`. The sink writes a ledger row from the NIM usage event, so **the ledger is derived from real usage, not estimated after the fact** — including simulated usage, which keeps the spend screens honest in demo mode.

Invariants worth keeping:

* Money is stored in cents with two decimals (`0.52`, not `1`); never round to whole cents or simulated spend disappears.
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
npm test                       # 32 tests
node --test test/engine.test.mjs
```

* `test/catalog.test.mjs` — 97 models / 430 skills / 36 blueprints, capability coverage, defaults resolve, live merge, blueprint model references.
* `test/engine.test.mjs` — seed, full run, review attempt, unlimited spend + budget gate, plan, cycle + standup, approvals, knowledge search, agent CRUD, embedding geometry.
* `test/api.test.mjs` — boots the real server on an ephemeral port and walks the HTTP surface, including SSE runs and cycles.

Every test writes to `PAPERCLIP_DATA_DIR` in a temp directory, so `data/` is never touched and tests can run in parallel with the dev server.

## Known trade-offs

* **JSON documents, not a database.** Fine for a single-process demo; `store.flush()` and per-company documents keep it predictable, but a multi-writer deployment would need real transactions.
* **In-memory retrieval index.** Chunks are cached per company and invalidated on knowledge writes; large corpora would want a vector store.
* **Curated metadata.** Prices and context windows are estimates. IDs and capabilities can be refreshed from the live `/v1/models`; prices cannot.
* **No auth.** It binds `0.0.0.0` and has no login: run it on a trusted network or behind a proxy.
