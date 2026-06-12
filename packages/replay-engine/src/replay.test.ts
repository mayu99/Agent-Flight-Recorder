/**
 * THE BAR (CLAUDE.md): record a run, replay it, assert the replayed step
 * sequence is byte-identical. Recording flows through the REAL pipeline:
 * SDK builders + Transport → ingest HTTP service → ClickHouse → loader.
 *
 * Requires local services: `docker compose up -d clickhouse` and the ingest
 * service on :4000 (npm run dev:ingest). The toy agent is deterministic by
 * construction — replay determinism is what's under test, not the agent.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  events,
  type RunContext,
  type TraceEvent,
} from "@afr/recorder-sdk/events";
import { canonicalJson, hashInput } from "@afr/recorder-sdk/hashing";
import { Transport } from "@afr/recorder-sdk/transport";
import { loadRunEvents } from "./loader.js";
import { Replayer } from "./replayer.js";

const INGEST_URL = process.env.AFR_INGEST_URL ?? "http://localhost:4000";
const INGEST_KEY = process.env.AFR_INGEST_API_KEY ?? "dev-secret";

/** Deterministic stand-ins for model/tool backends (record mode only). */
const cannedModel = (input: { messages: { content: string }[] }): unknown => {
  const last = input.messages[input.messages.length - 1]!.content;
  return last.includes("result")
    ? { choices: [{ message: { content: "The answer is 4." } }], usage: { prompt_tokens: 30, completion_tokens: 6 } }
    : { choices: [{ message: { content: "calling calculator", tool_calls: [{ name: "calculator", args: { expr: "2+2" } }] } }], usage: { prompt_tokens: 18, completion_tokens: 11 } };
};
const cannedTool = (input: { expr: string }): unknown => ({ result: input.expr === "2+2" ? 4 : null });

interface AgentClient {
  model(input: { messages: { role: string; content: string }[] }): Promise<unknown>;
  tool(slug: string, input: { expr: string }): Promise<unknown>;
}

/** The toy agent script — identical in record and replay mode. */
async function runToyAgent(client: AgentClient, expr = "2+2"): Promise<string[]> {
  const transcript: string[] = [];
  const m1 = await client.model({ messages: [{ role: "user", content: `What is ${expr}? Use the calculator.` }] });
  transcript.push(canonicalJson(m1));
  const t1 = await client.tool("calculator", { expr });
  transcript.push(canonicalJson(t1));
  const m2 = await client.model({
    messages: [
      { role: "user", content: `What is ${expr}? Use the calculator.` },
      { role: "tool", content: `result: ${canonicalJson(t1)}` },
    ],
  });
  transcript.push(canonicalJson(m2));
  return transcript;
}

/** Record-mode client: deterministic backends + real event emission. */
function recordingClient(ctx: RunContext, transport: Transport): { client: AgentClient; seqRef: { seq: number } } {
  const seqRef = { seq: 1 }; // 0 = run_start
  return {
    seqRef,
    client: {
      async model(input) {
        const output = cannedModel(input);
        transport.enqueue(
          events.modelCall(ctx, seqRef.seq++, "toy/canned-model", {
            input, output, input_hash: hashInput(input), latency_ms: 7,
          }),
        );
        return output;
      },
      async tool(slug, input) {
        const output = cannedTool(input);
        transport.enqueue(
          events.toolCall(ctx, seqRef.seq++, slug, {
            input, output, input_hash: hashInput(input), latency_ms: 3,
          }),
        );
        return output;
      },
    },
  };
}

/** Replay-mode client: every output served from the recording. */
function replayClient(replayer: Replayer): AgentClient {
  return {
    async model(input) {
      const r = replayer.next({ type: "model_call", name: "toy/canned-model", input });
      if (r.kind !== "output") throw new Error(`unexpected divergence: ${JSON.stringify(r.divergence)}`);
      return r.output;
    },
    async tool(slug, input) {
      const r = replayer.next({ type: "tool_call", name: slug, input });
      if (r.kind !== "output") throw new Error(`unexpected divergence: ${JSON.stringify(r.divergence)}`);
      return r.output;
    },
  };
}

let runId: string;
let recordedTranscript: string[];
let recordedEvents: TraceEvent[];

