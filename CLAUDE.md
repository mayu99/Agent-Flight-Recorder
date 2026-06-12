# Project Rules for Claude Code

## Project Overview

**Agent Flight Recorder (AFR)** — A black-box flight recorder for AI agents. Wrap any agent in the AFR harness and every step it takes — model calls, tool calls, context injections, latencies, costs — is recorded as a structured trace, streamed into ClickHouse, and made replayable. Replay a failed production run deterministically, diff two runs step-by-step to find the exact divergence, and auto-eval runs at scale.

### The Killer Demo (north star — everything serves this)

1. Run an agent live; it **fails** (bad tool call, wrong arguments, hallucinated parameter).
2. Open the replay timeline, scrub to the failure, point at the **exact bad tool call** — its inputs, the context the model saw, the latency, the error.
3. Fix the bug (prompt, tool schema, or code).
4. **Fork-replay** from the step before the failure — everything up to that point is served from the recording, the fix runs live.
5. Show green. Diff view shows old run vs. new run diverging at exactly the fixed step.

If a feature does not make this demo sharper, deprioritize it.

### Architecture

- **Recorder SDK** (`packages/recorder-sdk`): TypeScript harness that wraps any agent loop. Intercepts model calls, tool calls (Composio), and context injections; emits structured trace events. Zero-config wrap: `record(agent)`.
- **Ingest service** (`services/ingest`): Receives event batches over HTTP, validates, and inserts into ClickHouse using async inserts. Stateless, restart-safe.
- **Trace store**: ClickHouse — single `events` table, MergeTree ordered by `(run_id, seq)`. Powers timeline queries, run diffs, latency/cost aggregations, and full-text search over payloads.
- **Replay engine** (`packages/replay-engine`): Deterministic replay. Model and tool responses are served from the recorded trace keyed by `(run_id, seq)`; input hashes detect divergence. Fork mode replays up to step N, then goes live.
- **Diff engine** (`packages/replay-engine/diff`): Aligns two runs step-by-step (by seq + input hash), classifies each step as identical / changed-input / changed-output / divergent-path.
- **Auto-eval** (`packages/auto-eval`): LLM-as-judge over completed runs — task success, tool-call correctness, efficiency (steps/tokens/cost). Verdicts written back to ClickHouse.
- **Dashboard** (`apps/web`): Next.js 15 (App Router) + React 19 + Tailwind + shadcn/ui. Run list, replay timeline, diff view, eval reports.
- **Generative UI replay timeline**: OpenUI renders the replay timeline as generative UI — the LLM composes the timeline visualization from trace data instead of fixed components. **This is the generative-UI prize target; the timeline is the centerpiece screen.**
- **Tool layer**: Composio — the agent's actions (the things being recorded) execute through Composio tool calls. The SDK interceptor wraps the Composio client.
- **Inference path**: TrueFoundry LLM gateway (Pioneer as fallback) — all model calls route through the gateway, which gives AFR a single choke point to intercept and a consistent request/response shape to record.
- **Demo agent** (`demo/`): A deliberately fragile agent (e.g., research-and-act agent using Composio tools) with a known, reproducible failure mode for the live demo.

### Project Structure

