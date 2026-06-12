# AFR Build Progress (loop state — single source of truth)

Read this + `git log --oneline -10` at the start of every iteration. Pick the
first non-done, non-blocked milestone. Update at the end of every iteration.

## Decisions log

- **No turbo.json** — plan.md §2.5: npm workspaces only; Turborepo overhead not justified at this scale.
- ClickHouse pinned to 26.3 LTS image (plan.md §2.1).
- Recording is client-side in the SDK (TrueFoundry free tier excludes observability) — plan.md §3.
- Composio native tools + execution modifiers only, never raw MCP path — plan.md §2.2.
- OpenUI open-source `@openuidev/*` stack, BYO-LLM via gateway; no Thesys key needed — plan.md §2.3.

## Milestones

| # | Milestone | Status | Evidence / notes |
|---|---|---|---|
| 1 | SCAFFOLD — workspaces root, docker-compose (ClickHouse), package skeletons | done | `npm install` clean; `afr-clickhouse` healthy (server 26.3.12.3, `SELECT version()` over :8123); `npm run typecheck` green (root tsc + web tsc). No turbo.json by decision. |
| 2 | SCHEMA — events.ts + clickhouse/schema.sql | done | Schema applied twice (idempotent), tables: events, runs_rollup MV, evals. Sample event built via `events.modelCall()` round-tripped through JSONEachRow incl. JSON subcolumn read. `npx tsc --noEmit` green. zod 4.4.3 in recorder-sdk. |
| 3 | SDK CORE — hashing.ts, transport.ts + unit tests | done | 16/16 vitest pass (key-order/whitespace/-0 canonicalization, volatile-key exclusion; transport batching, 5xx retry+backoff, 4xx no-retry, close semantics). tsc green. |
| 4 | INGEST — HTTP batch endpoint, zod, async inserts | done | POST /events (auth, zod, async_insert+wait) → 4-event batch round-tripped identically (scalars exact, JSON payloads deep-equal); bad event → 400 with reason; /healthz pings CH; runs_rollup MV populated through async path. tsc green. |
| 5 | INTERCEPTORS — model.ts, tools.ts, context.ts, record() | blocked | No .env: needs TRUEFOUNDRY_API_KEY + AFR_DEMO_MODEL + COMPOSIO_API_KEY. User messaged 2026-06-12 with exact ask. Code may be written ahead; verification (toy agent → real rows) waits on keys. |
| 6 | DEMO AGENT — record-mode E2E, real reproducible failure | blocked | Same keys as #5. |
| 7 | REPLAY ENGINE — replayer.ts, divergence.ts, test:replay | done | `npm run test:replay` 5/5: toy run recorded via real SDK→ingest→CH pipeline replays byte-identical (seq/type/name/input_hash/output); tampered input flags input_hash_mismatch at exact seq; type/name/exhaustion divergences; whitespace-canonical no-false-diverge. Re-verify vs live demo agent at #14. events.ts wrap marker made lossless (`__afr_wrapped__`). |
| 8 | FORK MODE — fork.ts, fix-and-verify flow | done | fork.test.ts 3/3 via real pipeline: broken toy run (error tool_call) forked at failing seq with fixed input → green; fork is new run_id with mode=fork + parent_run_id; replayed prefix preserves hashes; source trace verified unchanged; pre-fork divergence throws. Demo-agent re-verify at #14. |
| 9 | DIFF ENGINE — diff.ts, alignment + classification | done | diff.test.ts 7/7: broken-vs-fixed reports changed-input at exactly the fixed step (seq 2); LCS alignment survives inserted steps without cascade; changed-output, divergent-path, one-sided trailing, bookkeeping-ignored cases covered. Demo-run re-verify at #14. |
| 10 | DASHBOARD — run list, API routes, diff view (shadcn) | todo | |
| 11 | TIMELINE — OpenUI generative replay timeline | todo | |
| 12 | AUTO-EVAL — judge.ts, rubrics.ts, verdicts in CH | todo | Needs EVAL_MODEL via gateway |
| 13 | DOCS + DEMO — ARCHITECTURE.md, DEMO_SCRIPT.md, runbook | todo | |
| 14 | FINAL REHEARSAL — full killer-demo loop + all checks green | todo | Exit gate |

## Blockers

- (none yet) — expected soon: `.env` keys for TrueFoundry, Composio, Pioneer (milestones 5+). User will be asked when milestone 5 starts.
