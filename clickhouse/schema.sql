-- Agent Flight Recorder — ClickHouse schema (single source of truth).
-- Idempotent: safe to re-apply. Apply with:
--   docker compose exec clickhouse clickhouse-client --queries-file /schema/schema.sql

CREATE DATABASE IF NOT EXISTS afr;

-- One row per recorded step. Replay read-path is a primary-key scan on (run_id, seq).
CREATE TABLE IF NOT EXISTS afr.events (
    run_id          UUID,
    seq             UInt32,                          -- monotonic step index within run
    span_id         UUID,
    parent_span_id  Nullable(UUID),
    event_type      Enum8('run_start'=1,'model_call'=2,'tool_call'=3,
                          'context_injection'=4,'agent_decision'=5,
                          'run_end'=6,'error'=7),
    name            LowCardinality(String),          -- model id or tool slug
    -- typed JSON with path limits for the hot fields
    input           JSON(max_dynamic_paths=128),
    input_hash      FixedString(64),                 -- canonical SHA-256 → replay/diff key
    output          JSON(max_dynamic_paths=128),
    input_text      String DEFAULT '',               -- flattened text for full-text search
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

-- Per-run rollup for the run list — the dashboard never scans events for the list view.
CREATE MATERIALIZED VIEW IF NOT EXISTS afr.runs_rollup
ENGINE = AggregatingMergeTree ORDER BY (run_id)
AS SELECT
    run_id,
    minState(ts)                       AS started_at,
    maxState(ts)                       AS ended_at,
    countState()                       AS steps,
    sumState(cost_usd)                 AS cost,
    sumState(tokens_in + tokens_out)   AS tokens,
    maxState(status = 'error')         AS has_error,
    anyLastState(mode)                 AS mode,
    anyLastState(parent_run_id)        AS parent_run_id
FROM afr.events GROUP BY run_id;

-- Auto-eval verdicts (LLM-as-judge), written after run_end. Append-only like everything else.
CREATE TABLE IF NOT EXISTS afr.evals (
    run_id       UUID,
    eval_id      UUID,
    verdict      Enum8('pass'=1,'fail'=2),
    score        Float32,                            -- 0..1
    rubric       LowCardinality(String),             -- rubric id (task_success, tool_correctness, efficiency)
    reasoning    String,
    flagged_seq  Nullable(UInt32),                   -- step the judge points at, when failing
    model        LowCardinality(String),             -- judge model id
    created_at   DateTime64(3)
)
ENGINE = MergeTree
ORDER BY (run_id, created_at);