```text
agent-flight-recorder/
├── CLAUDE.md                      # This file — project rules
├── package.json                   # Workspace root (npm workspaces)
├── turbo.json                     # Turborepo task pipeline (optional)
├── docker-compose.yml             # ClickHouse local dev
├── clickhouse/
│   ├── schema.sql                 # events, runs, evals tables (single source of truth)
│   └── migrations/                # Numbered, append-only migrations
├── packages/
│   ├── recorder-sdk/              # The harness — wrap any agent
│   │   ├── src/
│   │   │   ├── index.ts           # record(agent) entrypoint
│   │   │   ├── interceptors/
│   │   │   │   ├── model.ts       # LLM call interceptor (gateway-level)
│   │   │   │   ├── tools.ts       # Composio tool-call interceptor
│   │   │   │   └── context.ts     # Context injection / prompt assembly capture
│   │   │   ├── events.ts          # Trace event types + builders (shared schema)
│   │   │   ├── transport.ts       # Batched, non-blocking event shipping to ingest
│   │   │   └── hashing.ts         # Canonical input hashing for replay/diff
│   │   └── package.json
│   ├── replay-engine/
│   │   ├── src/
│   │   │   ├── replayer.ts        # Deterministic replay (serve recorded responses)
│   │   │   ├── fork.ts            # Replay-to-step-N, live-from-there
│   │   │   ├── divergence.ts      # Input-hash divergence detection
│   │   │   └── diff.ts            # Two-run step alignment + classification
│   │   └── package.json
│   └── auto-eval/
│       ├── src/
│       │   ├── judge.ts           # LLM-as-judge over a run's trace
│       │   └── rubrics.ts         # Eval rubric prompt templates
│       └── package.json
├── services/
│   └── ingest/
│       ├── src/
│       │   ├── server.ts          # HTTP batch endpoint
│       │   ├── clickhouse.ts      # ClickHouse client + async insert config
│       │   └── validate.ts        # Event schema validation (zod)
│       └── package.json
├── apps/
│   └── web/                       # Next.js dashboard
│       ├── src/
│       │   ├── app/
│       │   │   ├── page.tsx       # Run list (status, duration, cost, eval verdict)
│       │   │   ├── runs/[runId]/
│       │   │   │   └── page.tsx   # Replay timeline (OpenUI generative UI)
│       │   │   ├── diff/[runA]/[runB]/
│       │   │   │   └── page.tsx   # Side-by-side run diff
│       │   │   └── api/
│       │   │       ├── runs/route.ts           # Run list/detail queries
│       │   │       ├── runs/[runId]/replay/route.ts  # Trigger replay/fork
│       │   │       ├── diff/route.ts           # Diff two runs
│       │   │       └── eval/route.ts           # Trigger/fetch auto-eval
│       │   ├── components/
│       │   │   ├── ui/            # shadcn/ui components
│       │   │   ├── timeline/      # Timeline primitives OpenUI composes from
│       │   │   └── diff/          # Diff view components
│       │   └── lib/
│       │       ├── clickhouse.ts  # Read-side ClickHouse client
│       │       └── openui.ts      # OpenUI client + GenUI system prompt
│       └── package.json
├── demo/
│   ├── agent.ts                   # The fragile demo agent (Composio tools)
│   ├── break-it.ts                # Reproducible failure trigger
│   └── README.md                  # Demo runbook — exact steps, timings
└── docs/
    ├── ARCHITECTURE.md            # System architecture for judges
    └── DEMO_SCRIPT.md             # 3-minute demo video script
```

### Key Technical Decisions

- **ClickHouse is the only store.** Traces, runs, and eval verdicts all live in ClickHouse. No Postgres, no Redis. One `events` table ordered by `(run_id, seq)` serves both the replay read-path (point lookups by run) and analytics (aggregations across runs). Async inserts keep the write path fast.
- **The gateway is the model-call choke point.** All inference flows through TrueFoundry's LLM gateway, so the SDK intercepts one consistent surface instead of patching N provider SDKs. Recording is therefore agent-framework-agnostic.
- **Composio is the action surface.** Tool calls = Composio executions. The interceptor records tool name, arguments, raw response, latency, and error for every execution.
- **Determinism via response substitution, not seed control.** Replay never re-calls the model or tools — it serves recorded outputs keyed by `(run_id, seq)` and verifies the agent produced the same *inputs* (canonical hash). If an input hash differs mid-replay, that step is the divergence point — which is exactly the signal the diff view visualizes.
- **Events are immutable and append-only.** No updates to recorded traces, ever. Fixes produce new runs; the diff engine relates them.
- **OpenUI owns the timeline screen.** The replay timeline is generative UI: trace JSON in, composed timeline out. We supply timeline primitives (step cards, latency bars, payload inspectors) that OpenUI composes. Every other screen is conventional shadcn/ui — don't gold-plate them.
- **TypeScript everywhere, npm workspaces.** SDK, engine, ingest, and web share the event schema from `packages/recorder-sdk/src/events.ts` — it is the single source of truth for what an event looks like. Change it there or nowhere.

### Trace Event Model

Every recorded step is one row in `events`:

| Column           | Type                | Notes                                                       |
| ---------------- | ------------------- | ----------------------------------------------------------- |
| `run_id`         | UUID                | One agent execution                                         |
| `seq`            | UInt32              | Monotonic step index within the run — replay ordering key   |
| `span_id`        | UUID                | This step                                                   |
| `parent_span_id` | Nullable(UUID)      | Nesting (e.g., tool call inside an agent step)              |
| `event_type`     | Enum                | `model_call` \| `tool_call` \| `context_injection` \| `agent_decision` \| `run_start` \| `run_end` \| `error` |
| `name`           | String              | Model name, tool name, or context source                    |
| `input`          | String (JSON)       | Full request payload (messages, tool args)                  |
| `input_hash`     | FixedString(64)     | Canonical SHA-256 of input — replay/diff alignment key      |
| `output`         | String (JSON)       | Full response payload                                       |
| `status`         | Enum                | `ok` \| `error` \| `timeout`                                |
| `error`          | String              | Error message when status != ok                             |
| `latency_ms`     | UInt32              | Wall-clock duration                                         |
| `tokens_in/out`  | UInt32              | Model calls only                                            |
| `cost_usd`       | Float64             | Computed at record time from gateway pricing                |
| `ts`             | DateTime64(3)       | Event start time                                            |

