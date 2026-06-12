# Agent Flight Recorder — Tech Stack Documentation

Detailed, up-to-date reference docs for every technology in the stack. All docs were researched against live official documentation, changelogs, GitHub repos, and package registries on **2026-06-12**, with version numbers verified where possible.

## The project

A harness that wraps any AI agent, records every step — model call, tool call, injected context, latency, tokens — streams traces into ClickHouse, and lets you **replay a run deterministically, diff two runs, and auto-eval**. Killer demo: take a failing agent run, replay it, point at the exact bad tool call, fix it, re-run, show green.

## Stack and role of each piece

| Doc | Technology | Role in the Flight Recorder |
|---|---|---|
| [clickhouse.md](./clickhouse.md) | ClickHouse 26.x | Trace store + fast queries: trace-event schema, async-insert ingestion, run-timeline / run-diff / latency-percentile SQL, OTel + ClickStack integration |
| [composio.md](./composio.md) | Composio v3 SDKs | The tool/action layer being recorded: `beforeExecute`/`afterExecute` modifiers are the recorder's interception points; execute-by-slug enables deterministic replay |
| [openui.md](./openui.md) | OpenUI (open Generative UI standard, `thesysdev/openui`) | Renders the replay timeline, step inspector, run diff, and eval dashboards as generative UI — the sponsor-prize angle. Covers both the open-source `@openuidev/*` path and the hosted Thesys C1 API path |
| [pioneer.md](./pioneer.md) | Pioneer (by Fastino Labs, pioneer.ai) | Inference path option A: OpenAI/Anthropic-compatible endpoints, default per-inference logging with a queryable inference history API |
| [truefoundry.md](./truefoundry.md) | TrueFoundry AI Gateway | Inference path option B: unified OpenAI-compatible gateway across 30+ providers, per-request latency/token/cost spans, Spans Query API, and first-class ClickHouse/ClickStack trace export |

## Highlights found during research (June 2026)

- **ClickHouse**: native JSON type GA (25.3), text index GA (26.2), vector HNSW index GA (25.8), async inserts on by default (26.3) — the trace schema in the doc uses all of these.
- **Composio**: v3 SDKs (`composio` py / `@composio/core` ts) with the new session-based API (GA May 2026); v1/v2 REST removed June 2026. Modifiers are exactly the hook surface a flight recorder needs.
- **OpenUI**: v0.5 spec adds reactive `$variables` and `Query()`/`Mutation()` data fetching; React/Vue/Svelte renderers on npm; generated via your own LLM + system prompt or via Thesys C1 (`v-20260331`).
- **Pioneer**: launched April 2026; logs every inference with an `inference_id` and exposes `GET /inferences` — usable directly for replay diffing.
- **TrueFoundry**: MCP Gateway + Agent Harness (2026), `x-tfy-metadata` for run/step correlation, `x-tfy-resolved-model` for replay pinning, and native ClickStack trace export matching our storage layer.

## How the pieces connect

```
            ┌──────────────────────────────────────────────┐
            │              Agent under test                │
            │  (any framework: OpenAI SDK / LangGraph...)  │
            └───────────────┬──────────────────────────────┘
                            │ wrapped by
            ┌───────────────▼──────────────────────────────┐
            │            Flight Recorder harness           │
            │  • model calls → via Pioneer / TrueFoundry   │
            │    gateway (latency, tokens, cost captured)  │
            │  • tool calls → via Composio (before/after   │
            │    modifiers record inputs/outputs)          │
            └───────────────┬──────────────────────────────┘
                            │ trace events (async insert)
            ┌───────────────▼──────────────────────────────┐
            │                 ClickHouse                   │
            │   trace_events / runs / evals tables         │
            │   timeline, diff, percentile queries         │
            └───────────────┬──────────────────────────────┘
                            │ query results as tool data
            ┌───────────────▼──────────────────────────────┐
            │            OpenUI generative UI              │
            │  run timeline · step inspector · run diff    │
            │  eval dashboard (self-refreshing)            │
            └──────────────────────────────────────────────┘
```
