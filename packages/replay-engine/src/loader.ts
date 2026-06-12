/** Read-side: load a recorded run from ClickHouse, restoring the event contract. */
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import {
  fromJSONColumn,
  TraceEventSchema,
  type TraceEvent,
} from "@afr/recorder-sdk/events";

export interface LoaderOptions {
  url?: string;
  username?: string;
  password?: string;
  database?: string;
  client?: ClickHouseClient;
}

export function makeClient(opts: LoaderOptions = {}): ClickHouseClient {
  return (
    opts.client ??
    createClient({
      url: opts.url ?? process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
      username: opts.username ?? process.env.CLICKHOUSE_USER ?? "default",
      password: opts.password ?? process.env.CLICKHOUSE_PASSWORD ?? "",
      database: opts.database ?? process.env.CLICKHOUSE_DATABASE ?? "afr",
    })
  );
}

export async function loadRunEvents(
  runId: string,
  opts: LoaderOptions = {},
): Promise<TraceEvent[]> {
  const client = makeClient(opts);
  const rs = await client.query({
    query: `SELECT * FROM events WHERE run_id = {runId: UUID} ORDER BY seq ASC`,
    query_params: { runId },
    format: "JSONEachRow",
  });
  const rows = await rs.json<Record<string, unknown>>();
  return rows.map((row) =>
    TraceEventSchema.parse({
      ...row,
      input: fromJSONColumn(row.input),
      output: fromJSONColumn(row.output),
    }),
  );
}