### Run Modes

| Mode       | Model/Tool calls            | Use case                                          |
| ---------- | --------------------------- | ------------------------------------------------- |
| **RECORD** | Live, fully captured        | Normal operation; every prod/demo run             |
| **REPLAY** | Served from trace           | Deterministic reproduction of a past run          |
| **FORK**   | Trace up to step N, then live | Fix-and-verify: replay to just before the bug, run the fix live |
| **DIFF**   | No execution — trace vs. trace | Compare two runs; find first divergence         |

## Auto-Commit and Push Rule

**MANDATORY**: After every change you make to any file in this repository, you MUST:

1. Stage the changed files: `git add <specific files you changed>`
2. Commit with a clear message describing what changed: `git commit -m "description of change"`
3. Push to remote: `git push origin main`

This applies to EVERY change — no exceptions. Do not batch changes. Commit and push immediately after each logical change.

- Never force push
- Use descriptive commit messages that explain the "why"
- If a pre-commit hook fails, fix the issue and create a NEW commit (never amend)

## Branching & Commit Conventions

- **Main branch**: `main`
- **Commit format**: Conventional Commits
  - `feat:` / `feat(scope):` — new feature
  - `fix:` / `fix(scope):` — bug fix
  - `docs:` — documentation
  - `refactor:` — code refactoring
  - `chore:` — build/tooling changes
  - `test:` — test changes
- **Scopes**: `sdk`, `replay`, `diff`, `eval`, `ingest`, `clickhouse`, `web`, `timeline`, `demo`

## Build & Test Commands

```bash
# Infrastructure
docker compose up -d clickhouse          # Start local ClickHouse
docker compose exec clickhouse clickhouse-client --queries-file /schema/schema.sql  # Apply schema

# Development
npm run dev                              # Dashboard dev server (port 3000) + ingest (port 4000)
npm run dev:web                          # Dashboard only
npm run dev:ingest                       # Ingest service only
npm run build                            # Build all workspaces (turbo)

# Demo
npm run demo                             # Run the demo agent (recorded)
npm run demo:break                       # Run the demo agent with the failure triggered
npm run replay -- --run <run_id>         # Deterministic replay from CLI
npm run replay -- --run <run_id> --fork-at <seq>  # Fork-replay

# Lint & Format
npx next lint                            # ESLint (web)
npx prettier --check .                   # Format check
npx prettier --write .                   # Auto-format
npx tsc --noEmit                         # Typecheck all workspaces

# Test
npm run test                             # All tests (vitest)
npm run test:sdk                         # Recorder SDK unit tests
npm run test:replay                      # Replay determinism tests (record → replay → assert identical)
npm run test:e2e                         # End-to-end: demo agent → ClickHouse → timeline renders
```

## Environment Variables

Required in `.env.local` (web) and `.env` (services/demo):

```bash
# ClickHouse
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=afr

# Ingest
AFR_INGEST_URL=http://localhost:4000     # Where the SDK ships events
AFR_INGEST_API_KEY=                      # Shared secret SDK ↔ ingest

# Composio (tool/action layer)
COMPOSIO_API_KEY=

# TrueFoundry (inference gateway — all model calls route through this)
TRUEFOUNDRY_API_KEY=
TRUEFOUNDRY_GATEWAY_URL=
# Pioneer (fallback inference path)
PIONEER_API_KEY=

# OpenUI (generative UI timeline)
OPENUI_API_KEY=
OPENUI_BASE_URL=

# Auto-eval judge model
EVAL_MODEL=                              # Model id routed via the gateway
```

## Agent Team Strategy

