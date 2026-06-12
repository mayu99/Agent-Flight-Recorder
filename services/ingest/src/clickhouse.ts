import { createClient } from "@clickhouse/client";

export const clickhouse = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: process.env.CLICKHOUSE_USER ?? "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "",
  database: process.env.CLICKHOUSE_DATABASE ?? "afr",
  // Server-side batching: ingest stays stateless and restart-safe. The server
  // groups small inserts; wait_for_async_insert=1 means a 200 from ClickHouse
  // guarantees durability, which is what makes SDK retries safe end-to-end.
  clickhouse_settings: {
    async_insert: 1,
    wait_for_async_insert: 1,
  },
});

export async function insertEvents(rows: Record<string, unknown>[]): Promise<void> {
  await clickhouse.insert({
    table: "events",
    values: rows,
    format: "JSONEachRow",
  });
}

export async function pingClickHouse(): Promise<boolean> {
  const result = await clickhouse.ping();
  return result.success;
}
