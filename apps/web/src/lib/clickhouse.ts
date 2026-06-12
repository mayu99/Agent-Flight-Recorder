// Read-side ClickHouse access for the dashboard. Server-only.
import "server-only";
import { createClient } from "@clickhouse/client";

export const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: process.env.CLICKHOUSE_DATABASE ?? "afr",
});

export interface RunSummary {
  run_id: string;
  started_at: string;
  ended_at: string;
  steps: number;
  cost: number;
  tokens: number;
  has_error: 0 | 1;
  mode: "record" | "replay" | "fork";
  parent_run_id: string | null;
  verdict: "pass" | "fail" | null;
}

export async function listRuns(limit = 50): Promise<RunSummary[]> {
  const rs = await clickhouse.query({
    query: `
      SELECT
        r.run_id AS run_id,
        toString(minMerge(r.started_at)) AS started_at,
        toString(maxMerge(r.ended_at))   AS ended_at,
        toUInt32(countMerge(r.steps))    AS steps,
        sumMerge(r.cost)                 AS cost,
        toUInt64(sumMerge(r.tokens))     AS tokens,
        maxMerge(r.has_error)            AS has_error,
        anyLastMerge(r.mode)             AS mode,
        toString(anyLastMerge(r.parent_run_id)) AS parent_run_id,
        e.verdict AS verdict
      FROM runs_rollup AS r
      LEFT JOIN (
        SELECT run_id, argMax(verdict, created_at) AS verdict
        FROM evals GROUP BY run_id
      ) AS e ON e.run_id = r.run_id
      GROUP BY r.run_id, e.verdict
      ORDER BY started_at DESC
      LIMIT {limit: UInt32}
    `,
    query_params: { limit },
    format: "JSONEachRow",
  });
  const rows = await rs.json<Record<string, unknown>>();
  return rows.map((r) => ({
    ...(r as unknown as RunSummary),
    parent_run_id: r.parent_run_id === "" || r.parent_run_id === "\\N" ? null : (r.parent_run_id as string),
    verdict: (r.verdict as string) === "" ? null : (r.verdict as "pass" | "fail"),
  }));
}

export interface EvalRow {
  run_id: string;
  eval_id: string;
  verdict: "pass" | "fail";
  score: number;
  rubric: string;
  reasoning: string;
  flagged_seq: number | null;
  model: string;
  created_at: string;
}

export async function listEvals(runId: string): Promise<EvalRow[]> {
  const rs = await clickhouse.query({
    query: `SELECT * EXCEPT (created_at), toString(created_at) AS created_at
            FROM evals WHERE run_id = {runId: UUID} ORDER BY created_at DESC`,
    query_params: { runId },
    format: "JSONEachRow",
  });
  return rs.json<EvalRow>();
}
