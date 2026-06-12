# Demo Runbook

Exact steps to go from cold start to demo-ready. Timings measured on a cold
laptop; re-verify after milestone 14's rehearsal.

> ⚠️ Timings marked *(to verify at M14)* depend on the live demo agent
> (milestone 6), which needs `.env` keys (TrueFoundry, Composio).

## 0. Cold start → demo-ready (~3 min)

```bash
# 1. infra (≈30s first time, ≈5s warm)
docker compose up -d clickhouse
docker compose exec clickhouse clickhouse-client --queries-file /schema/schema.sql

# 2. services (two terminals, ≈5s each)
npm run dev:ingest          # :4000
npm run dev:web             # :3000

# 3. sanity (≈2s)
curl -s http://localhost:4000/healthz   # {"ok":true,"clickhouse":true}
open http://localhost:3000              # run list renders
```

## 1. Record a green run *(to verify at M14)*

```bash
npm run demo
# → prints run_id; appears green in the run list within ~2s of run_end
```

## 2. Record the broken run *(to verify at M14)*

```bash
npm run demo:break
# → real, reproducible failure: an error-status tool_call event in the trace
# → run shows red in the list; timeline shows the failing step
```

## 3. Replay / fork

```bash
# deterministic replay (no live calls, serves recorded outputs):
npm run replay -- --run <run_id>

# fork: replay to just before the failure, run live from there (after the fix):
npm run replay -- --run <run_id> --fork-at <seq_of_failing_step>
```

## 4. Diff

Dashboard → run list → "diff vs <parent>" link on the forked run, or
`/diff/<brokenRunId>/<fixedRunId>` directly. The first-divergence badge must
point at the fixed step.

## Reset between rehearsals

```bash
# wipe all traces (DESTRUCTIVE — demo data only):
docker compose exec clickhouse clickhouse-client --query "TRUNCATE TABLE afr.events"
docker compose exec clickhouse clickhouse-client --query "TRUNCATE TABLE afr.evals"
# then re-record the baseline green run:
npm run demo
```

## Useful spot checks

```bash
# newest runs
docker compose exec clickhouse clickhouse-client --query \
  "SELECT run_id, countMerge(steps) steps, maxMerge(has_error) err FROM afr.runs_rollup GROUP BY run_id ORDER BY maxMerge(ended_at) DESC LIMIT 5"

# a run's timeline in SQL
docker compose exec clickhouse clickhouse-client --query \
  "SELECT seq, event_type, name, status, latency_ms FROM afr.events WHERE run_id = '<id>' ORDER BY seq"
```
