import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@clickhouse/client";
import { events, newId, toJSONEachRow, type RunContext } from "@afr/recorder-sdk/events";
import { GET } from "./route";

/** Stub gateway: streams a small OpenUI Lang program as SSE deltas. */
let llm: Server;
let received: { system?: string; user?: string } = {};

const PROGRAM_LINES = [
  'root = Stack([header, timeline])\n',
  'header = RunSummaryHeader("RID", "error", "record", 3, 1200, 0.001, 100)\n',
  'timeline = Timeline([s1])\n',
  's1 = StepCard(1, "GITHUB_SEARCH", "tool_call", "error", 300, "failed", "ValidationError")\n',
];

beforeAll(async () => {
  llm = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
      received = {
        system: parsed.messages.find((m) => m.role === "system")?.content,
        user: parsed.messages.find((m) => m.role === "user")?.content,
      };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const line of PROGRAM_LINES) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: line } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => llm.listen(0, () => r()));
  process.env.TRUEFOUNDRY_GATEWAY_URL = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
  process.env.TRUEFOUNDRY_API_KEY = "stub";
  process.env.AFR_TIMELINE_MODEL = "stub/timeline-model";
});

afterAll(async () => {
  llm.closeAllConnections();
  await new Promise((r) => llm.close(r));
  delete process.env.TRUEFOUNDRY_GATEWAY_URL;
  delete process.env.TRUEFOUNDRY_API_KEY;
  delete process.env.AFR_TIMELINE_MODEL;
});

async function seedRun(): Promise<string> {
  const ch = createClient({
    url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
    username: "default",
    password: "",
    database: "afr",
  });
  const ctx: RunContext = { run_id: newId(), mode: "record" };
  const trace = [
    events.runStart(ctx, 0, "demo-agent"),
    events.toolCall(ctx, 1, "GITHUB_SEARCH", {
      input: { params: { q: { bad: "shape" } } },
      output: { successful: false, error: "ValidationError" },
      status: "error",
      error: "ValidationError",
      latency_ms: 300,
    }),
    events.runEnd(ctx, 2, "demo-agent", { status: "error", error: "tool failure" }),
  ];
  await ch.insert({
    table: "events",
    values: trace.map(toJSONEachRow),
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
  });
  await ch.close();
  return ctx.run_id;
}

describe("GET /api/runs/[runId]/timeline", () => {
  it("streams OpenUI Lang composed from the run's trace via the gateway", async () => {
    const runId = await seedRun();
    const res = await GET(new Request("http://test.local"), { params: Promise.resolve({ runId }) });
    expect(res.status).toBe(200);
    const text = await res.text();

    // streamed program reached the client as plain text
    expect(text).toContain("root = Stack([header, timeline])");
    expect(text).toContain('StepCard(1, "GITHUB_SEARCH"');

    // the prompt sent to the LLM carried our registry and the real trace
    expect(received.system).toContain("StepCard");
    expect(received.system).toContain("never invent");
    expect(received.user).toContain(runId);
    expect(received.user).toContain("GITHUB_SEARCH");
  });

  it("404s for an unknown run", async () => {
    const res = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ runId: newId() }),
    });
    expect(res.status).toBe(404);
  });

  it("503s with setup instructions when the gateway is unconfigured", async () => {
    const saved = process.env.TRUEFOUNDRY_API_KEY;
    delete process.env.TRUEFOUNDRY_API_KEY;
    const res = await GET(new Request("http://test.local"), {
      params: Promise.resolve({ runId: newId() }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("TRUEFOUNDRY_API_KEY");
    process.env.TRUEFOUNDRY_API_KEY = saved;
  });
});
