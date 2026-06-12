// @afr/ingest — stateless HTTP batch endpoint → ClickHouse async inserts.
import { createServer } from "node:http";
import { toJSONEachRow } from "@afr/recorder-sdk/events";
import { insertEvents, pingClickHouse } from "./clickhouse.js";
import { parseIngestBody } from "./validate.js";

const PORT = Number(process.env.AFR_INGEST_PORT ?? 4000);
const API_KEY = process.env.AFR_INGEST_API_KEY ?? "";
const MAX_BODY_BYTES = 16 * 1024 * 1024;

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/healthz") {
      const ch = await pingClickHouse().catch(() => false);
      send(res, ch ? 200 : 503, { ok: ch, clickhouse: ch });
      return;
    }

    if (req.method === "POST" && req.url === "/events") {
      if (API_KEY && req.headers.authorization !== `Bearer ${API_KEY}`) {
        send(res, 401, { error: "missing or invalid api key" });
        return;
      }
      const raw = await readBody(req);
      const parsed = parseIngestBody(raw);
      if (!parsed.ok) {
        send(res, 400, { error: parsed.error });
        return;
      }
      await insertEvents(parsed.body.events.map(toJSONEachRow));
      send(res, 200, { inserted: parsed.body.events.length });
      return;
    }

    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
  }
});

server.listen(PORT, () => {
  console.log(`[ingest] listening on :${PORT} → ClickHouse ${process.env.CLICKHOUSE_URL ?? "http://localhost:8123"}`);
});
