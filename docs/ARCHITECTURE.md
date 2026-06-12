# Agent Flight Recorder — Architecture

> A black-box flight recorder for AI agents. Wrap any agent in the AFR harness
> and every step — model calls, tool calls, context injections, latencies,
> costs — is recorded as a structured trace, streamed into ClickHouse, and made
> replayable. Replay a failed run deterministically, fork it with a fix, and
> diff the two runs to the exact step that changed.

## The 90-second version

Agents fail in production and nobody can reproduce the run. AFR records every
step an agent takes as an immutable trace. Because the recorder sits at the
**call sites** (the model client and the tool client), it can later *substitute*
recorded responses — that's what makes replay deterministic without seed
control. A canonical SHA-256 of each step's input is the alignment key: if a
replayed agent produces a different input at step N, that hash mismatch *is*
the divergence — the exact step where behavior changed.

```
┌────────────────────────── demo/ agent ────────────────────────────────────┐
│  research-and-act agent                                                   │
│   ├── model calls → TrueFoundry AI Gateway (Pioneer/OpenAI/… providers)   │
│   └── tool calls  → Composio (beforeExecute / afterExecute modifiers)     │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ wrapped by
┌──────────────▼───────────── packages/recorder-sdk ────────────────────────┐
│  events.ts    — THE shared contract (typed builders, one row per step)    │
│  hashing.ts   — canonical SHA-256 (sorted keys, whitespace-normalized,    │
│                 volatile-key exclusion → no false divergence)             │
│  transport.ts — batched, non-blocking POST to ingest; retry-safe          │
│  interceptors — model (gateway client wrapper), tools (Composio           │
│                 modifiers), context injections                            │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ HTTP batches
┌──────────────▼───────────── services/ingest ──────────────────────────────┐
│  zod-validate → ClickHouse JSONEachRow, async_insert=1, wait=1            │
│  stateless; durable 200s make SDK retries safe (CH dedups)                │
└──────────────┬────────────────────────────────────────────────────────────┘
               │
┌──────────────▼───────────── ClickHouse 26.3 LTS ──────────────────────────┐
│  afr.events       MergeTree ORDER BY (run_id, seq) — replay read path is  │
│                   a primary-key scan; native JSON payload columns; text   │
│                   indexes for full-text search over prompts               │
│  afr.runs_rollup  AggregatingMergeTree MV — run list without scans        │
│  afr.evals        LLM-as-judge verdicts                                   │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ reads
┌──────────────▼───────────── apps/web (Next 16) ───────────────────────────┐
│  /                  run list (status, mode, eval, cost, lineage)          │
│  /runs/[runId]      replay timeline — OpenUI generative UI composes       │
│                     step cards / latency bars / payload inspectors        │
│  /diff/[a]/[b]      side-by-side diff, first divergence highlighted       │
│  /api/*             runs, events, diff, eval, deterministic replay        │
└──────────────▲────────────────────────────────────────────────────────────┘
               │
┌──────────────┴───────────── packages/replay-engine ───────────────────────┐
│  replayer.ts   serve recorded outputs by (run_id, seq); verify input hash │
│  divergence.ts input_hash / type / name mismatch + trace exhaustion       │
│  fork.ts       replay prefix → live from step N (new run_id, lineage)     │
│  diff.ts       LCS alignment over input hashes; classify each step        │
└────────────────────────────────────────────────────────────────────────────┘
```

## Run modes

| Mode       | Model/tool calls               | Use case                                  |
| ---------- | ------------------------------ | ----------------------------------------- |
| **RECORD** | live, fully captured           | every normal run                          |
| **REPLAY** | served from trace              | deterministic reproduction of a past run  |
| **FORK**   | trace up to step N, then live  | fix-and-verify: replay to just before the bug, run the fix live |
| **DIFF**   | none — trace vs. trace         | find the first divergence between two runs |

## Key design decisions

1. **Determinism via response substitution, not seed control.** Replay never
   re-calls a model or tool. Outputs come from the trace keyed by
   `(run_id, seq)`; the engine verifies the agent reproduced the same *inputs*
   (canonical hash). Mismatch = divergence point = what the diff view shows.
2. **Client-side recording; the gateway is for access.** TrueFoundry's free
   tier excludes gateway-side observability, so recording lives in the SDK
   wrapper — which is also precisely what enables substitution at replay time.
3. **Canonical hashing kills false divergence.** Sorted keys, normalized
   whitespace, `-0`→`0`, and a volatile-key exclusion list (timestamps,
   request ids) mean replays only diverge on *meaningful* input changes.
4. **ClickHouse is the only store.** One events table serves point lookups
   (replay) and analytics (latency percentiles, cost rollups, full-text
   search). Async inserts + default dedup mean the SDK transport can retry
   blindly. No Postgres, no Redis.
5. **Events are immutable.** Fixes produce new runs (`mode=fork`,
   `parent_run_id` lineage); the diff engine relates them. Nothing is ever
   updated in place.
6. **The event schema is single-source.** `packages/recorder-sdk/src/events.ts`
   mirrors `clickhouse/schema.sql` column-for-column; SDK, ingest, replay
   engine, and dashboard all import it.

## Sponsor technology map

| Tech | Where it lives | Why it's load-bearing |
| --- | --- | --- |
| **ClickHouse** | trace store + every query (timeline, diff, rollups, FTS) | MergeTree `(run_id, seq)` makes replay a primary-key scan; native JSON columns hold full payloads queryably |
| **Composio** | the agent's action layer | `beforeExecute`/`afterExecute` modifiers are the official interception point — every tool call is recorded with args, result, latency, error |
| **OpenUI** | `/runs/[runId]` generative timeline | trace JSON in → composed timeline out, constrained to our registered primitives (StepCard, LatencyBar, PayloadInspector, DivergenceMarker) |
| **TrueFoundry** | inference choke point | one OpenAI-compatible surface over 30+ providers means one interceptor records every model call, agent-framework-agnostic |
| **Pioneer** | provider behind the gateway | serves frontier models through the same recorded path; its server-side inference history is a recording cross-check |

## Repo layout

```
packages/recorder-sdk     events contract, hashing, transport, interceptors
packages/replay-engine    replayer, divergence, fork, diff, CH loader
packages/auto-eval        LLM-as-judge rubrics + judge
services/ingest           HTTP batch endpoint → ClickHouse
apps/web                  Next.js dashboard (run list, timeline, diff)
demo/                     fragile demo agent + reproducible failure trigger
clickhouse/               schema.sql (single source of truth) + migrations
docs/                     this file, demo script, progress, tech research
```
