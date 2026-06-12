import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import { TraceEventBatchSchema, type TraceEvent } from "../events";
import { record } from "../recorder";
import { recordedFetch } from "./model";
import { composioModifiers } from "./tools";
import { GatewayConfigError, gatewayConfigFromEnv } from "../gateway";

/** Capture ingest: collects every event batch the SDK ships. */
let ingest: Server;
let ingestUrl: string;
const received: TraceEvent[] = [];

/** Local OpenAI-compatible /chat/completions stub (the gateway's API shape). */
let gateway: Server;
let gatewayUrl: string;

beforeAll(async () => {
  ingest = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as { events: unknown };
        received.push(...TraceEventBatchSchema.parse(parsed.events));
        res.writeHead(200).end("{}");
      } catch (err) {
        res.writeHead(400).end(String(err));
      }
    });
  });
  gateway = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body) as { stream?: boolean; model?: string };
      if (parsed.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
        res.write('data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "4" } }],
            usage: { prompt_tokens: 12, completion_tokens: 1 },
          }),
        );
      }
    });
  });
  await new Promise<void>((r) => ingest.listen(0, () => r()));
  await new Promise<void>((r) => gateway.listen(0, () => r()));
  ingestUrl = `http://127.0.0.1:${(ingest.address() as AddressInfo).port}`;
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
});

afterAll(async () => {
  ingest.closeAllConnections();
  gateway.closeAllConnections();
  await new Promise((r) => ingest.close(r));
  await new Promise((r) => gateway.close(r));
});

describe("gateway config", () => {
  it("errors helpfully when unset, parses when set", () => {
    expect(() => gatewayConfigFromEnv({})).toThrow(GatewayConfigError);
    const cfg = gatewayConfigFromEnv({
      TRUEFOUNDRY_GATEWAY_URL: "https://gateway.truefoundry.ai/",
      TRUEFOUNDRY_API_KEY: "tfy-test",
    });
    expect(cfg.baseUrl).toBe("https://gateway.truefoundry.ai"); // trailing slash stripped
  });
});

describe("record() + interceptors (toy agent, OpenAI-compatible stub)", () => {
  it("emits run_start, context, model_call (sync + stream), tool_call, run_end with ordered seq", async () => {
    received.length = 0;
    const rec = record({
      agentName: "toy-agent",
      ingestUrl,
      apiKey: "test",
      transport: { flushIntervalMs: 50 },
    });
    const gfetch = recordedFetch(rec);

    rec.context("system_prompt", { text: "You are a calculator." });

    // 1) non-streaming model call through the gateway choke point
    const res = await gfetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tfy-test" },
      body: JSON.stringify({
        model: "openai-main/gpt-4o",
        messages: [{ role: "user", content: "2+2?" }],
      }),
    });
    expect(res.ok).toBe(true);
    const json = (await res.json()) as { choices: Array<{ message: { content: string } }> };
    expect(json.choices[0]!.message.content).toBe("4"); // passthrough untouched

    // 2) streaming model call — caller still gets the full SSE stream
    const sres = await gfetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai-main/gpt-4o", stream: true, messages: [] }),
    });
    const streamed = await sres.text();
    expect(streamed).toContain("Hello");
    expect(streamed).toContain("[DONE]");

    // 3) tool call through Composio-shaped modifiers
    const mods = composioModifiers(rec);
    const params = { owner: "ComposioHQ", repo: "composio" };
    const fwd = mods.beforeExecute({ toolSlug: "GITHUB_LIST_STARGAZERS", toolkitSlug: "github", params });
    expect(fwd).toBe(params); // passthrough
    mods.afterExecute({
      toolSlug: "GITHUB_LIST_STARGAZERS",
      toolkitSlug: "github",
      result: { successful: true, data: { stars: 12000 } },
    });

    // 4) failing tool call records error status
    mods.beforeExecute({ toolSlug: "GITHUB_SEARCH", toolkitSlug: "github", params: { q: { bad: "shape" } } });
    mods.afterExecute({
      toolSlug: "GITHUB_SEARCH",
      toolkitSlug: "github",
      result: { successful: false, error: "ValidationError: 'q' must be a string" },
    });

    await rec.end();
    await new Promise((r) => setTimeout(r, 150)); // let the streamed model_call event land

    const mine = received.filter((e) => e.run_id === rec.runId);
    const byType = (t: string) => mine.filter((e) => e.event_type === t);

    expect(byType("run_start").length).toBe(1);
    expect(byType("context_injection").length).toBe(1);
    expect(byType("model_call").length).toBe(2);
    expect(byType("tool_call").length).toBe(2);
    expect(byType("run_end").length).toBe(1);

    // seq ordering: unique, gapless from 0 in emission order
    const seqs = mine.map((e) => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual([...Array(mine.length).keys()]);
    expect(mine.find((e) => e.event_type === "run_start")!.seq).toBe(0);

    // model_call payloads: full request recorded, usage extracted
    const sync = byType("model_call").find((e) => !(e.output as { streamed?: boolean }).streamed)!;
    expect((sync.input as { model: string }).model).toBe("openai-main/gpt-4o");
    expect(sync.tokens_in).toBe(12);
    expect(sync.tokens_out).toBe(1);
    expect(sync.input_hash).toHaveLength(64);

    const stream = byType("model_call").find((e) => (e.output as { streamed?: boolean }).streamed)!;
    expect((stream.output as { text: string }).text).toBe("Hello world");
    expect(stream.tokens_out).toBe(2);
    expect(stream.ttft_ms).not.toBeNull();

    // failing tool call carries error status + message
    const failed = byType("tool_call").find((e) => e.status === "error")!;
    expect(failed.name).toBe("GITHUB_SEARCH");
    expect(failed.error).toContain("ValidationError");
  });

  it("ignores non-model traffic", async () => {
    received.length = 0;
    const rec = record({ agentName: "t", ingestUrl, apiKey: "k", transport: { flushIntervalMs: 50 } });
    const gfetch = recordedFetch(rec);
    const res = await gfetch(`${ingestUrl}/healthz-ish`, { method: "GET" }).catch(() => null);
    void res;
    await rec.end();
    const mine = received.filter((e) => e.run_id === rec.runId);
    expect(mine.map((e) => e.event_type)).toEqual(["run_start", "run_end"]);
  });
});
