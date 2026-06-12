# ClickHouse for Agent Flight Recorder

> Research notes & implementation guide — last verified against live docs and release blogs **June 2026**.
> Latest stable release at time of writing: **ClickHouse 26.5** (June 1, 2026). Latest LTS: **26.3** (April 7, 2026). Previous LTS: **25.8** (August 2025).

ClickHouse is the trace store and fast-query engine for Agent Flight Recorder (AFR): every agent step — model calls, tool calls, injected context, latencies, token counts — is recorded as an event/span and streamed into ClickHouse, where we power timeline reconstruction, run diffing, latency/cost analytics, and auto-eval queries.

---

## Table of Contents

1. [Overview — why ClickHouse for agent traces](#1-overview)
2. [Latest releases & new features (2025–2026)](#2-latest-releases--new-features-20252026)
3. [Getting started — install options](#3-getting-started)
4. [Schema design for trace/event data](#4-schema-design-for-traceevent-data)
5. [Ingestion](#5-ingestion)
6. [Querying for the AFR use case](#6-querying-for-the-afr-use-case)
7. [Observability ecosystem — OTel, ClickStack/HyperDX](#7-observability-ecosystem)
8. [Operational notes & pitfalls](#8-operational-notes--common-pitfalls)
9. [Links](#9-links)

---

## 1. Overview

### What ClickHouse is

ClickHouse is an open-source (Apache 2.0), columnar, OLAP database built for real-time analytics on very large datasets. It routinely ingests millions of rows per second and answers aggregation queries over billions of rows in sub-second time on a single node.

### Architecture in 60 seconds

- **Columnar storage.** Each column is stored (and compressed) separately. A query that touches 5 of 40 columns reads only those 5 from disk. Trace events are wide (many attributes) but queries are narrow (latency, tokens, status) — this is the single biggest reason ClickHouse fits observability workloads.
- **MergeTree engine family.** The workhorse storage engine. Inserts create immutable sorted **parts** on disk; background threads continually **merge** parts into bigger ones (LSM-tree-like). Data inside parts is sorted by the table's `ORDER BY` key and indexed by a **sparse primary index** (one index entry per *granule*, default 8192 rows). This makes range scans on the sort key extremely cheap.
- **Vectorized execution.** Queries process data in blocks of columns using SIMD, not row-at-a-time.
- **Aggressive compression.** LZ4 by default, ZSTD optional, plus specialized per-column codecs (`Delta`, `DoubleDelta`, `Gorilla`, `T64`). Observability data commonly compresses 10–20x.
- **Shared-nothing or shared-storage.** Self-hosted clusters replicate via ClickHouse Keeper (Raft); ClickHouse Cloud uses `SharedMergeTree` on object storage with separated, independently scalable compute.

### Why it fits high-volume trace workloads

| Trace-workload property | ClickHouse answer |
|---|---|
| Append-heavy, almost never updated | MergeTree is insert-optimized; immutable parts |
| High cardinality IDs (run_id, span_id) | Sparse primary index + `ORDER BY` locality; bloom-filter skip indexes |
| Semi-structured payloads (model/tool call JSON) | Native `JSON` type (GA since 25.3) stores each JSON path as a real column |
| Time-windowed queries | Partitioning by date + primary-key timestamp pruning |
| Percentile/rollup analytics | `quantileTDigest`, `quantilesTiming`, materialized views, `-State`/`-Merge` combinators |
| Full-text search over prompts/logs | Text (inverted) index — GA since 26.2 |
| Embedding similarity (find similar runs/steps) | `vector_similarity` HNSW index — GA since 25.8 |
| Retention | Declarative `TTL ... DELETE` per table/column |

This is the same reason ClickHouse underpins large observability products (ClickStack/HyperDX, Sentry, Cloudflare analytics, PostHog, Langfuse v3 — the last one is literally LLM/agent tracing on ClickHouse).

---

## 2. Latest releases & new features (2025–2026)

ClickHouse ships a feature release monthly; every release ending in `.3` and `.8` is an LTS. Verified highlights, newest first:

### 26.5 (June 1, 2026) — current stable
- **ORDER BY … LIMIT pushdown through JOINs** — sort/limit applied before the join: ~20× faster, ~175× less memory on TPC-H benchmarks.
- **GROUP BY … LIMIT without ORDER BY** stops building groups early: ~12× faster, ~185× less memory.
- `filesystem()` table function — query file metadata/contents with SQL.
- `JSON_VALUE`/`JSON_QUERY` accept **multiple JSON paths** in one parse.
- Experimental **web terminal** at `http://localhost:8123/webterminal`.
- `dotProduct` supported as a distance function for vector similarity indexes; negative `LIMIT BY`.
- 38 new features, 51 performance optimizations (most perf-heavy release to date), 224 bug fixes.

### 26.4 (May 2026)
- SQL-compatibility push: `VALUES` as a table expression, `NATURAL JOIN`, compound `INTERVAL` literals.
- **`JSONAllValues`** function — lets you build a text index over *all* JSON sub-columns (great for "search anywhere in the payload").
- Faster `COUNT(DISTINCT)` on many-core machines; prettier `EXPLAIN`; polished web UI.

### 26.3 LTS (April 7, 2026)
- **Async inserts enabled by default** — small inserts are batched server-side with zero client configuration. Major operational win for trace ingestion.
- **Materialized CTEs** (`WITH ... AS MATERIALIZED`) — evaluate a CTE once into a temp table (~2× speedups when a CTE is reused).
- **Sharded Map storage** — hash-bucketed maps during merges: 2–49× faster single-key map lookups, aimed squarely at observability tag/attribute maps.
- `JSONExtract*` functions now work directly on the native `JSON` type.
- **WASM UDFs** (experimental) — UDFs in any language compiling to WebAssembly, sandboxed in Wasmtime.
- JOIN reordering extended to ANTI/SEMI/FULL joins; vertical merge for `TTL DELETE` (memory-friendly TTL on wide tables); `naturalSortKey()`; `EXPLAIN ... pretty=1`.

### 26.2 (March 2026)
- **Text (inverted/full-text) index is GA / production-ready.**
- **QBit vector data type promoted to production** — bit-sliced embedding storage; choose precision *at query time*.
- **ClickStack UI embedded in ClickHouse** — observability UI without a separate deployment.
- `input_format_max_block_wait_ms` — time-based block flushing for slow streams; TOTP auth for CLI; JSON parsing 1.2–2.8× faster.

### 26.1 (February 2026)
- **Async-insert deduplication now works correctly with materialized views** (dedup scoped per table) — important for exactly-once-ish trace pipelines with MV rollups.
- New projection syntax: `PROJECTION p (INDEX col TYPE basic)` for cheap secondary orderings.
- Text index: `sparseGrams` tokenizer; text indexes on `Array(String)`.
- **QBit promoted to beta**; `Variant` type now supported by all functions.
- **Official open-source Kubernetes operator** from ClickHouse Inc.
- `mergeTreeAnalyzeIndexes()` table function — see exactly which row ranges an index scan touches.

### 25.10 (October 2025)
- **QBit data type introduced** (`QBit(BFloat16, 1536)`) — query-time-tunable vector precision.
- Lazy column replication in JOINs (20× on duplicate-heavy joins); runtime bloom filters in joins (2.1× faster, 7× less memory); OR-condition pushdown into joins (24× speedup cases).
- `exclude_materialize_skip_indexes_on_insert` — defer expensive index builds (e.g. HNSW) to background merges, keeping inserts fast.
- Arrow Flight server + client; negative `LIMIT`/`OFFSET`; `LIMIT BY ALL`; auto column statistics for join keys (`auto_statistics_types`).

### 25.8 LTS (August 2025) — the big one for AFR features
- **Vector search GA** — `vector_similarity` (HNSW) index production-ready, with index-only reads, fetch multiplier, binary quantization. Legacy `annoy`/`usearch` index types removed.
- **Lightweight UPDATE** — `UPDATE t SET ... WHERE ...` directly on MergeTree via **patch parts** (small parts containing only changed columns, applied at read time, materialized on merge). Makes small/occasional updates practical (e.g., back-filling an eval verdict onto a span). Beta status.
- **Parquet Reader v3** — native reader (no Arrow dependency), page-level min/max pruning, PREWHERE on Parquet, ~2× faster.
- **Data-lake writes** — write/delete/update for Apache Iceberg (REST/Glue catalogs), Delta Lake writes + time travel; Hive-style partitioned S3 writes (`partition_strategy='hive'`).
- Initial **PromQL dialect** (`dialect='promql'`); S3 IAM role `extra_credentials(role_arn=...)`; `GRANT READ ON S3('s3://bucket/.*')`.

### 25.3 LTS (March 2025)
- **Native `JSON` type GA** (also `Dynamic` and `Variant` types stabilized). Each JSON path is stored as a true columnar subcolumn — ClickHouse's benchmarks vs document stores show orders-of-magnitude faster aggregations.

### ClickHouse Cloud / ecosystem (2025–2026)
- **ClickHouse Agents** (public beta, `ai.clickhouse.cloud`) — first-party, Claude-powered agentic analytics over your Cloud data; no-code AgentBuilder; pluggable MCP servers; subagent workflows.
- **Ask AI agent + remote MCP server (beta)** — managed, domain-specific remote MCP servers spun up from the Cloud UI with fine-grained access control. (AFR angle: point an MCP server at your trace DB and chat with your traces.)
- **AgentHouse** — public demo: LibreChat + ClickHouse MCP server over live datasets.
- **ClickPipes** — managed ingestion (Kafka incl. Protobuf/Avro/JSON with schema-registry, Postgres CDC, S3, Kinesis).
- Compute-compute separation with **primary service idling GA**; managed **Postgres on NVMe** (public beta); `clickhousectl` CLI v0.2.0.
- **chDB** — in-process ClickHouse (currently powered by ClickHouse 25.8.x) with Python, Node.js, Bun, Go, Rust, C/C++ bindings.
- **ClickStack** — the official open-source observability stack (ClickHouse + OTel collector + HyperDX UI); since 26.2 the UI also ships embedded in the server.

---

## 3. Getting started

### Option A — Docker (recommended for hackathon dev)

```bash
# Server (HTTP on 8123, native TCP on 9000)
docker run -d --name afr-clickhouse \
  -p 8123:8123 -p 9000:9000 \
  -e CLICKHOUSE_USER=afr \
  -e CLICKHOUSE_PASSWORD=afr_dev_password \
  -e CLICKHOUSE_DB=afr \
  --ulimit nofile=262144:262144 \
  -v afr_ch_data:/var/lib/clickhouse \
  clickhouse/clickhouse-server:26.3   # pin the LTS; use :latest for 26.5+

# Interactive SQL client against it
docker exec -it afr-clickhouse clickhouse-client --user afr --password afr_dev_password

# Or query over HTTP
curl 'http://localhost:8123/' --user afr:afr_dev_password --data-binary 'SELECT version()'
```

There is also a built-in web UI at `http://localhost:8123/play` (and on 26.5+, an experimental terminal at `/webterminal`).

### Option B — Single binary / clickhouse-local

```bash
curl https://clickhouse.com/ | sh         # downloads a single `clickhouse` binary
./clickhouse server                        # run a full server, or:
./clickhouse local                         # serverless, in-terminal SQL over local files
# e.g. query a JSONL trace dump without any server:
./clickhouse local -q "SELECT count(), avg(latency_ms) FROM file('traces.jsonl', JSONEachRow)"
```

`clickhouse-local` is ideal for offline analysis of exported trace files and for CI.

### Option C — ClickHouse Cloud

Free trial at https://clickhouse.com/cloud — serverless, `SharedMergeTree` over object storage, auto-scaling, ClickPipes ingestion, managed ClickStack, Ask AI/MCP. Connect via HTTPS on port **8443** (HTTP interface) or 9440 (native TLS).

### Option D — chDB (in-process, no server at all)

```bash
pip install chdb
```

```python
import chdb
print(chdb.query("SELECT count() FROM file('traces.jsonl', JSONEachRow)", "Pretty"))

# Persistent session with a real database on disk
from chdb import session
s = session.Session("/tmp/afr-chdb")
s.query("CREATE DATABASE IF NOT EXISTS afr")
```

Bindings also exist for Node.js (`npm i chdb`), Bun, Go, Rust, C/C++. Great for an embedded "replay & inspect a trace file" mode in the AFR CLI with zero infrastructure.

---

## 4. Schema design for trace/event data

### Principles

1. **Engine:** plain `MergeTree` (or `ReplicatedMergeTree`/`SharedMergeTree` in clusters). Trace events are immutable facts — you don't need `ReplacingMergeTree` unless you re-emit events.
2. **`ORDER BY` = your query pattern.** Order columns from lower to higher cardinality, matching your most common filters. For traces, the dominant queries are "everything for run X (in time order)" and "runs for project/agent Y in window Z".
3. **`PARTITION BY` = retention/pruning unit, not performance knob.** Use month or day; aim for ≤ ~100–1000 total partitions. Never partition by high-cardinality keys (e.g. run_id) — that's the classic "too many parts" foot-gun.
4. **`LowCardinality(String)`** for enum-like columns (< ~10k distinct values): step type, model name, status, tool name. Dictionary-encodes them — faster filters & GROUP BY, smaller storage.
5. **Native `JSON` type** for payloads. Each appearing path becomes a real columnar subcolumn; cap pathological cardinality with `max_dynamic_paths` and pin hot paths with explicit types.
6. **Codecs:** `Delta` + `ZSTD` for timestamps and monotonic counters, `ZSTD(1..3)` for big text/JSON blobs, default LZ4 elsewhere.
7. **TTL** for retention; optionally tier old payload columns to cheaper storage or drop just the heavy columns.
8. **Skip indexes** for needle-in-haystack lookups that don't fit the sort key (span_id, trace text search).

### Recommended AFR schema

```sql
CREATE DATABASE IF NOT EXISTS afr;

-- One row per recorded step/span in an agent run.
CREATE TABLE afr.trace_events
(
    -- Identity & topology
    project          LowCardinality(String),
    agent_name       LowCardinality(String),
    run_id           UUID,                                  -- one agent execution
    span_id          String        CODEC(ZSTD(1)),          -- this step
    parent_span_id   String        DEFAULT '' CODEC(ZSTD(1)),
    step_index       UInt32,                                -- monotonic per-run ordinal (replay/diff anchor)

    -- What happened
    event_type       LowCardinality(String),                -- 'model_call' | 'tool_call' | 'context_injection'
                                                            -- | 'agent_start' | 'agent_end' | 'eval' | 'error'
    name             LowCardinality(String),                -- model id or tool name, e.g. 'claude-sonnet-4-5', 'web_search'
    status           LowCardinality(String) DEFAULT 'ok',   -- 'ok' | 'error' | 'timeout' | 'cancelled'

    -- Timing
    start_time       DateTime64(6, 'UTC') CODEC(Delta, ZSTD(1)),
    end_time         DateTime64(6, 'UTC') CODEC(Delta, ZSTD(1)),
    latency_ms       UInt32 MATERIALIZED toUInt32(dateDiff('millisecond', start_time, end_time)),

    -- Token / cost accounting (0 for non-model events)
    input_tokens     UInt32 DEFAULT 0,
    output_tokens    UInt32 DEFAULT 0,
    cache_read_tokens  UInt32 DEFAULT 0,
    cache_write_tokens UInt32 DEFAULT 0,
    cost_usd         Float64 DEFAULT 0,

    -- Payloads: full request/response bodies, tool args/results, injected context.
    -- Native JSON type (GA since 25.3): every path becomes a queryable subcolumn.
    payload          JSON(max_dynamic_paths = 256,
                          SKIP `request.messages`)          -- example: keep giant message arrays out of subcolumns
                     CODEC(ZSTD(3)),

    -- Raw text fields we want full-text search on
    input_text       String DEFAULT '' CODEC(ZSTD(3)),      -- prompt / tool args as text
    output_text      String DEFAULT '' CODEC(ZSTD(3)),      -- completion / tool result as text
    error_message    String DEFAULT '' CODEC(ZSTD(1)),

    -- Free-form small attributes (sharded Map storage is fast since 26.3)
    attributes       Map(LowCardinality(String), String),

    -- Replay determinism
    replay_of_run_id Nullable(UUID),                        -- set when this run is a replay of another
    recorder_version LowCardinality(String) DEFAULT '',
    git_sha          LowCardinality(String) DEFAULT '',

    -- Secondary lookup indexes
    INDEX idx_span    span_id   TYPE bloom_filter(0.01)  GRANULARITY 4,
    INDEX idx_parent  parent_span_id TYPE bloom_filter(0.01) GRANULARITY 4,
    -- Full-text search over prompts/outputs (text index GA since 26.2)
    INDEX idx_in_txt  input_text  TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(input_text)),
    INDEX idx_out_txt output_text TYPE text(tokenizer = splitByNonAlpha, preprocessor = lower(output_text)),
    INDEX idx_err     error_message TYPE text(tokenizer = splitByNonAlpha)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(start_time)
ORDER BY (project, agent_name, run_id, step_index)
TTL toDateTime(start_time) + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;
```

Design notes:

- **`ORDER BY (project, agent_name, run_id, step_index)`** makes "fetch full run timeline" a tight contiguous range read, and "all runs for agent X" a prefix scan. If you mostly query by time window across runs, an alternative is `ORDER BY (project, toStartOfHour(start_time), run_id, step_index)` — pick one based on your dominant query; you can add a **projection** for the other ordering:

```sql
ALTER TABLE afr.trace_events ADD PROJECTION by_time
(
    SELECT * ORDER BY (project, start_time)
);
ALTER TABLE afr.trace_events MATERIALIZE PROJECTION by_time;
```

- **`step_index`** is AFR's replay/diff anchor: assign it in the harness (0,1,2,…) so two runs of the same task can be aligned step-by-step regardless of wall-clock time.
- **JSON subcolumn access** is just dot notation: `payload.request.model`, `payload.response.stop_reason`, `payload.tool.arguments.query`. Cast when needed: `payload.usage.total_tokens::UInt32`. `^` prefix returns a sub-object: `payload.^request`.
- **Column TTL** can drop heavy payloads earlier than the row:

```sql
ALTER TABLE afr.trace_events
    MODIFY COLUMN input_text String TTL toDateTime(start_time) + INTERVAL 30 DAY,
    MODIFY COLUMN output_text String TTL toDateTime(start_time) + INTERVAL 30 DAY;
```

- **Lightweight updates** (beta, 25.8+) let auto-eval write verdicts back without rewriting parts. Enable block-tracking columns at table creation if you plan to use it:

```sql
-- add to SETTINGS: enable_block_number_column = 1, enable_block_offset_column = 1
UPDATE afr.trace_events
SET attributes = mapUpdate(attributes, map('eval_verdict', 'pass'))
WHERE run_id = toUUID('018f3c1e-aaaa-7bbb-8ccc-1234567890ab') AND event_type = 'agent_end';
```

  (Keep updates to a small fraction of rows — patch parts are designed for ≤ ~10% of a table. For high-volume eval results, prefer a separate `afr.eval_results` table joined on `run_id`/`span_id`.)

### Optional: run-level summary table

A small companion table keyed by run avoids scanning events for run lists:

```sql
CREATE TABLE afr.runs
(
    project        LowCardinality(String),
    agent_name     LowCardinality(String),
    run_id         UUID,
    started_at     DateTime64(3, 'UTC') CODEC(Delta, ZSTD),
    finished_at    Nullable(DateTime64(3, 'UTC')),
    status         LowCardinality(String) DEFAULT 'running',
    task_label     String DEFAULT '',                -- what the agent was asked to do
    replay_of      Nullable(UUID),
    total_steps    UInt32 DEFAULT 0,
    total_cost_usd Float64 DEFAULT 0,
    tags           Map(LowCardinality(String), String)
)
ENGINE = ReplacingMergeTree(finished_at)            -- last write wins on run completion
PARTITION BY toYYYYMM(started_at)
ORDER BY (project, agent_name, run_id);
-- Query with FINAL or argMax to collapse duplicates:
-- SELECT * FROM afr.runs FINAL WHERE project = 'demo'
```

### Optional: embeddings for "find similar steps/runs"

```sql
CREATE TABLE afr.step_embeddings
(
    run_id    UUID,
    span_id   String,
    kind      LowCardinality(String),               -- 'prompt' | 'output' | 'task'
    embedding Array(Float32),                        -- e.g. 1536-d
    INDEX idx_vec embedding TYPE vector_similarity('hnsw', 'cosineDistance', 1536)
)
ENGINE = MergeTree
ORDER BY (run_id, span_id);

-- k-NN: find the 10 most similar prompts to a reference vector
WITH [/* 1536 floats */]::Array(Float32) AS ref
SELECT run_id, span_id, cosineDistance(embedding, ref) AS d
FROM afr.step_embeddings
WHERE kind = 'prompt'
ORDER BY d ASC
LIMIT 10;
```

Vector similarity indexes are GA since 25.8 (HNSW; `L2Distance`/`cosineDistance` with `ASC`, `dotProduct` with `DESC` since 26.5; quantization `bf16` by default, down to `b1` binary). If HNSW builds slow your inserts, defer them with `SETTINGS exclude_materialize_skip_indexes_on_insert = 'idx_vec'` (25.10+) so they're built on merges.

---

## 5. Ingestion

### The golden rules

1. **Prefer fewer, bigger inserts.** Each `INSERT` creates a part. Ideal: ≥1k–100k rows per insert, ~1 insert/sec per table.
2. **If you can't batch client-side, use async inserts** — the server buffers and flushes for you. **On 26.3+ async inserts are on by default**; on older versions set `async_insert = 1, wait_for_async_insert = 1`.
   - Flush triggers (first wins): `async_insert_max_data_size` (10 MiB default in recent versions; docs cite 100 MiB on some channels — check `SELECT * FROM system.settings WHERE name LIKE 'async_insert%'`), `async_insert_busy_timeout_ms` (~200 ms, adaptive since 24.2), `async_insert_max_query_number` (450).
   - `wait_for_async_insert = 1` (default): client gets the ack after the buffer is flushed durably — keep this in production; `0` is fire-and-forget.
   - Since 26.1, async-insert **deduplication works correctly with materialized views** (dedup scoped per table).
3. **Use `JSONEachRow` (NDJSON) or native format** for inserts; HTTP interface is fine for almost everything.

### HTTP interface (no client library)

```bash
# Insert NDJSON events
curl "http://localhost:8123/?query=INSERT%20INTO%20afr.trace_events%20FORMAT%20JSONEachRow" \
  --user afr:afr_dev_password \
  --data-binary @events.ndjson

# Query, get JSON back
curl "http://localhost:8123/" --user afr:afr_dev_password --data-binary \
  "SELECT run_id, count() AS steps FROM afr.trace_events GROUP BY run_id FORMAT JSON"
```

### Node.js — `@clickhouse/client` (official)

```bash
npm i @clickhouse/client     # Node.js; use @clickhouse/client-web for browser/CF Workers
```

```typescript
import { createClient } from '@clickhouse/client'

const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
  username: process.env.CLICKHOUSE_USER ?? 'afr',
  password: process.env.CLICKHOUSE_PASSWORD ?? 'afr_dev_password',
  database: 'afr',
  request_timeout: 30_000,
})

// --- Recorder: flush a batch of trace events ---
export async function flushEvents(events: TraceEvent[]) {
  await ch.insert({
    table: 'trace_events',
    values: events,                 // array of plain objects matching column names
    format: 'JSONEachRow',
    clickhouse_settings: {
      async_insert: 1,              // server-side batching (default on 26.3+)
      wait_for_async_insert: 1,     // durable ack
    },
  })
}

// --- Reader: full timeline for a run ---
export async function getRunTimeline(runId: string) {
  const rs = await ch.query({
    query: `
      SELECT step_index, span_id, parent_span_id, event_type, name, status,
             start_time, latency_ms, input_tokens, output_tokens, cost_usd,
             payload.response.stop_reason AS stop_reason
      FROM trace_events
      WHERE run_id = {run_id: UUID}
      ORDER BY step_index`,
    query_params: { run_id: runId },     // parameterized — no SQL injection
    format: 'JSONEachRow',
  })
  return rs.json<TimelineRow>()
}

// --- Streaming large result sets ---
const rs = await ch.query({
  query: 'SELECT * FROM trace_events WHERE project = {p: String}',
  query_params: { p: 'demo' },
  format: 'JSONEachRow',
})
for await (const rows of rs.stream()) {
  for (const row of rows) handle(row.json())
}
```

The client is zero-dependency, TypeScript-native, and also supports inserting from Node streams (useful to pipe the recorder's event stream straight in).

### Python — `clickhouse-connect` (official)

```bash
pip install clickhouse-connect
```

```python
import clickhouse_connect

client = clickhouse_connect.get_client(
    host='localhost', port=8123,
    username='afr', password='afr_dev_password',
    database='afr',
)
# ClickHouse Cloud: get_client(host='xxx.clickhouse.cloud', port=8443, username='default', password=...)

# DDL / commands
client.command('SELECT 1')

# Insert a batch of events (column-oriented or row-oriented both supported)
rows = [
    ['demo', 'researcher', run_id, span_id, '', 0, 'model_call', 'claude-sonnet-4-5', 'ok',
     start, end, 1200, 350, 0, 0, 0.0123,
     '{"request":{"model":"claude-sonnet-4-5"},"response":{"stop_reason":"end_turn"}}',
     prompt_text, output_text, '', {}, None, '0.1.0', 'abc123'],
]
client.insert(
    'trace_events', rows,
    column_names=['project','agent_name','run_id','span_id','parent_span_id','step_index',
                  'event_type','name','status','start_time','end_time',
                  'input_tokens','output_tokens','cache_read_tokens','cache_write_tokens','cost_usd',
                  'payload','input_text','output_text','error_message','attributes',
                  'replay_of_run_id','recorder_version','git_sha'],
    settings={'async_insert': 1, 'wait_for_async_insert': 1},
)

# Query → rows
res = client.query(
    "SELECT event_type, count(), quantile(0.95)(latency_ms) FROM trace_events "
    "WHERE run_id = {rid:UUID} GROUP BY event_type",
    parameters={'rid': run_id},
)
print(res.result_rows)

# Query → pandas DataFrame (handy for eval notebooks)
df = client.query_df("SELECT * FROM trace_events WHERE project = 'demo' LIMIT 1000")
```

### Kafka / Redpanda pipeline (if you want a buffer between harness and DB)

```sql
-- 1. Source: reads from the topic
CREATE TABLE afr.trace_events_kafka
(
    raw String                                  -- or declare full columns + JSONEachRow
)
ENGINE = Kafka
SETTINGS kafka_broker_list = 'redpanda:9092',
         kafka_topic_list = 'afr.traces',
         kafka_group_name = 'clickhouse-afr',
         kafka_format = 'JSONAsString',
         kafka_num_consumers = 1;

-- 2. Materialized view: continuously moves rows into the real table
CREATE MATERIALIZED VIEW afr.trace_events_consumer TO afr.trace_events AS
SELECT
    JSONExtractString(raw, 'project')        AS project,
    JSONExtractString(raw, 'agent_name')     AS agent_name,
    toUUID(JSONExtractString(raw, 'run_id')) AS run_id,
    JSONExtractString(raw, 'span_id')        AS span_id,
    JSONExtractString(raw, 'parent_span_id') AS parent_span_id,
    JSONExtractUInt(raw, 'step_index')       AS step_index,
    JSONExtractString(raw, 'event_type')     AS event_type,
    JSONExtractString(raw, 'name')           AS name,
    JSONExtractString(raw, 'status')         AS status,
    parseDateTime64BestEffort(JSONExtractString(raw, 'start_time'), 6) AS start_time,
    parseDateTime64BestEffort(JSONExtractString(raw, 'end_time'), 6)   AS end_time,
    JSONExtractUInt(raw, 'input_tokens')     AS input_tokens,
    JSONExtractUInt(raw, 'output_tokens')    AS output_tokens,
    JSONExtractFloat(raw, 'cost_usd')        AS cost_usd,
    JSONExtractString(raw, 'payload')::JSON  AS payload,
    JSONExtractString(raw, 'input_text')     AS input_text,
    JSONExtractString(raw, 'output_text')    AS output_text
FROM afr.trace_events_kafka;
```

(26.x adds `kafka_autodetect_client_rack` for AZ-aware consumption and `kafka_map_virtual_columns_on_write` for producing `_key`/`_timestamp`/`_headers`. On ClickHouse Cloud, prefer **ClickPipes** for managed Kafka ingestion.)

For a hackathon, skip Kafka: HTTP + async inserts straight from the harness is simpler and plenty fast.

---

## 6. Querying for the AFR use case

### 6.1 Full run timeline

```sql
SELECT
    step_index,
    span_id,
    parent_span_id,
    event_type,
    name,
    status,
    start_time,
    latency_ms,
    input_tokens + output_tokens                   AS tokens,
    cost_usd,
    payload.response.stop_reason                   AS stop_reason,
    left(input_text, 200)                          AS input_preview,
    left(output_text, 200)                         AS output_preview
FROM afr.trace_events
WHERE run_id = {run_id: UUID}
ORDER BY step_index ASC;
```

Tree reconstruction (parent/child nesting) is best done in the app layer from `span_id`/`parent_span_id`, but you can compute depth in SQL for small runs with a recursive CTE (supported since 24.4):

```sql
WITH RECURSIVE tree AS (
    SELECT span_id, parent_span_id, name, step_index, 0 AS depth
    FROM afr.trace_events
    WHERE run_id = {run_id: UUID} AND parent_span_id = ''
    UNION ALL
    SELECT e.span_id, e.parent_span_id, e.name, e.step_index, t.depth + 1
    FROM afr.trace_events e
    INNER JOIN tree t ON e.parent_span_id = t.span_id
    WHERE e.run_id = {run_id: UUID}
)
SELECT repeat('  ', depth) || name AS step, step_index FROM tree ORDER BY step_index;
```

### 6.2 Diff two runs (step-aligned)

Align on `step_index` and surface divergences — the heart of replay debugging:

```sql
WITH
    a AS (SELECT * FROM afr.trace_events WHERE run_id = {run_a: UUID}),
    b AS (SELECT * FROM afr.trace_events WHERE run_id = {run_b: UUID})
SELECT
    coalesce(a.step_index, b.step_index)                          AS step,
    a.event_type  AS a_type,        b.event_type  AS b_type,
    a.name        AS a_name,        b.name        AS b_name,
    a.status      AS a_status,      b.status      AS b_status,
    a.latency_ms  AS a_latency_ms,  b.latency_ms  AS b_latency_ms,
    b.latency_ms - a.latency_ms                                   AS latency_delta_ms,
    (a.output_tokens + a.input_tokens)                            AS a_tokens,
    (b.output_tokens + b.input_tokens)                            AS b_tokens,
    -- cheap divergence signals
    a.name != b.name OR a.event_type != b.event_type              AS step_diverged,
    cityHash64(a.input_text)  != cityHash64(b.input_text)         AS input_changed,
    cityHash64(a.output_text) != cityHash64(b.output_text)        AS output_changed
FROM a
FULL OUTER JOIN b ON a.step_index = b.step_index
ORDER BY step;
```

First divergence point:

```sql
SELECT min(step) AS first_divergent_step
FROM (
    SELECT coalesce(a.step_index, b.step_index) AS step,
           a.name != b.name
           OR a.event_type != b.event_type
           OR cityHash64(a.output_text) != cityHash64(b.output_text) AS diverged
    FROM (SELECT * FROM afr.trace_events WHERE run_id = {run_a: UUID}) a
    FULL OUTER JOIN (SELECT * FROM afr.trace_events WHERE run_id = {run_b: UUID}) b
        USING (step_index)
)
WHERE diverged;
```

Aggregate diff (run scorecard):

```sql
SELECT
    run_id,
    count()                                   AS steps,
    countIf(event_type = 'model_call')        AS model_calls,
    countIf(event_type = 'tool_call')         AS tool_calls,
    countIf(status = 'error')                 AS errors,
    sum(latency_ms)                           AS total_latency_ms,
    sum(input_tokens)                         AS in_tokens,
    sum(output_tokens)                        AS out_tokens,
    round(sum(cost_usd), 4)                   AS cost_usd
FROM afr.trace_events
WHERE run_id IN ({run_a: UUID}, {run_b: UUID})
GROUP BY run_id;
```

### 6.3 Latency percentiles

```sql
-- p50/p90/p99 model-call latency per model, last 24h
SELECT
    name AS model,
    count()                                        AS calls,
    quantilesTDigest(0.5, 0.9, 0.99)(latency_ms)   AS p50_p90_p99,
    max(latency_ms)                                AS max_ms
FROM afr.trace_events
WHERE event_type = 'model_call'
  AND start_time > now() - INTERVAL 1 DAY
GROUP BY model
ORDER BY calls DESC;
```

Quantile function guide: `quantile`/`quantiles` (reservoir sampling, approximate, fast), `quantileTDigest` (mergeable sketch — use in materialized views), `quantileExact` (exact, memory-heavy), `quantileTiming` (optimized for ms-scale latency distributions). The `quantiles...(...)(col)` plural form computes several levels in one pass.

### 6.4 Token & cost rollups

```sql
-- Daily cost per project/agent/model
SELECT
    toDate(start_time)        AS day,
    project, agent_name, name AS model,
    sum(input_tokens)         AS in_tok,
    sum(output_tokens)        AS out_tok,
    sum(cache_read_tokens)    AS cache_tok,
    round(sum(cost_usd), 2)   AS cost_usd
FROM afr.trace_events
WHERE event_type = 'model_call'
GROUP BY day, project, agent_name, model
ORDER BY day DESC, cost_usd DESC;

-- Most expensive runs this week
SELECT run_id, any(agent_name) AS agent, sum(cost_usd) AS cost, count() AS steps
FROM afr.trace_events
WHERE start_time > now() - INTERVAL 7 DAY
GROUP BY run_id
ORDER BY cost DESC
LIMIT 20;
```

### 6.5 Materialized view for pre-aggregated stats

Incremental MVs transform data **at insert time** — dashboards stay instant regardless of raw volume:

```sql
CREATE TABLE afr.run_stats_agg
(
    project       LowCardinality(String),
    agent_name    LowCardinality(String),
    day           Date,
    model         LowCardinality(String),
    calls         AggregateFunction(count),
    latency_q     AggregateFunction(quantilesTDigest(0.5, 0.9, 0.99), UInt32),
    in_tokens     SimpleAggregateFunction(sum, UInt64),
    out_tokens    SimpleAggregateFunction(sum, UInt64),
    cost_usd      SimpleAggregateFunction(sum, Float64),
    errors        SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
ORDER BY (project, agent_name, day, model);

CREATE MATERIALIZED VIEW afr.run_stats_mv TO afr.run_stats_agg AS
SELECT
    project, agent_name,
    toDate(start_time)                                   AS day,
    name                                                 AS model,
    countState()                                         AS calls,
    quantilesTDigestState(0.5, 0.9, 0.99)(latency_ms)    AS latency_q,
    sum(input_tokens)                                    AS in_tokens,
    sum(output_tokens)                                   AS out_tokens,
    sum(cost_usd)                                        AS cost_usd,
    sum(toUInt64(status = 'error'))                      AS errors
FROM afr.trace_events
WHERE event_type = 'model_call'
GROUP BY project, agent_name, day, model;

-- Read it back with -Merge combinators:
SELECT
    day, model,
    countMerge(calls)                                  AS calls,
    quantilesTDigestMerge(0.5, 0.9, 0.99)(latency_q)   AS p50_p90_p99,
    sum(cost_usd)                                      AS cost
FROM afr.run_stats_agg
WHERE project = 'demo'
GROUP BY day, model
ORDER BY day DESC;
```

(There are also **refreshable** materialized views — periodic full recomputation, with `SYSTEM PAUSE VIEW` control since 26.x — useful for top-N leaderboards.)

### 6.6 Full-text search over traces

With the text indexes defined in §4 (GA since 26.2):

```sql
-- All steps where the model output mentions both tokens
SELECT run_id, span_id, step_index, left(output_text, 300) AS snippet
FROM afr.trace_events
WHERE hasAllTokens(output_text, ['rate', 'limit'])
ORDER BY start_time DESC
LIMIT 50;

-- Any error mentioning 'timeout' OR 'ECONNRESET'
SELECT run_id, name, error_message
FROM afr.trace_events
WHERE status = 'error' AND hasAnyTokens(error_message, ['timeout', 'ECONNRESET']);
```

`hasAnyTokens`/`hasAllTokens` are the recommended index-accelerated functions; `hasToken`, `LIKE`, `match`, `multiSearchAny`, `startsWith`/`endsWith` are also index-aware. Since 26.4 `JSONAllValues` lets you index every value in a JSON column.

### 6.7 Eval-ish queries

```sql
-- Tool-call failure rate by tool, trending by day
SELECT toDate(start_time) AS day, name AS tool,
       countIf(status != 'ok') / count() AS failure_rate, count() AS calls
FROM afr.trace_events
WHERE event_type = 'tool_call'
GROUP BY day, tool
HAVING calls > 10
ORDER BY day DESC, failure_rate DESC;

-- Runs that looped (same tool called > 5 times consecutively is app-level; same tool > N times is easy):
SELECT run_id, name AS tool, count() AS calls
FROM afr.trace_events
WHERE event_type = 'tool_call'
GROUP BY run_id, tool
HAVING calls > 5
ORDER BY calls DESC;

-- Window functions: step-over-step latency growth within a run
SELECT step_index, name, latency_ms,
       latency_ms - lagInFrame(latency_ms) OVER (ORDER BY step_index) AS delta_ms
FROM afr.trace_events
WHERE run_id = {run_id: UUID} AND event_type = 'model_call'
ORDER BY step_index;
```

---

## 7. Observability ecosystem

### ClickStack (ClickHouse + OTel + HyperDX)

**ClickStack** is ClickHouse's official open-source observability stack — logs, traces, metrics, and session replay unified on ClickHouse. Components:

1. **HyperDX UI** — search (Lucene-style + SQL), trace waterfall exploration, dashboards, alerting. ClickHouse acquired HyperDX; since **26.2 the ClickStack UI ships embedded in the ClickHouse server** as well.
2. **OTel collector (ClickStack distribution)** — preconfigured with an opinionated, ClickHouse-optimized schema; receives OTLP and writes batched inserts.
3. **ClickHouse** — the store.
4. MongoDB (OSS deployment only) for UI state.

Quick start (all-in-one image — collector + ClickHouse + HyperDX):

```bash
docker run -d --name clickstack \
  -p 8080:8080 -p 4317:4317 -p 4318:4318 \
  docker.hyperdx.io/hyperdx/hyperdx-all-in-one
# UI on :8080, OTLP gRPC :4317, OTLP HTTP :4318
```

Managed ClickStack exists on ClickHouse Cloud (you run only the collector).

### OpenTelemetry → ClickHouse directly

The **OTel collector's ClickHouse exporter** (`clickhouseexporter`, in opentelemetry-collector-contrib) writes logs/traces/metrics into ClickHouse tables (`otel_traces`, `otel_logs`, …) and auto-creates schema:

```yaml
# otel-collector config snippet
receivers:
  otlp:
    protocols: { grpc: {}, http: {} }
exporters:
  clickhouse:
    endpoint: tcp://localhost:9000?dial_timeout=10s
    database: otel
    async_insert: true
    create_schema: true
    ttl: 720h
    compress: lz4
service:
  pipelines:
    traces:  { receivers: [otlp], exporters: [clickhouse] }
    logs:    { receivers: [otlp], exporters: [clickhouse] }
```

### Pattern for AFR

Two complementary integration options:

- **Native AFR schema (recommended primary):** the harness writes the rich `afr.trace_events` schema in §4 directly via `@clickhouse/client` / `clickhouse-connect`. You own the semantics (step_index, replay linkage, token/cost fields) — OTel's span model doesn't capture those natively.
- **OTel bridge (optional):** also emit standard OTel spans (using the GenAI semantic conventions — `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, …) to an OTLP endpoint, so AFR traces appear in ClickStack/HyperDX waterfalls alongside the rest of the user's infra. ClickHouse's own blog ("LLM observability with ClickStack, OpenTelemetry, and MCP") demonstrates exactly this shape: LibreChat + a Python MCP server auto-instrumented with OTel, attributes like `conversationId`, `promptTokens`, `completionTokens` flowing into `otel_logs`/`otel_traces`, then SQL + HyperDX on top.
- **MCP on top of traces:** the ClickHouse MCP server (and Cloud's remote MCP-as-a-service / Ask AI / ClickHouse Agents beta) lets an LLM query your trace DB conversationally — a free "chat with your agent's flight history" demo feature.

Related: Langfuse, Laminar, and SigNoz all use ClickHouse as their trace backend — validation that this exact workload shape is well-trodden.

---

## 8. Operational notes & common pitfalls

### Settings worth knowing

| Setting | Why |
|---|---|
| `async_insert`, `wait_for_async_insert` | Server-side batching (default-on since 26.3); keep wait=1 |
| `max_memory_usage` | Per-query memory cap (default 10 GiB-ish); raise for heavy diffs/joins |
| `max_bytes_ratio_before_external_group_by` / `..._external_join` | Spill to disk instead of OOM (the join variant landed in 26.x) |
| `max_threads` | Per-query parallelism (defaults to cores) |
| `join_use_nulls = 1` | Make OUTER JOIN missing sides NULL (SQL-standard) — important for the run-diff FULL JOIN |
| `optimize_read_in_order` | Fast ORDER BY along the primary key (on by default) |
| `input_format_max_block_wait_ms` | Time-based block batching for slow streams (26.2+) |
| `lightweight_delete_mode`, `update_sequential_consistency` | Lightweight DELETE/UPDATE behavior |

### Pitfalls (ranked by how likely they bite a trace recorder)

1. **Too many parts.** Symptom: `DB::Exception: Too many parts (N). Merges are processing significantly slower than inserts`. Cause: many small synchronous inserts and/or high-cardinality `PARTITION BY`. Fix: batch, use async inserts, partition by month/day only.
2. **One insert per event.** Never `INSERT` per span synchronously. Buffer in the harness (e.g. flush every 1000 events or 2s) *or* lean on async inserts.
3. **Mutations are heavyweight.** `ALTER TABLE ... UPDATE/DELETE` rewrites whole parts asynchronously — fine as a rare admin op, terrible as a workflow. Use lightweight `UPDATE`/`DELETE` (patch parts) for small fixes, or model changes as new inserted rows (event sourcing) / `ReplacingMergeTree`.
4. **`SELECT *` on wide tables.** Defeats columnar storage; always project the columns you need (especially skip `payload`/`*_text` unless required).
5. **Nullable everywhere.** `Nullable(T)` adds a sidecar bitmap per column — measurable overhead. Prefer sentinel defaults (`''`, `0`) where semantics allow.
6. **Wrong ORDER BY.** If run-timeline queries scan the whole table, your sort key doesn't lead with your filter columns. Check with `EXPLAIN indexes = 1 SELECT ...` (or `pretty=1` on 26.3+).
7. **JSON path explosion.** Wildly heterogeneous payloads can exceed `max_dynamic_paths` (overflow paths land in a slower shared store). Pin hot paths with explicit types, `SKIP` noisy ones.
8. **Memory on big GROUP BY/JOIN.** Watch `system.query_log` (`memory_usage`, `read_rows`); enable external aggregation/join spill ratios on small machines.
9. **FINAL abuse.** `SELECT ... FINAL` on ReplacingMergeTree is convenient but costly at scale; prefer `argMax`/`LIMIT 1 BY` patterns for hot paths.
10. **Forgetting deduplication semantics.** Identical insert blocks are deduplicated on replicated/Cloud tables; async-insert dedup is off by default (and per-table-scoped with MVs only since 26.1). For exactly-once, carry an idempotency key (e.g. `span_id`) and dedupe at read or via ReplacingMergeTree.

### Introspection cheatsheet

```sql
SELECT * FROM system.parts WHERE table = 'trace_events' AND active;        -- part count/sizes
SELECT * FROM system.query_log WHERE type = 'QueryFinish' ORDER BY event_time DESC LIMIT 10;
SELECT * FROM system.asynchronous_inserts;                                  -- pending async buffers
SELECT table, formatReadableSize(sum(bytes_on_disk)) FROM system.parts
WHERE active GROUP BY table;                                                -- storage by table
SELECT name, value FROM system.settings WHERE changed;                      -- non-default settings
```

---

## 9. Links

**Official docs**
- Docs home: https://clickhouse.com/docs
- MergeTree engine: https://clickhouse.com/docs/engines/table-engines/mergetree-family/mergetree
- JSON data type: https://clickhouse.com/docs/sql-reference/data-types/newjson
- Async inserts guide: https://clickhouse.com/docs/optimize/asynchronous-inserts
- Lightweight UPDATE: https://clickhouse.com/docs/sql-reference/statements/update
- Text (full-text) indexes: https://clickhouse.com/docs/engines/table-engines/mergetree-family/invertedindexes
- Vector similarity (ANN) indexes: https://clickhouse.com/docs/engines/table-engines/mergetree-family/annindexes
- Schema design best practices: https://clickhouse.com/docs/best-practices/choosing-a-primary-key
- JavaScript client: https://clickhouse.com/docs/integrations/javascript
- Python client (clickhouse-connect): https://clickhouse.com/docs/integrations/python
- Kafka engine: https://clickhouse.com/docs/engines/table-engines/integrations/kafka
- ClickStack overview: https://clickhouse.com/docs/use-cases/observability/clickstack/overview
- chDB: https://clickhouse.com/docs/chdb
- Changelog: https://clickhouse.com/docs/whats-new/changelog
- Cloud changelog: https://clickhouse.com/docs/whats-new/changelog/cloud

**GitHub**
- ClickHouse: https://github.com/ClickHouse/ClickHouse (+ Releases page for exact versions)
- ClickStack: https://github.com/ClickHouse/ClickStack
- HyperDX: https://github.com/hyperdxio/hyperdx
- Node client: https://github.com/ClickHouse/clickhouse-js
- Python client: https://github.com/ClickHouse/clickhouse-connect
- chDB: https://github.com/chdb-io/chdb
- OTel ClickHouse exporter: https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/clickhouseexporter
- ClickHouse MCP server: https://github.com/ClickHouse/mcp-clickhouse

**Release & feature blog posts used**
- 26.5: https://clickhouse.com/blog/clickhouse-release-26-05
- 26.4: https://clickhouse.com/blog/clickhouse-release-26-04
- 26.3: https://clickhouse.com/blog/clickhouse-release-26-03
- 26.2: https://clickhouse.com/blog/clickhouse-release-26-02
- 26.1: https://clickhouse.com/blog/clickhouse-release-26-01
- 25.10: https://clickhouse.com/blog/clickhouse-release-25-10
- 25.8 LTS: https://clickhouse.com/blog/clickhouse-release-25-08
- 2025 roundup: https://clickhouse.com/blog/clickhouse-2025-roundup
- JSON type deep dive: https://clickhouse.com/blog/a-new-powerful-json-data-type-for-clickhouse
- ClickStack announcement: https://clickhouse.com/blog/clickstack-a-high-performance-oss-observability-stack-on-clickhouse
- LLM observability w/ ClickStack + MCP: https://clickhouse.com/blog/llm-observability-clickstack-mcp
- ClickHouse Agents beta: https://clickhouse.com/blog/clickhouse-agents-beta
- Ask AI + remote MCP: https://clickhouse.com/blog/agentic-analytics-ask-ai-agent-and-remote-mcp-server-beta-launch
- AgentHouse: https://clickhouse.com/blog/agenthouse-demo-clickhouse-llm-mcp