Use agent teams for any task that benefits from parallel work across independent modules. Teams are enabled via `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.

### When to Use Teams

- Multi-package features spanning SDK, ingest, and dashboard
- Research + implementation in parallel (one teammate explores OpenUI / Composio docs, another builds)
- Code review with competing perspectives (correctness, replay determinism, demo impact)
- Debugging with competing hypotheses — teammates test different theories simultaneously
- Any task with 3+ independent subtasks that don't touch the same files

### When NOT to Use Teams

- Sequential tasks with heavy dependencies between steps
- Changes to the shared event schema (`packages/recorder-sdk/src/events.ts`) — single owner, everything depends on it
- Simple bug fixes or small tweaks
- Tasks where coordination overhead exceeds the benefit

### Team Configuration

- Start with **3-5 teammates** for most workflows
- Aim for **5-6 tasks per teammate** to keep everyone productive
- Use **Opus for the lead** (reasoning/coordination), **Sonnet for teammates** (focused implementation)
- Use **delegate mode** (`Shift+Tab`) when the lead should only coordinate, not write code

### Team Communication Rules

- Use `SendMessage` (type: "message") for direct teammate communication — always refer to teammates by **name**
- Use `SendMessage` (type: "broadcast") **only** for critical blockers affecting everyone
- Use `TaskCreate`/`TaskUpdate`/`TaskList` for work coordination — teammates self-claim unblocked tasks
- When a teammate finishes, they check `TaskList` for the next available task (prefer lowest ID first)
- Mark tasks `completed` only after verification passes

### Task Dependencies

- Use `addBlockedBy` to express task ordering (e.g., "timeline UI depends on ingest writing real events")
- Teammates skip blocked tasks and pick up unblocked work
- When a blocking task completes, dependent tasks auto-unblock

### Parallelizable Modules

These can be built simultaneously with zero conflicts:

- **Dashboard pages** (run list, timeline, diff view) — different files
- **SDK interceptors** (model, tools, context) — independent files behind one event schema
- **Auto-eval** — reads from ClickHouse only, touches nothing else
- **Demo agent** — depends only on the SDK's public API
- **Docs** (ARCHITECTURE.md, DEMO_SCRIPT.md) — anytime

### Sequential Dependencies

These must be done in order:

1. Event schema + ClickHouse schema (blocks all — it's the contract)
2. Recorder SDK transport + ingest service (blocks anything that needs real data)
3. Record mode working end-to-end (blocks replay)
4. Replay engine (blocks fork mode and diff)
5. Timeline UI needs recorded runs in ClickHouse to render

### Team Roles

- **Lead**: Architecture decisions, event schema ownership, ClickHouse schema, project scaffold
- **SDK/Replay Dev**: Recorder SDK, interceptors, replay engine, fork mode, divergence detection
- **Backend Dev**: Ingest service, ClickHouse queries, dashboard API routes, auto-eval
- **Frontend Dev**: Run list, diff view, timeline primitives, OpenUI integration
- **Devil's Advocate**: Replay determinism testing, edge cases (streaming, retries, parallel tool calls), demo rehearsal

### Plan Approval for Risky Work

- For architectural changes or risky refactors (especially anything touching the event schema or replay keying), require **plan approval** before implementation
- The teammate works in read-only mode, submits a plan, lead approves/rejects
- Only after approval does the teammate implement

### Shutdown Protocol

- When all tasks are complete, the lead sends `shutdown_request` to each teammate
- Teammates approve shutdown after confirming their work is committed
- Lead calls `TeamDelete` to clean up team resources

## Workflow Orchestration

### 1. Plan Mode Default

- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately — don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy

- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Verification Before Done

- Never mark a task complete without proving it works
- `npx tsc --noEmit` and `npm run build` must pass
- **Replay determinism is the bar**: record a run, replay it, assert the replayed step sequence is byte-identical. If replay isn't deterministic, nothing else matters
- Test the specific flow end-to-end: demo agent → events in ClickHouse → timeline renders → replay works
- Ask: "Would a hackathon judge be impressed by this?"

### 4. Demo-Driven Development

- Every feature should be demo-able in the 3-minute video
- The fail → replay → pinpoint → fix → fork-replay → green loop is the demo. Rehearse it after every significant change
- If a feature isn't visible in the demo, deprioritize it
- Polish > breadth — one flawless replay beats five half-working views

### 5. Demand Elegance (Balanced)

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer

### 6. Autonomous Bug Fixing

- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

### 7. Self-Improvement Loop

- After ANY correction from the user: capture the pattern
- Write rules for yourself that prevent the same mistake
- Review lessons at session start for relevant context

## Task Management

1. **Plan First**: Write plan with checkable items before starting
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Review what was built and what changed

## Core Principles

- **Hackathon Speed**: Ship fast, iterate. Perfect is the enemy of done.
- **The Trace is the Product**: Recording fidelity and deterministic replay ARE the differentiator. Every external call (model, tool) MUST flow through an interceptor — an unrecorded call is a bug.
- **Demo-Driven**: If it doesn't show well in 3 minutes, cut it.
- **ClickHouse First**: All reads and writes go through ClickHouse. No side stores, no in-memory state that matters.
- **No Faking**: Real agent runs, real Composio tool calls, real traces, real replay. Judges notice mocks. The demo failure is real and reproducibly triggered, not hardcoded.
- **Immutable Traces**: Never mutate a recorded run. Fixes create new runs; diffs relate them.
- **Simplicity First**: Make every change as simple as possible. Minimal code impact.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimal Impact**: Changes should only touch what's necessary. Avoid introducing bugs.
