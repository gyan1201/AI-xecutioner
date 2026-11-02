# Company OS — Paperclip's operating model on NVIDIA NIM

Autopilot delivers **one goal**. Company OS runs the **whole organization**: a
real company structure with departments, hires, goals, a prioritised board of
issues, per-person budgets, board approvals, an executive cycle and an audit
trail — and it can mirror itself into a live
[Paperclip](https://github.com/paperclipai/paperclip) instance so both planes
stay in sync.

```text
one goal ─▶ org design (NIM strategist) ─▶ staffed company ─▶ auto mode cycles
                                              │                    │
                                              │                    ├─ plan (CEO)
                                              │                    ├─ work (employees + tools)
                                              │                    ├─ review (quality lead)
                                              │                    └─ standup (scribe)
                                              └─▶ Paperclip bridge ─▶ real Paperclip company
```

No dependency is added: Paperclip's vocabulary is implemented natively in
`server/company/`, and the bridge talks to a Paperclip server over plain HTTP.
The `paperclip/` checkout in this repository stays an unmodified contract
reference.

---

## 1. The model

Everything uses Paperclip's enums and shapes, so the two systems speak the same
language:

| Concept | Fields (subset) | Notes |
| --- | --- | --- |
| Company | `name`, `mission`, `budgetMonthlyCents`, `issuePrefix`, `status` | Issue keys look like `NW-3`. `status` ∈ `active`, `paused`, `archived`. |
| Department | `name`, `mission` | Team grouping for agents. |
| Agent | `name`, `role`, `title`, `departmentId`, `reportsTo`, `model`, `budgetMonthlyCents`, `spentCents`, `capabilities`, `skills`, `instructions`, `status` | Roles: `ceo, cto, cmo, cfo, security, engineer, designer, pm, qa, devops, researcher, general`. `status` ∈ `active`, `paused`, `over_budget`. |
| Goal | `title`, `description`, `level`, `status`, `ownerAgentId`, `kpis[]` | Levels: `company, team, agent, task`. Status: `planned, active, achieved, cancelled`. |
| Project | `name`, `description`, `goalId`, `ownerAgentId`, `status` | Delivery container above issues. |
| Issue | `key`, `title`, `description`, `status`, `priority`, `assigneeAgentId`, `acceptanceCriteria`, `blockedBy`, `needsApproval`, `review`, `reworks`, `comments[]`, `artifacts[]` | Status: `backlog, todo, in_progress, in_review, done, blocked, cancelled`. Priority: `critical, high, medium, low`. |
| Approval | `kind`, `title`, `detail`, `issueId`, `requestedByAgentId`, `status` | `kind` ∈ `issue`, `escalation`, `spend`. |
| Ledger entry | `agentId`, `issueId`, `model`, tokens, `costCents`, `kind`, `cycleId` | One row per model call. |

State lives in `data/companies/<id>/`:

```text
company.json      # the whole company: agents, goals, projects, issues, ledger, cycles
events.ndjson     # append-only audit log (company.created → cycle.completed)
artifacts/        # every deliverable, also downloadable as a ZIP-less bundle
```

---

## 2. Build a company from one goal

`POST /api/companies` with `{ name, goal, constraints, size, budgetMonthlyCents, settings }`.

1. **Org design** — the strategist role's NIM model returns strict JSON:
   departments, a roster (name, role, title, manager, capabilities, budget share),
   company goals with KPIs, a project and a first backlog. Fenced JSON, prose or
   truncated output is recovered by the shared tolerant parser; malformed output
   falls back to a deterministic blueprint (`server/company/org.mjs`).
   Normalisation clamps roles to the enum, caps the roster at 10 agents and the
   backlog at 16 issues, drops duplicate roles and rebalances budget shares to 1.
2. **Hiring** — agents are created with a monthly budget carved out of the company
   budget, exactly (the last hire absorbs rounding so the sum equals the total).
   Each agent's model defaults from the role routing table and stays editable.
3. **Board** — goals, projects and issues are created in one pass; every issue is
   assigned to a colleague with a model.
4. **Ready** — `company.created` + `company.ready` are appended, and the company
   appears in Mission control.

Every step is inspectable: `GET /api/companies/:id` returns the company plus
`summary` (counts and spend), `artifacts` and the last 200 events.

---

## 3. A cycle is a working day

`POST /api/companies/:id/cycles` runs one cycle:

1. **Plan (CEO)** — the CEO model sees the mission, budgets, goals and the ready
   issues and returns `{ focus, assignments[], newIssues[] (≤2), risks[] }`.
   Assignments are purged against reality: unknown issue keys, duplicate
   assignments and unavailable agents are dropped. No model or no budget ⇒ the
   cycle is planned by policy instead (`cycle.degraded`).
2. **Gate** — before any work, each assignment is checked against:
   - issue status (`backlog`, `todo`, `in_progress` eligible; `blocked`, `done`, `cancelled` never),
   - dependencies (`blockedBy` must be `done`),
   - agent availability (`paused` deferred with a comment, `over_budget` blocks the issue),
   - the approval policy — issues flagged `needsApproval` create a board approval
     and the issue parks in `blocked` until a human decides.
3. **Work (employee)** — the agent runs the shared tool runtime
   (`search_knowledge`, `calculate`, `save_artifact`, `safety_check`,
   `generate_visual`, `escalate_to_human`) against the issue, its acceptance
   criteria, prior comments and retrieved company knowledge with `[K1]` citations.
   `escalate_to_human` creates a real approval and blocks the issue.
4. **Review (quality lead)** — a second agent scores the deliverable against the
   acceptance criteria and returns `pass` or `rework` plus required changes.
   Rework re-queues the issue (`todo`) up to `reworkLimit`, then blocks it for a
   human. Pass sets `done`.
5. **Standup (scribe)** — a blunt end-of-cycle note: shipped, blocked, needs the board.

Every deliverable is written to `artifacts/<KEY>-<role>.md` even if the agent
never called `save_artifact`, and attached to the issue.

### Money

- Pricing is per company: `settings.pricing = { inputCentsPerMTok, outputCentsPerMTok }`
  (defaults are estimates, flagged in the UI).
- Each model call books a ledger row with exact token counts and a sub-cent cost.
- `agent.over_budget` is set when an agent reaches their cap, and the agent is
  skipped in later cycles. The CEO cannot plan, the reviewer cannot review and
  the scribe falls back when their budget is gone — **nobody spends past a cap**.
- `budgetMonthlyCents: 0` on an agent means "no spending". On a company it is a
  hard stop; a blank budget at creation defaults to $50.
- Company events: `agent.over_budget`, `cycle.degraded`, `issue.blocked`.

### Auto mode

`POST /api/companies/:id/auto { enabled, everyMinutes, maxCycles }` runs cycles on
a timer — this is the "given the goal, run the company" mode:

- the first cycle starts immediately, then one per interval;
- it stops itself (with a recorded `stopReason`) when the monthly budget is gone,
  every issue is closed, board approvals are waiting, `maxCycles` is reached, the
  company is paused/archived, or a cycle fails on a 422;
- only autonomous cycles count against `maxCycles`; manual cycles are board work;
- a fresh page load (`resumeAutoModes()`) restores timers after a restart, and
  `SIGINT`/`SIGTERM` clears them.

### Approvals

`POST /api/companies/:id/approvals/:approvalId { approved, note }` decides. Approving
an issue approval puts the issue back on the board (`todo`) so the next cycle picks
it up; rejecting leaves it blocked with the reason recorded. Approvals are also
created by `escalate_to_human` and by the `needsApproval` gate.

---

## 4. The Paperclip bridge

`server/paperclip.mjs` mirrors a company into a running Paperclip instance.

```bash
# save the bridge (or set PAPERCLIP_API_BASE / PAPERCLIP_API_KEY)
curl -s localhost:8787/api/settings -X PUT -H 'content-type: application/json' \
  -d '{"paperclip":{"baseUrl":"http://localhost:3100/api","token":"<board token>"}}'

# see the exact calls first
curl -s localhost:8787/api/paperclip/mirror -H 'content-type: application/json' \
  -d '{"companyId":"<id>","dryRun":true}'

# then do it
curl -s localhost:8787/api/paperclip/mirror -H 'content-type: application/json' \
  -d '{"companyId":"<id>","dryRun":false}'
```

Call plan (Paperclip REST, `Authorization: Bearer <token>`, `X-Paperclip-Run-Id`
on mutations):

| Step | Call | Payload |
| --- | --- | --- |
| create-company | `POST /companies` | `{ name, description, budgetMonthlyCents }` |
| hire-`<role>` | `POST /companies/:companyId/agents` | `{ name, role, title, adapterType: "opencode_local", capabilities, budgetMonthlyCents, adapterConfig: { model }, metadata: { source, nimModel, nimBaseUrl, department, skills } }` |
| goal | `POST /companies/:companyId/goals` | `{ title, description, level, status }` |
| issue | `POST /companies/:companyId/issues` | `{ title, description (incl. acceptance criteria as markdown), status, priority, acceptanceCriteria }` |

Notes:

- `dryRun` never touches the network — it returns the plan, which is also what the
  UI's **Preview mirror** button shows.
- `existingCompanyId` mirrors into a company that already exists instead of
  creating one (no duplicate company on re-runs).
- Failures are typed: `PaperclipError` carries `status`, a `hint` and the raw
  body (`401` ⇒ "create a board token", `404` ⇒ "base URL should include /api",
  `400/422` ⇒ validator complaint, connection refused ⇒ 502 with a reachability
  hint). The UI renders the hint verbatim.
- `POST /api/paperclip/probe` health-checks the bridge and lists a few companies.
- After a successful mirror the company records `paperclip = { baseUrl, companyId,
  mirroredAt, agents, goals, issues }` and logs `paperclip.mirrored`.
- The NVIDIA key is **never** sent to Paperclip: only the model id and the NIM
  base URL travel, in agent metadata, so a Paperclip agent can be reconfigured to
  call NIM itself.

`GET /api/companies/:id/export` returns a portable JSON bundle (company, artifacts,
summary) suitable for Paperclip's import preview or for archiving.

---

## 5. HTTP surface

```text
GET    /api/companies                       list (+ counts, auto-mode state)
POST   /api/companies                       build a company from a goal
GET    /api/companies/:id                   company + summary + artifacts + events
PATCH  /api/companies/:id                   name, mission, budget, status, settings
DELETE /api/companies/:id                   delete company + artifacts + timers

POST   /api/companies/:id/agents            hire { name, role, title, model, budgetMonthlyCents }
PATCH  /api/companies/:id/agents/:agentId   retitle, rebudget, pause, change model, instructions
DELETE /api/companies/:id/agents/:agentId   let go (blocked if the agent owns open work)

POST   /api/companies/:id/issues            add an issue
PATCH  /api/companies/:id/issues/:issueId   title, description, priority, status, assignee, approval
POST   /api/companies/:id/issues/:issueId/comments   board comment

POST   /api/companies/:id/cycles            run one cycle (async: true to fire & forget)
POST   /api/companies/:id/auto              { enabled, everyMinutes, maxCycles }
POST   /api/companies/:id/approvals/:approvalId      { approved, note }
GET    /api/companies/:id/events            audit log (optional ?since=ISO)
GET    /api/companies/:id/stream            SSE: state + event frames
GET    /api/companies/:id/artifacts/:name   deliverable (markdown, correct MIME)
GET    /api/companies/:id/export            portable bundle

POST   /api/paperclip/probe                 { baseUrl?, token? }
POST   /api/paperclip/mirror                { companyId, dryRun, existingCompanyId?, baseUrl?, token? }
```

`POST /api/companies` example:

```bash
curl -s localhost:8787/api/companies -H 'content-type: application/json' -d '{
  "name": "Northwind Labs",
  "goal": "Reach $20k MRR in 90 days with a self-serve onboarding flow, without new headcount.",
  "constraints": "B2B SaaS at $49/seat, 2 engineers, nothing public without approval.",
  "size": 6,
  "budgetMonthlyCents": 5000,
  "settings": { "approvalPolicy": "high", "maxIssuesPerCycle": 3, "reworkLimit": 1 }
}'
```

---

## 6. UI

**Company OS** (`#/companies`) has two screens:

- **Build** — name, goal, constraints, size, budget, approval policy → a staffed
  company, plus a table of every company with budget burn and auto-mode state.
- **Company** (`#/companies/<id>`) — tabs:
  - **Overview** — KPIs per goal, latest standup, departments, pending board decisions, live activity.
  - **Organization** — reporting tree, per-person budget bars, hire form, agent editor (model, budget, status, instructions, let go).
  - **Board** — issues with priority/status/review badges, acceptance criteria, comments, artifact links, status dropdowns, new-issue form, pipeline counts.
  - **Finance** — spend per agent, the cost ledger (model, tokens, cost), company budget, token rates.
  - **Autopilot** — cadence and cycle limits, start/stop, why it stopped, every cycle with plan focus, results and standup, live activity log.
  - **Settings** — company identity, approval policy, issues/cycle, rework limit, status, delete, **Paperclip bridge** (save, test connection, preview mirror, mirror), data locations.

The detail view keeps an SSE subscription open (`/api/companies/:id/stream`), so
agents working in the background appear without a refresh.

---

## 7. Verification

```bash
npm test        # 46 tests, no network, no key
```

The company suite (`test/company.test.mjs`) asserts:

| Test | What it proves |
| --- | --- |
| staffed company | departments, CEO, KPIs, backlog, resolved reporting lines, budgets sum to the company budget, every issue has an owner with a model, Paperclip-compatible enums and issue keys |
| cycle | focus set, tokens booked, deliverables accepted, artifacts on disk, ledger rows with usage, sub-cent precision, deliverable + review comments, event ordering |
| approvals | risky work parks in `blocked`, approval releases it, the next cycle progresses it |
| auto mode | runs unattended, stops at `maxCycles` with a reason, cycles are tagged `auto` |
| budgets | a zero-budget agent is never charged, work is blocked instead |
| bridge plan | plan shape, `adapterType`, `path` targets, dry run makes zero calls |
| bridge mirror | correct methods/URLs/auth header, created company id threaded into every follow-up call, agent/goal/issue counts |
| bridge errors | 401 and unreachable both produce typed errors with actionable hints |

HTTP tests cover build → cycle → artifact → comment → patch → auto on/off → export,
input rejection (422/404) and the bridge's dry run and unconfigured probe. The UI
test renders the company list and every detail tab against the live API.

---

## 8. Design decisions

- **Native, not a fork.** Paperclip needs Node ≥ 24 + Postgres and cannot run in
  the same sandbox; implementing its contracts directly keeps this app
  dependency-free while staying compatible.
- **Two planes, one model.** NVIDIA NIM does the thinking; Paperclip (when
  connected) does the governing. The mirror is explicit and previewable, never
  automatic, so no board state is created behind an operator's back.
- **Money is per call, not per cycle.** Budgets have to bind mid-work, otherwise a
  runaway agent can burn a month's budget in one loop.
- **Policy fallbacks everywhere.** Missing model, missing budget, thin knowledge
  or a failed review never dead-ends a cycle: it degrades, records why, and keeps
  the audit trail honest.
