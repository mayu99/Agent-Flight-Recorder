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
| 5 | INTERCEPTORS — model.ts, tools.ts, context.ts, record() | code done — live verify pending keys | User-requested TrueFoundry audit (docs/ai-gateway/quick-start) drove this: gateway.ts (config from env per TF contract: OpenAI-compatible base URL, PAT/VAT as apiKey, model ids verbatim from Playground), recorder.ts (Recorder + record(), atomic seq, context()/decision()), interceptors/model.ts (fetch-level choke point: sync + SSE-streamed calls recorded w/ full payloads, ttft, usage; passthrough untouched), interceptors/tools.ts (Composio before/afterExecute modifiers, error-status on successful=false). Verified vs local OpenAI-compatible stub: 3/3 new tests (19/19 SDK total) — run_start/context/model_call×2/tool_call×2/run_end, gapless seq from 0, stream tee intact for caller. NOT yet verified against the live gateway (needs TRUEFOUNDRY_API_KEY + AFR_DEMO_MODEL) — do at #6/#14. Gotcha: transport ships `{events: [...]}` wrapper, not a bare array. |
| 6 | DEMO AGENT — record-mode E2E, real reproducible failure | blocked | Same keys as #5. |
| 7 | REPLAY ENGINE — replayer.ts, divergence.ts, test:replay | done | `npm run test:replay` 5/5: toy run recorded via real SDK→ingest→CH pipeline replays byte-identical (seq/type/name/input_hash/output); tampered input flags input_hash_mismatch at exact seq; type/name/exhaustion divergences; whitespace-canonical no-false-diverge. Re-verify vs live demo agent at #14. events.ts wrap marker made lossless (`__afr_wrapped__`). |
| 8 | FORK MODE — fork.ts, fix-and-verify flow | done | fork.test.ts 3/3 via real pipeline: broken toy run (error tool_call) forked at failing seq with fixed input → green; fork is new run_id with mode=fork + parent_run_id; replayed prefix preserves hashes; source trace verified unchanged; pre-fork divergence throws. Demo-agent re-verify at #14. |
| 9 | DIFF ENGINE — diff.ts, alignment + classification | done | diff.test.ts 7/7: broken-vs-fixed reports changed-input at exactly the fixed step (seq 2); LCS alignment survives inserted steps without cascade; changed-output, divergent-path, one-sided trailing, bookkeeping-ignored cases covered. Demo-run re-verify at #14. |
| 10 | DASHBOARD — run list, API routes, diff view (shadcn) | done | `npm run build` green (Turbopack). Verified against live CH on :3100: run list renders both fork-pair runs w/ status+mode+lineage; run detail shows error step ("bad expression: 2+x"); diff page shows changed-input + first-divergence badge; /api/runs, /api/runs/[id], /api/diff, /api/eval (GET), /api/runs/[id]/replay (deterministic self-replay) all return live data. Module fix: tsconfig → moduleResolution bundler + extensionless imports (Turbopack can't resolve NodeNext .js-style TS imports); all 31 tests still green. |
| 11 | TIMELINE — OpenUI generative replay timeline | blocked (primitives done) | Primitives sub-chunk DONE: Stack/RunSummaryHeader/Timeline/StepCard/LatencyBar/PayloadInspector/DivergenceMarker via `defineComponent` (`@openuidev/react-lang` 0.2.6), `timelineLibrary` + `timelinePrompt()`, `TimelineView` client wrapper. Verified: 6/6 vitest — sample OpenUI Lang program renders through the real parser+Renderer, failed step visually identifiable (data-status=error + expanded PayloadInspector), mid-stream truncation doesn't crash, prompt contains all component names. Remaining (LLM generation route /api/runs/[id]/timeline + page wiring): needs TRUEFOUNDRY_API_KEY + AFR_TIMELINE_MODEL. Gotcha logged: every component the LLM may emit MUST be registered in the library — an unknown root component ⇒ empty render. |
| 12 | AUTO-EVAL — judge.ts, rubrics.ts, verdicts in CH | code done — live verify pending keys | rubrics.ts (3 rubrics: task_success/tool_correctness/efficiency; compactTrace + strict-JSON judge messages), judge.ts (judgeRubric via gateway OpenAI-compatible API w/ json_object mode + fence-tolerant parse + retry; judgeTrace; evalRun loads trace via replay-engine loader, writes afr.evals). /api/eval POST wired to evalRun (503 w/ setup message when keys missing). Verified vs stub judge + REAL CH round-trip: 3/3 tests — broken toy run fails tool_correctness with flagged_seq = exact error step, verdicts persisted+read back from afr.evals. Full suite 43 green, web build green. Live judge (TRUEFOUNDRY_API_KEY + EVAL_MODEL) verifies at #14. |
| 13 | DOCS + DEMO — ARCHITECTURE.md, DEMO_SCRIPT.md, runbook | done | ARCHITECTURE.md (diagram, run modes, decisions, sponsor map), DEMO_SCRIPT.md (3-min beats + contingencies + judge Q&A), demo/README.md (cold-start runbook, reset script, SQL spot checks). Demo-agent timings marked "to verify at M14". |
| 14 | FINAL REHEARSAL — full killer-demo loop + all checks green | todo | Exit gate |

## Blockers

- **Waiting on user** (asked 2026-06-12): `.env` with TRUEFOUNDRY_API_KEY, AFR_DEMO_MODEL/AFR_TIMELINE_MODEL/EVAL_MODEL, COMPOSIO_API_KEY (fresh), optional PIONEER_API_KEY. Blocks #5, #6, #11, #12, and therefore #14. All other milestones are done. Next action when keys land: build interceptors (#5) → demo agent (#6) → OpenUI timeline (#11) → auto-eval (#12) → final rehearsal (#14).
