import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient } from "@clickhouse/client";
import { events, newId, toJSONEachRow, type RunContext, type TraceEvent } from "@afr/recorder-sdk/events";
import { judgeTrace, evalRun } from "./judge";
import { rubricMessages, RUBRICS } from "./rubrics";

/**
 * Stub OpenAI-compatible judge: fails tool_correctness pointing at the error
 * step it finds in the submitted trace (parsed from the user message), passes
 * the other rubrics. Mechanics-level verification — the live gateway round-trip
 * happens at milestone 14 with real keys.
 */
let llm: Server;
let llmUrl: string;
const seenRequests: Array<{ system: string; user: string }> = [];

beforeAll(async () => {
  llm = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as {
        messages: Array<{ role: string; content: string }>;
        response_format?: { type?: string };
      };
      const system = parsed.messages.find((m) => m.role === "system")?.content ?? "";
      const user = parsed.messages.find((m) => m.role === "user")?.content ?? "";
      seenRequests.push({ system, user });

      const rubric = /Rubric: (\w+)/.exec(user)?.[1];
      // parse the embedded trace JSON and locate the actual error-status tool call
      const traceJson = user.slice(user.indexOf("["));
      const steps = JSON.parse(traceJson) as Array<{ seq: number; event_type: string; status: string }>;
      const errorSeq = steps.find((s) => s.event_type === "tool_call" && s.status === "error")?.seq;
      const verdict =
        rubric === "tool_correctness" && errorSeq !== undefined
          ? {
              verdict: "fail",
              score: 0.1,
              reasoning: `tool call at seq ${errorSeq} failed with malformed arguments`,
              flagged_seq: errorSeq,
            }
          : { verdict: "pass", score: 0.9, reasoning: "looks fine", flagged_seq: null };

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(verdict) } }] }));
    });
  });
  await new Promise<void>((r) => llm.listen(0, () => r()));
  llmUrl = `http://127.0.0.1:${(llm.address() as AddressInfo).port}`;
});

afterAll(async () => {
  llm.closeAllConnections();
  await new Promise((r) => llm.close(r));
});

function brokenTrace(): { runId: string; trace: TraceEvent[] } {
  const ctx: RunContext = { run_id: newId(), mode: "record" };
  let seq = 0;
  const trace = [
    events.runStart(ctx, seq++, "demo-agent"),
    events.modelCall(ctx, seq++, "openai-main/gpt-4o", {
      input: { messages: [{ role: "user", content: "research repos" }] },
      output: { choices: [] },
      status: "ok",
      latency_ms: 900,
    }),
    events.toolCall(ctx, seq++, "GITHUB_SEARCH", {
      input: { params: { q: { bad: "shape" } } },
      output: { successful: false, error: "ValidationError" },
      status: "error",
      error: "ValidationError: 'q' must be a string",
      latency_ms: 300,
    }),
    events.runEnd(ctx, seq++, "demo-agent", { status: "error", error: "tool failure" }),
  ];
  return { runId: ctx.run_id, trace };
}

const judgeOpts = () => ({
  gateway: { baseUrl: llmUrl, apiKey: "stub" },
  model: "stub-judge/model",
});

describe("rubrics", () => {
  it("builds messages that carry the trace and demand strict JSON", () => {
    const { trace } = brokenTrace();
    const msgs = rubricMessages("tool_correctness", trace);
    expect(msgs.system).toContain('"verdict"');
    expect(msgs.user).toContain("GITHUB_SEARCH");
    expect(msgs.user).toContain('"status": "error"');
  });
});

describe("judgeTrace (stub gateway)", () => {
  it("flags the bad tool call on tool_correctness and passes the rest", async () => {
    const { trace } = brokenTrace();
    const verdicts = await judgeTrace(trace, judgeOpts());
    expect(verdicts.length).toBe(RUBRICS.length);

    const toolV = verdicts.find((v) => v.rubric === "tool_correctness")!;
    expect(toolV.verdict).toBe("fail");
    expect(toolV.flagged_seq).toBe(2); // exactly the error-status tool_call
    expect(verdicts.filter((v) => v.verdict === "pass").length).toBe(2);
    // judge requested strict JSON mode
    expect(seenRequests.length).toBeGreaterThanOrEqual(3);
  });
});

describe("evalRun (real ClickHouse round-trip)", () => {
  it("writes verdicts to afr.evals and reads them back", async () => {
    const ch = createClient({
      url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
      username: process.env.CLICKHOUSE_USER ?? "default",
      password: process.env.CLICKHOUSE_PASSWORD ?? "",
      database: process.env.CLICKHOUSE_DATABASE ?? "afr",
    });
    const { runId, trace } = brokenTrace();
    // seed the trace so evalRun can load it (events table is the source)
    await ch.insert({
      table: "events",
      values: trace.map(toJSONEachRow),
      format: "JSONEachRow",
      clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
    });

    const verdicts = await evalRun(runId, { ...judgeOpts(), clickhouse: ch });
    expect(verdicts.length).toBe(3);

    const rs = await ch.query({
      query: "SELECT rubric, verdict, score, flagged_seq FROM evals WHERE run_id = {r: UUID} ORDER BY rubric",
      query_params: { r: runId },
      format: "JSONEachRow",
    });
    const rows = await rs.json<{ rubric: string; verdict: string; flagged_seq: number | null }>();
    expect(rows.length).toBe(3);
    const tool = rows.find((r) => r.rubric === "tool_correctness")!;
    expect(tool.verdict).toBe("fail");
    expect(tool.flagged_seq).toBe(2);
  });
});