beforeAll(async () => {
  // ---- RECORD through the real pipeline ----
  runId = crypto.randomUUID();
  const ctx: RunContext = { run_id: runId };
  const transport = new Transport({ url: INGEST_URL, apiKey: INGEST_KEY });
  transport.enqueue(events.runStart(ctx, 0, "toy-agent"));
  const { client, seqRef } = recordingClient(ctx, transport);
  recordedTranscript = await runToyAgent(client);
  transport.enqueue(events.runEnd(ctx, seqRef.seq, "toy-agent"));
  await transport.close();
  // wait_for_async_insert=1 → once ingest 200s (close awaited it), rows are durable
  recordedEvents = await loadRunEvents(runId);
}, 30_000);

describe("replay determinism (THE BAR)", () => {
  it("recorded the full run through SDK → ingest → ClickHouse", () => {
    expect(recordedEvents).toHaveLength(5); // run_start + model, tool, model + run_end
    expect(recordedEvents.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(recordedEvents.map((e) => e.event_type)).toEqual([
      "run_start", "model_call", "tool_call", "model_call", "run_end",
    ]);
  });

  it("replays the run with a byte-identical step sequence", async () => {
    const replayer = new Replayer(recordedEvents);
    const replayedSteps: Array<{ seq: number; type: string; name: string; hash: string; output: string }> = [];
    const spy: AgentClient = (() => {
      const inner = replayClient(replayer);
      return {
        async model(input) {
          const recorded = replayer.replayableSteps[replayedSteps.length]!;
          const out = await inner.model(input);
          replayedSteps.push({ seq: recorded.seq, type: recorded.event_type, name: recorded.name, hash: hashInput(input), output: canonicalJson(out) });
          return out;
        },
        async tool(slug, input) {
          const recorded = replayer.replayableSteps[replayedSteps.length]!;
          const out = await inner.tool(slug, input);
          replayedSteps.push({ seq: recorded.seq, type: recorded.event_type, name: recorded.name, hash: hashInput(input), output: canonicalJson(out) });
          return out;
        },
      };
    })();

    const replayedTranscript = await runToyAgent(spy);

    // transcript byte-identical (canonical form)
    expect(replayedTranscript).toEqual(recordedTranscript);
    // every replayed step aligns with the recording: seq, type, name, input hash, output bytes
    const recordedReplayable = recordedEvents.filter((e) => e.event_type === "model_call" || e.event_type === "tool_call");
    expect(replayedSteps.map((s) => [s.seq, s.type, s.name, s.hash, s.output])).toEqual(
      recordedReplayable.map((e) => [e.seq, e.event_type, e.name, e.input_hash, canonicalJson(e.output)]),
    );
    expect(replayer.remaining).toBe(0);
  });

  it("flags the exact step when the live input differs (input_hash_mismatch)", async () => {
    const replayer = new Replayer(recordedEvents);
    const inner = replayClient(replayer);
    // step 1 (model) matches the recording…
    await inner.model({ messages: [{ role: "user", content: "What is 2+2? Use the calculator." }] });
    // …step 2 (tool) is tampered: 2+3 instead of 2+2
    const r = replayer.next({ type: "tool_call", name: "calculator", input: { expr: "2+3" } });
    expect(r.kind).toBe("divergence");
    if (r.kind === "divergence") {
      expect(r.divergence.seq).toBe(2);
      expect(r.divergence.reason).toBe("input_hash_mismatch");
      expect(r.divergence.expected?.input_hash).toBe(hashInput({ expr: "2+2" }));
      expect(r.divergence.actual.input_hash).toBe(hashInput({ expr: "2+3" }));
    }
  });

  it("flags name and type mismatches and trace exhaustion", () => {
    const replayer = new Replayer(recordedEvents);
    const wrongType = replayer.next({ type: "tool_call", name: "calculator", input: {} });
    expect(wrongType.kind === "divergence" && wrongType.divergence.reason).toBe("type_mismatch");

    const replayer2 = new Replayer(recordedEvents);
    const wrongName = replayer2.next({ type: "model_call", name: "other-model", input: {} });
    expect(wrongName.kind === "divergence" && wrongName.divergence.reason).toBe("name_mismatch");

    const replayer3 = new Replayer([]);
    const exhausted = replayer3.next({ type: "model_call", name: "toy/canned-model", input: {} });
    expect(exhausted.kind === "divergence" && exhausted.divergence.reason).toBe("trace_exhausted");
  });

  it("whitespace-only input differences do NOT diverge (canonical hashing)", async () => {
    const replayer = new Replayer(recordedEvents);
    const r = replayer.next({
      type: "model_call",
      name: "toy/canned-model",
      input: { messages: [{ role: "user", content: "What  is 2+2?   Use the calculator." }] },
    });
    expect(r.kind).toBe("output");
  });
});
