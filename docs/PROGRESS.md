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
| 3 | SDK CORE — hashing.ts, transport.ts + unit tests | in-progress | |
| 4 | INGEST — HTTP batch endpoint, zod, async inserts | todo | |
| 5 | INTERCEPTORS — model.ts, tools.ts, context.ts, record() | todo | Needs TRUEFOUNDRY_API_KEY, COMPOSIO_API_KEY |
| 6 | DEMO AGENT — record-mode E2E, real reproducible failure | todo | Needs same keys |
| 7 | REPLAY ENGINE — replayer.ts, divergence.ts, test:replay | todo | |
| 8 | FORK MODE — fork.ts, fix-and-verify flow | todo | |
| 9 | DIFF ENGINE — diff.ts, alignment + classification | todo | |
| 10 | DASHBOARD — run list, API routes, diff view (shadcn) | todo | |
| 11 | TIMELINE — OpenUI generative replay timeline | todo | |
| 12 | AUTO-EVAL — judge.ts, rubrics.ts, verdicts in CH | todo | Needs EVAL_MODEL via gateway |
| 13 | DOCS + DEMO — ARCHITECTURE.md, DEMO_SCRIPT.md, runbook | todo | |
| 14 | FINAL REHEARSAL — full killer-demo loop + all checks green | todo | Exit gate |

## Blockers

- (none yet) — expected soon: `.env` keys for TrueFoundry, Composio, Pioneer (milestones 5+). User will be asked when milestone 5 starts.
