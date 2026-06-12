# Agent Flight Recorder — Implementation Plan

> Research-backed build plan. All technology claims below were verified against vendor docs, changelogs, and the npm registry on **2026-06-12**. Source links inline.

---

## 1. What We're Building

**Agent Flight Recorder (AFR)** — a black-box flight recorder for AI agents. Wrap any agent in the AFR harness and every step — model calls, tool calls, context injections, latencies, costs — is recorded as a structured trace, streamed into ClickHouse, and made replayable.

### The Killer Demo (everything in this plan serves it)

1. Run an agent live → it **fails** (bad tool call with hallucinated arguments).
2. Open the replay timeline (OpenUI generative UI) → scrub to the failure → point at the **exact bad tool call**: inputs, the context the model saw, latency, error.
3. Fix the bug.
4. **Fork-replay** from the step before the failure — recording serves everything up to that point, the fix runs live.
5. Green. Diff view shows old vs. new run diverging at exactly the fixed step.

### Prize Mapping

| Sponsor | How AFR hits it |
| --- | --- |
| **ClickHouse** | Trace store + every query in the product (timeline, diff, analytics, full-text search over prompts) |
| **Composio** | The action layer being recorded — interception via execution modifiers |
| **Thesys (OpenUI)** | Replay timeline rendered as generative UI from trace data — the centerpiece screen |
| **TrueFoundry / Pioneer** | All inference routes through the gateway; Pioneer serves recorded model calls |

---

## 2. Technology Research Summary (June 2026)

### 2.1 ClickHouse — trace store

**Pin: ClickHouse 26.3 LTS** (or latest 26.5). Everything we need went GA in the last year:

| Feature | Status | Why it matters to AFR |
| --- | --- | --- |
| Native `JSON` type | **GA since 25.3** — true columnar subcolumns per path; typed path hints give ~38% smaller storage, ~26% faster queries ([docs](https://clickhouse.com/docs/sql-reference/data-types/newjson)) | Trace payloads (`input`, `output`) as `JSON` columns, not String + JSONExtract (obsolete pattern) |
| Async inserts | **On by default since 26.3 LTS** — server auto-batches small inserts ([blog](https://clickhouse.com/blog/clickhouse-release-26-03)) | High-frequency small trace events need zero client-side batching infrastructure |
| Insert deduplication | Default-on since 26.2, incl. async + dependent MVs | SDK transport can retry batches safely — exactly-once-ish without effort |
| Full-text (text) index | **GA in 26.2** — `INDEX t(body) TYPE text(tokenizer = splitByNonAlpha)`; query via `hasToken`/`hasAnyTokens`/`hasPhrase`, accelerates `LIKE`/`match()` ([docs](https://clickhouse.com/docs/engines/table-engines/mergetree-family/textindexes)) | "Find every run where the agent saw X in its context" — great demo beat |
| Vector similarity index | **GA in 25.8** (HNSW) — `TYPE vector_similarity('hnsw', 'cosineDistance', dims)` | Stretch: semantic search over runs ("find runs like this failure") |
| Lightweight `UPDATE` | Beta since 25.8 (patch parts, ~1000x faster than mutations) | Post-hoc eval verdict annotation on spans without rewriting parts |
| `@clickhouse/client` 1.20 (Jun 3, 2026) | Built-in **OTel `tracer` option** — every query/insert runs in a span ([repo](https://github.com/clickhouse/clickhouse-js)) | The recorder can self-instrument its own DB calls |
| ClickStack / HyperDX | OTel collector + ClickHouse + trace UI, single Docker image; LLM-tracing blogs show the exact agent-span shape ([blog](https://clickhouse.com/blog/tracing-openai-agents-clickstack)) | Reference architecture; optional "pro mode" view of our own traces |
| ClickHouse MCP server + Ask AI | Official MCP server (read-only SELECT); ClickStack MCP (May 2026) | Stretch: "ask your traces" via MCP from Claude/Cursor |

**Dev setup**: single `clickhouse/clickhouse-server` Docker container. (chDB/clickhouse-local can't serve the JS client or a web UI — not a substitute.)

### 2.2 Composio — recorded action layer

**Pin: `@composio/core` ≥ 0.10** (May 2026) + `@composio/vercel` provider. The legacy v1 SDK is deprecated; v1/v2 REST APIs were removed June 4, 2026 (410s) — use only v3 SDK surfaces.

The load-bearing finding — **how to record every tool call**:

- **Native tools + execution modifiers** are the official interception point. For agentic frameworks (Vercel AI SDK), modifiers passed to `tools.get()` wrap the framework's execute pipeline — every call the agent makes flows through our hooks ([docs](https://docs.composio.dev/docs/tools-direct/modify-tool-behavior/before-execution-modifiers)):

```typescript
const tools = await composio.tools.get(userId, { toolkits: ["github", "googlesheets"] }, {
  beforeExecute: ({ toolSlug, toolkitSlug, params }) => { rec.toolStart(toolSlug, params); return params; },
  afterExecute:  ({ toolSlug, toolkitSlug, result }) => { rec.toolEnd(toolSlug, result); return result; },
});
```

- **Do NOT record via the raw MCP URL path** — docs state MCP-route interception is "limited by client capabilities". Native tools give "full control for logging and approval" and lower token overhead. This decides our integration mode.
- **Observability API (Apr 17, 2026)** is the ground-truth backstop: `POST /api/v3.1/logs/tool_execution` returns full request payload, response body, and timings per execution — use to reconcile/verify our recordings.
- Auth: Auth Config (`ac_…`) → Connected Account (`ca_…`); use `link()` flow (managed OAuth; `initiate()` cutover July 3, 2026).
- Triggers: WebSocket `composio.triggers.subscribe()` for local dev (webhooks need public URLs).
- **Free tier: 20,000 tool calls/month** — ample.
- Note: Composio had a **May 22–23, 2026 security incident** (pre-existing API keys deleted) — generate fresh API keys, don't reuse old ones.

### 2.3 OpenUI (Thesys) — generative UI timeline

**"OpenUI" = Thesys's open standard for generative UI, launched Mar 11, 2026** ([github.com/thesysdev/openui](https://github.com/thesysdev/openui), MIT, ~7k stars; docs at openui.com). Not the old wandb/openui playground. Core facts:

- **OpenUI Lang**: a compact, line-oriented, streaming-first DSL the LLM emits instead of JSON — up to ~67% fewer output tokens, ~3x faster rendering, near-0% malformed output. First statement assigns `root`; forward references render as skeletons (built-in streaming UX for free).
- **Pipeline**: `defineComponent` (Zod props) → `createLibrary` → `library.prompt()` (system prompt generator) → streaming parser → `<Renderer />`.
- **Packages**: `@openuidev/lang-core`, `@openuidev/react-lang` (defineComponent/createLibrary/Renderer), `@openuidev/react-headless` (ChatProvider + streaming adapters for OpenAI & AG-UI), `@openuidev/react-ui` (prebuilt layouts + chart/form/table libraries), `@openuidev/cli`.
- **The constraint model IS the safety model**: the LLM can only compose components we register. Our custom primitives — `StepCard`, `LatencyBar`, `PayloadInspector`, `TimelineRow`, `DivergenceMarker` — are `defineComponent` entries with `.describe()`-annotated Zod schemas.
- **`examples/openui-dashboard`** in the repo is nearly our exact architecture: Next.js + streaming progressive rendering + any OpenAI-compatible provider via `LLM_BASE_URL` env — which means the timeline's LLM calls route through **TrueFoundry** (sponsor synergy).
- **Cost: $0** — MIT, BYO LLM. (Thesys C1 hosted API exists as fallback: free tier 3K calls/mo.)
- Docs tip: openui.com rate-limits fetches — use `https://www.openui.com/llms-full.txt` or the repo.

### 2.4 TrueFoundry + Pioneer — inference path

**TrueFoundry AI Gateway** is the primary inference choke point:

- One OpenAI-compatible endpoint (`https://gateway.truefoundry.ai`) over 30+ providers / 1000+ models; model naming `{provider-account}/{model}` (e.g. `openai-main/gpt-4o`); auth via Personal/Virtual Access Token. Claimed <5ms overhead.
- Recent launches: AI Gateway Product Hunt launch (Dec 9, 2025), **MCP Gateway** (~Jan 2026), **Agent Gateway** (Jun 2, 2026) — gateway-side tracing across LLM + tool + agent layers.
- Observability taps: OTel trace exporter (point at any OTLP endpoint — incl. ours), Query Spans API (`POST /api/svc/v1/spans/query`).
- **⚠️ Critical caveat: the free Developer tier (50k req/mo) excludes "observability features."** Therefore AFR's recording MUST NOT depend on gateway-side logs. Our recorder SDK wraps the model client **client-side** (we capture request/response/latency ourselves); the gateway is for unified model access, routing, and provider breadth. Gateway-side OTel export becomes a stretch goal / paid-tier bonus, not a dependency.

**Pioneer (pioneer.ai, by Fastino — launched Apr 21, 2026)** — inference provider with OpenAI-compatible (`https://api.pioneer.ai/v1`) and Anthropic-compatible (`/v1/messages`) endpoints, serving frontier models (Claude, GPT-5, Gemini 3.x) plus fast GLiNER2 extraction models. Two relevant hooks:
- Inference persistence is **on by default** (`store: false` to opt out) with a history API `GET /inferences` — a server-side recording cross-check.
- Routes cleanly **through** TrueFoundry as an OpenAI-compatible provider account — we get both sponsors on one code path.

### 2.5 Frontend / runtime stack

| Package | Pin (verified on npm 2026-06-12) | Notes |
| --- | --- | --- |
| `next` | **16.2.9** | Turbopack stable+default; `params`/`cookies()` must be awaited; `proxy.ts` replaces `middleware.ts`; `next lint` removed |
| `react` / `react-dom` | **19.2.7** | `<Activity />` (keep timeline tabs warm), `useEffectEvent`, View Transitions via Next `viewTransition` + `<Link transitionTypes>` (animated diff transitions) |
| `tailwindcss` | **^4.3** | CSS-first config (`@theme`), no tailwind.config.js; shadcn fully v4-compatible (`tw-animate-css`) |
| shadcn CLI | **4.x** (`npx shadcn@latest`) | CLI v4 (Mar 2026): `--dry-run`, `--diff`, design-system presets; "Rhea" compact style suits a dense trace dashboard; Charts (Recharts) + Data Table for run list |
| `ai` (Vercel AI SDK) | **^6.0** (6.0.202; GA Dec 22, 2025) | `ToolLoopAgent` for the demo agent; typed tool parts via `useChat` (`input-streaming → input-available → output-available/error`). **streamUI/RSC is experimental — do not use**; AI SDK UI is the production pattern |
| `@clickhouse/client` | **^1.20** | OTel tracer option |
| `vitest` | **^4.1** (4.1.8) | Vite ≥6, Node ≥20 |
| Node | **22 LTS** (Next 16 requires ≥20.9) | |
| Monorepo | **npm workspaces, no Turborepo** | 2026 consensus: Turborepo pays off at 3+ packages with real build graphs; hackathon doesn't need it |
| Zod | **^4** (AI SDK v6 peer-compatible) | Shared by event schema, OpenUI components, Composio tool types |

---

## 3. Architecture (post-research refinements)

```
┌────────────────────────── DEMO AGENT (apps? no — demo/) ─────────────────────────┐
│  AI SDK v6 ToolLoopAgent                                                          │
│   ├── model: OpenAI-compatible client → TrueFoundry Gateway → Pioneer/OpenAI/...  │
│   └── tools: composio.tools.get(userId, {toolkits}, { beforeExecute, afterExecute })
└──────────────┬────────────────────────────────────────────────────────────────────┘
               │ wrapped by
┌──────────────▼───────────── packages/recorder-sdk ────────────────────────────────┐
│  record(agent | clients)                                                           │
│   ├── model interceptor: wraps the OpenAI-compatible client (fetch-level)          │
│   │     captures messages, params, response, ttft, latency, tokens, cost           │
│   ├── tool interceptor: Composio beforeExecute/afterExecute modifiers              │
│   ├── context interceptor: explicit rec.context() API + prompt assembly capture    │
│   ├── canonical input hashing (SHA-256 over normalized JSON)                       │
│   └── transport: batched POST → ingest (retry-safe; CH dedup makes retries free)   │
└──────────────┬────────────────────────────────────────────────────────────────────┘
               │ HTTP batches
┌──────────────▼───────────── services/ingest ──────────────────────────────────────┐
│  zod-validate → insert JSONEachRow, async_insert=1, wait_for_async_insert=1        │
└──────────────┬────────────────────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────── ClickHouse 26.3 LTS (Docker) ─────────────────────────┐
│  events (MergeTree, ORDER BY (run_id, seq))  +  runs_rollup MV  +  text index      │
└──────────────┬────────────────────────────────────────────────────────────────────┘
               │ reads
┌──────────────▼───────────── apps/web (Next 16) ───────────────────────────────────┐
│  / run list (shadcn Data Table + Charts)                                           │
│  /runs/[runId]  replay timeline — OpenUI Renderer + custom primitives              │
│  /diff/[a]/[b]  side-by-side diff (View Transitions)                               │
│  /api/*         CH queries, replay/fork triggers, OpenUI stream route              │
└────────────────────────────────────────────────────────────────────────────────────┘
               ▲
┌──────────────┴───────────── packages/replay-engine ───────────────────────────────┐
│  REPLAY: serve recorded outputs by (run_id, seq); verify input_hash                │
│  FORK:   replay → step N, then live (new run_id, parent_run_id link)               │
│  DIFF:   align two runs by seq + input_hash; classify steps                        │
└────────────────────────────────────────────────────────────────────────────────────┘
```

**Key decisions confirmed/changed by research:**

1. **Client-side recording, gateway for access** (changed): TrueFoundry free tier excludes observability, so the SDK records at the client wrapper — which is also what makes replay possible (we control the call site, so we can substitute recorded responses). Gateway OTel export = stretch.
2. **Composio native tools only, never raw MCP** (confirmed + sharpened): modifiers at `tools.get()` are the recording hook; MCP-route interception is explicitly limited.
3. **OpenUI over C1** (sharpened): the open-source `@openuidev/*` stack with custom `defineComponent` primitives is the prize-target integration; BYO-LLM via TrueFoundry.
4. **AI SDK v6 `ToolLoopAgent`** is the demo agent substrate; its typed tool parts also give us a clean live-view while recording.
5. **No client-side batching logic needed**: ClickHouse 26.3 async inserts + default dedup carry it; the SDK transport just POSTs small batches with retries.

---

## 4. ClickHouse Schema (v1 DDL)

```sql
CREATE DATABASE IF NOT EXISTS afr;

CREATE TABLE afr.events (
    run_id          UUID,
    seq             UInt32,                          -- monotonic step index within run
    span_id         UUID,
    parent_span_id  Nullable(UUID),
    event_type      Enum8('run_start'=1,'model_call'=2,'tool_call'=3,
                          'context_injection'=4,'agent_decision'=5,
                          'run_end'=6,'error'=7),
    name            LowCardinality(String),          -- model id or tool slug
    -- typed JSON with path hints for the hot fields (≈38% smaller, ≈26% faster)
    input           JSON(max_dynamic_paths=128),
    input_hash      FixedString(64),                 -- canonical SHA-256 → replay/diff key
    output          JSON(max_dynamic_paths=128),
    input_text      String DEFAULT '',               -- flattened text for FTS
    output_text     String DEFAULT '',
    status          Enum8('ok'=1,'error'=2,'timeout'=3),
    error           String DEFAULT '',
    latency_ms      UInt32,
    ttft_ms         Nullable(UInt32),                -- time-to-first-token (model calls)
    tokens_in       UInt32 DEFAULT 0,
    tokens_out      UInt32 DEFAULT 0,
    cost_usd        Float64 DEFAULT 0,
    mode            Enum8('record'=1,'replay'=2,'fork'=3),
    parent_run_id   Nullable(UUID),                  -- fork lineage
    ts              DateTime64(3) CODEC(Delta, ZSTD(1)),

    INDEX idx_input_text  input_text  TYPE text(tokenizer = splitByNonAlpha) GRANULARITY 1,
    INDEX idx_output_text output_text TYPE text(tokenizer = splitByNonAlpha) GRANULARITY 1
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (run_id, seq)
SETTINGS index_granularity = 8192;

-- per-run rollup for the run list (cost, tokens, duration, status) — no scan of events
CREATE MATERIALIZED VIEW afr.runs_rollup
ENGINE = AggregatingMergeTree ORDER BY (run_id)
AS SELECT
    run_id,
    minState(ts)            AS started_at,
    maxState(ts)            AS ended_at,
    countState()            AS steps,
    sumState(cost_usd)      AS cost,
    sumState(tokens_in + tokens_out) AS tokens,
    maxState(status = 'error') AS has_error
FROM afr.events GROUP BY run_id;
```

Inserts from `@clickhouse/client` ≥1.20 with `clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 }`. Timeline read = primary-key scan on `(run_id, seq)`. Eval verdicts land in a small separate `afr.evals` table (or lightweight UPDATE annotations later).

---

## 5. Build Plan — Phases

Owner key: **L**=Lead, **S**=SDK/Replay dev, **B**=Backend dev, **F**=Frontend dev, **D**=Devil's advocate. (Solo build: do phases in order; parallel columns within a phase are still parallelizable across agent teammates.)

### Phase 0 — Scaffold & Contracts (~2h) — blocks everything

| # | Task | Owner | Acceptance |
| --- | --- | --- | --- |
| 0.1 | npm workspaces root; packages `recorder-sdk`, `replay-engine`, `auto-eval`; `services/ingest`; `apps/web` (create-next-app 16, Tailwind v4, shadcn init w/ Rhea style); `demo/` | L | `npm install` clean; `npx tsc --noEmit` passes everywhere |
| 0.2 | **Event schema** in `packages/recorder-sdk/src/events.ts` (Zod v4) — the single contract; export types + JSONEachRow serializers | L | Schema round-trips sample events |
| 0.3 | `docker-compose.yml` ClickHouse 26.3 LTS; `clickhouse/schema.sql` (DDL above); apply script | B | `SELECT 1` from `@clickhouse/client`; schema applied idempotently |
| 0.4 | Accounts/keys: TrueFoundry (gateway URL + PAT, add Pioneer + one OpenAI-compatible provider account), Composio (fresh post-incident API key, GitHub + Google Sheets toolkits via `link()`), Pioneer API key | L | One `curl` chat completion through the gateway succeeds; one Composio tool executes |

### Phase 1 — Record Mode End-to-End (~4h) — the spine

| # | Task | Owner | Acceptance |
| --- | --- | --- | --- |
| 1.1 | Model interceptor: wrap OpenAI-compatible client (fetch-level) pointed at TrueFoundry; capture messages/params/response/usage/latency/ttft; compute cost from usage | S | Recorded model_call event has full request+response |
| 1.2 | Tool interceptor: Composio `beforeExecute`/`afterExecute` modifiers wired through `tools.get()`; capture slug, args, result, latency, error | S | Every demo-agent tool call produces a tool_call event |
| 1.3 | Canonical hashing: stable stringify (sorted keys, normalized whitespace/floats) → SHA-256 `input_hash` | S | Same logical input ⇒ same hash across runs; test proves it |
| 1.4 | Transport: in-memory queue, batch POST every 500ms/100 events, retry w/ backoff (CH dedup makes retries safe); flush on run_end | S | Kill -9 mid-run loses ≤ last batch; no duplicates after retries |
| 1.5 | Ingest service: zod-validate → CH insert (async_insert=1, wait=1) | B | 1k events/s sustained locally; bad events 400 with reason |
| 1.6 | Demo agent: AI SDK v6 `ToolLoopAgent` — "research a topic via Composio search/GitHub, write findings to Google Sheets"; `break-it.ts` deterministically triggers the failure (e.g., tool schema changed so the agent passes a wrong sheet range) | S+D | `npm run demo` → run in CH; `npm run demo:break` → reproducible failure recorded |

**Gate ✅: a failing run is fully visible in ClickHouse via raw SQL before any UI work starts.**

### Phase 2 — Dashboard Read Path (~3h)

| # | Task | Owner | Acceptance |
| --- | --- | --- | --- |
| 2.1 | Run list `/`: shadcn Data Table over `runs_rollup` (status, steps, duration, tokens, cost) + sparkline Charts; auto-refresh | F | New runs appear ≤2s after run_end |
| 2.2 | API routes: `/api/runs`, `/api/runs/[id]` (events by `(run_id, seq)`), `/api/search?q=` (FTS via `hasAnyTokens` on input/output_text) | B | Timeline query <50ms for 200-step run |
| 2.3 | Conventional fallback timeline (plain React list of step cards) — exists before, and as fallback for, the OpenUI view | F | Failure step visibly red with error payload |
| 2.4 | Full-text search demo beat: "find runs mentioning ‹term›" | B | Returns the broken run by its hallucinated argument |

### Phase 3 — Replay, Fork, Divergence (~4h) — the product

| # | Task | Owner | Acceptance |
| --- | --- | --- | --- |
| 3.1 | REPLAY: replay client implements the same client interfaces but serves recorded outputs by `(run_id, seq)`; verifies `input_hash` each step | S | Record → replay ⇒ byte-identical step sequence; **determinism test in CI** |
| 3.2 | Divergence detection: hash mismatch ⇒ emit `divergence` marker event, stop or go-live per flag | S | Tampered prompt replay flags the exact step |
| 3.3 | FORK: serve steps `< N` from recording, live from `N`; new run_id with `parent_run_id`; mode='fork' | S | Fix + fork-replay of the broken run goes green |
| 3.4 | DIFF engine: align runs by seq+input_hash (LCS on hash sequence for insert/delete tolerance); classify identical / changed-input / changed-output / divergent-path | S | Broken vs fixed run: first divergence = the fixed step |
| 3.5 | Replay/fork/diff API routes + CLI (`npm run replay -- --run <id> [--fork-at <seq>]`) | B | Triggerable from the dashboard |

**Edge cases owned by D (test these explicitly):** streaming responses (record full accumulation + ttft; replay non-streamed is acceptable v1), parallel tool calls (seq assignment under concurrency — use atomic counter), provider retries (each attempt its own event, replay serves final), non-determinism in prompts (timestamps in context — canonicalization must exclude or the demo's fork will false-diverge: **inject a frozen clock into the demo agent**).

### Phase 4 — OpenUI Generative Timeline (~4h) — the prize screen

| # | Task | Owner | Acceptance |
| --- | --- | --- | --- |
| 4.1 | Timeline primitives as `defineComponent` (Zod + `.describe()`): `TimelineRow`, `StepCard`, `LatencyBar`, `PayloadInspector`, `DivergenceMarker`, `RunSummaryHeader`, plus `Stack`/`Grid` layout from `@openuidev/react-ui` | F | Components render standalone with mock props |
| 4.2 | `createLibrary` + `library.prompt({ preamble, additionalRules })` — rules: chronological order, LatencyBar for steps >500ms, error steps get PayloadInspector expanded | F | Generated system prompt reviewed; components constrained to registry |
| 4.3 | Stream route `/api/runs/[id]/timeline`: trace JSON (compacted: payload previews, full payloads fetchable on demand) + system prompt → LLM **via TrueFoundry** → stream OpenUI Lang | B | Skeleton-first progressive render (forward references) |
| 4.4 | `<Renderer />` page with `@openuidev/react-headless`; `onAction` → open full payload (from CH, not the LLM) in a side panel | F | Click a step ⇒ exact recorded payload, zero hallucination surface |
| 4.5 | Diff page: two-column timelines + View Transitions (`<Link transitionTypes>`); divergence step highlighted | F | The demo's old-vs-new diff reads in <5 seconds of screen time |

Reference: `thesysdev/openui` → `examples/openui-dashboard` (Next.js, streaming, `LLM_BASE_URL`-configurable). Docs via repo or `openui.com/llms-full.txt` (site rate-limits fetches).

### Phase 5 — Auto-Eval (~2h)

| # | Task | Owner | Acceptance |
| --- | --- | --- | --- |
| 5.1 | LLM-as-judge (via gateway): rubric = task success, tool-call correctness, efficiency (steps/tokens/cost); structured output (AI SDK v6 structured tool loop) | B | Broken run scores fail w/ pointer to the bad step; fixed run passes |
| 5.2 | Verdicts → `afr.evals` table; run list shows verdict badge; eval-on-run-end toggle | B | Badge visible in run list within seconds of run_end |

### Phase 6 — Demo Hardening & Submission (~3h)

| # | Task | Owner | Acceptance |
| --- | --- | --- | --- |
| 6.1 | `demo/README.md` runbook: exact commands, timings, reset script (`TRUNCATE afr.events` + reseed) | D | A cold start to demo-ready takes <5 min |
| 6.2 | Rehearse the 3-minute script (below) ×3; fix every stumble | All | Under 3:00 with 15s slack |
| 6.3 | `docs/ARCHITECTURE.md` (diagram + sponsor-tech callouts), `docs/DEMO_SCRIPT.md` | L | Judges can grok the system in 90s of reading |
| 6.4 | Stretch (only if green): ClickStack/HyperDX side-by-side view; vector search "runs like this"; Pioneer `GET /inferences` reconciliation panel; gateway OTel export | — | — |

### 3-Minute Demo Script

| t | Beat |
| --- | --- |
| 0:00–0:20 | "Agents fail in prod and nobody can reproduce the run." Run `npm run demo:break` live — agent fails on screen |
| 0:20–0:50 | Run list → open the failing run. OpenUI timeline streams in, composing itself from the trace |
| 0:50–1:30 | Scrub to the red step. PayloadInspector: the exact hallucinated tool argument, the context the model saw, latency. (FTS beat: search the bad value across all runs) |
| 1:30–2:00 | Fix the bug on screen (one-line tool schema/prompt fix) |
| 2:00–2:30 | Fork-replay from step N-1 — recorded steps fly by instantly, fix runs live, run goes green. Auto-eval flips to pass |
| 2:30–3:00 | Diff view: old vs new, divergence highlighted at exactly the fixed step. Close: "Record once, replay forever — ClickHouse, Composio, OpenUI, TrueFoundry, Pioneer." |

---

## 6. Environment Variables

```bash
# ClickHouse
CLICKHOUSE_URL=http://localhost:8123
CLICKHOUSE_USER=default
CLICKHOUSE_PASSWORD=
CLICKHOUSE_DATABASE=afr

# Ingest
AFR_INGEST_URL=http://localhost:4000
AFR_INGEST_API_KEY=                       # shared secret SDK ↔ ingest

# TrueFoundry (all inference routes here)
TRUEFOUNDRY_API_KEY=                      # PAT or Virtual Account Token
TRUEFOUNDRY_GATEWAY_URL=https://gateway.truefoundry.ai
AFR_DEMO_MODEL=                           # e.g. pioneer-main/<model> or openai-main/gpt-4o
AFR_TIMELINE_MODEL=                       # model for OpenUI timeline generation
EVAL_MODEL=                               # judge model

# Pioneer (also registered as a TrueFoundry provider account)
PIONEER_API_KEY=

# Composio (fresh key — post May-2026 incident)
COMPOSIO_API_KEY=
COMPOSIO_USER_ID=demo-user
```

(OpenUI needs no key — MIT, BYO-LLM through the gateway. Thesys C1 `THESYS_API_KEY` only if the hosted fallback is wired.)

---

## 7. Risks & Mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| TrueFoundry free tier blocks the observability we'd lean on | **Known fact** | Designed around it: recording is client-side in the SDK; gateway is access-only. Verify Spans API availability on free tier once; treat as bonus |
| Replay false-divergence from non-deterministic context (timestamps, random IDs) | High | Frozen clock + seeded IDs in demo agent; canonical hash excludes volatile fields by allowlist; divergence marker (not crash) on mismatch |
| OpenUI timeline LLM output quality/latency on a 200-step trace | Medium | Compact trace summary into the prompt (previews only); payloads fetched from CH on click; conventional fallback timeline exists from Phase 2; cap demo run at ~15 steps |
| Composio MCP-path tempts us (no interception) | Medium | Decision locked: native tools + modifiers only |
| Parallel tool calls break seq ordering | Medium | Atomic seq counter in SDK; D owns a concurrency test |
| openui.com docs rate-limit during build | Low | Use repo + `llms-full.txt`; vendor examples checked out locally |
| Composio post-incident auth friction | Low | Fresh API key day one; `link()` flow (not deprecated `initiate()` managed path) |
| Demo gods | Certain | Reset script; pre-recorded broken run kept in CH as backup; rehearse ×3 |

---

## 8. Source Index

- ClickHouse: [26.3 release](https://clickhouse.com/blog/clickhouse-release-26-03) · [JSON type](https://clickhouse.com/docs/sql-reference/data-types/newjson) · [text indexes](https://clickhouse.com/docs/engines/table-engines/mergetree-family/textindexes) · [async inserts](https://clickhouse.com/docs/optimize/asynchronous-inserts) · [traces schema blog](https://clickhouse.com/blog/storing-traces-and-spans-open-telemetry-in-clickhouse) · [agent tracing w/ ClickStack](https://clickhouse.com/blog/tracing-openai-agents-clickstack) · [clickhouse-js](https://github.com/clickhouse/clickhouse-js)
- Composio: [new SDK migration](https://docs.composio.dev/docs/migration-guide/new-sdk) · [execution modifiers](https://docs.composio.dev/docs/tools-direct/modify-tool-behavior/before-execution-modifiers) · [native vs MCP](https://docs.composio.dev/docs/native-tools-vs-mcp.md) · [changelog](https://docs.composio.dev/docs/changelog) · [pricing](https://composio.dev/pricing) · [May 2026 incident](https://composio.dev/blog/composio-may-2026-security-incident)
- OpenUI/Thesys: [thesysdev/openui](https://github.com/thesysdev/openui) · [launch blog](https://www.thesys.dev/blogs/openui) · [openui.com docs](https://www.openui.com/docs/openui-lang) · [dashboard example](https://github.com/thesysdev/openui/tree/main/examples)
- TrueFoundry: [gateway intro](https://www.truefoundry.com/docs/ai-gateway/intro-to-llm-gateway) · [quick start](https://www.truefoundry.com/docs/ai-gateway/quick-start) · [request logs API](https://www.truefoundry.com/docs/ai-gateway/fetch-request-logs) · [ClickStack export](https://www.truefoundry.com/docs/ai-gateway/clickstack) · [pricing](https://www.truefoundry.com/pricing)
- Pioneer: [pioneer.ai](https://pioneer.ai/) · [inference docs](https://docs.pioneer.ai/concepts/inference) · [launch PR (Apr 21, 2026)](https://www.prnewswire.com/news-releases/fastino-launches-pioneer-the-first-agent-for-fine-tuning-and-inference-of-llms-302748105.html)
- Frontend: [Next.js 16](https://nextjs.org/blog/next-16) · [Next.js 16.2](https://nextjs.org/blog/next-16-2) · [React 19.2](https://react.dev/blog) · [Tailwind v4](https://tailwindcss.com/blog/tailwindcss-v4) · [shadcn CLI v4](https://ui.shadcn.com/docs/changelog/2026-03-cli-v4) · [AI SDK 6](https://vercel.com/blog/ai-sdk-6) · [generative UI pattern](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)
