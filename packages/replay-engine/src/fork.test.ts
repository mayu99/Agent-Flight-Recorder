/**
 * Fork-mode verify: record a BROKEN toy run through the real pipeline,
 * fork at the step before the failure with the bug fixed, run goes green,
 * and BOTH runs exist in ClickHouse as separate immutable traces.
 * Requires local ClickHouse + ingest (same as replay.test.ts).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { events, type RunContext, type TraceEvent } from "@afr/recorder-sdk/events";
import { hashInput } from "@afr/recorder-sdk/hashing";
import { Transport } from "@afr/recorder-sdk/transport";
import { ForkSession } from "./fork";
import { loadRunEvents } from "./loader";

const INGEST_URL = process.env.AFR_INGEST_URL ?? "http://localhost:4000";
const INGEST_KEY = process.env.AFR_INGEST_API_KEY ?? "dev-secret";

// Deterministic tool: "2+x" is the bug (malformed expression), "2+2" is the fix.
const calc = (input: { expr: string }) =>
  input.expr === "2+2"
    ? { output: { result: 4 }, status: "ok" as const }
    : { output: { result: null }, status: "error" as const, error: `bad expression: ${input.expr}` };

const MODEL_IN = { messages: [{ role: "user", content: "Compute the total. Use the calculator." }] };
const MODEL_OUT = { choices: [{ message: { content: "calling calculator", tool_calls: [{ name: "calculator" }] } }] };

let brokenRunId: string;
let brokenEvents: TraceEvent[];

beforeAll(async () => {
  // ---- record the BROKEN run (agent hallucinates expr "2+x") ----
  brokenRunId = crypto.randomUUID();
  const ctx: RunContext = { run_id: brokenRunId };
  const t = new Transport({ url: INGEST_URL, apiKey: INGEST_KEY });
  t.enqueue(events.runStart(ctx, 0, "toy-agent"));
  t.enqueue(events.modelCall(ctx, 1, "toy/canned-model", {
    input: MODEL_IN, input_hash: hashInput(MODEL_IN), output: MODEL_OUT, latency_ms: 5,
  }));
  const badInput = { expr: "2+x" };
  const bad = calc(badInput);
  t.enqueue(events.toolCall(ctx, 2, "calculator", {
    input: badInput, input_hash: hashInput(badInput), output: bad.output,
    status: bad.status, error: bad.error ?? "", latency_ms: 2,
  }));
  t.enqueue(events.runEnd(ctx, 3, "toy-agent", { status: "error", error: "tool failed" }));
  await t.close();
  brokenEvents = await loadRunEvents(brokenRunId);
}, 30_000);

describe("fork mode (fix-and-verify)", () => {
  it("recorded the broken run with an error tool_call", () => {
    expect(brokenEvents).toHaveLength(4);
    expect(brokenEvents[2]!.status).toBe("error");
  });

  it("forks at the failing step, runs the fix live, goes green; both traces in ClickHouse", async () => {
    const t = new Transport({ url: INGEST_URL, apiKey: INGEST_KEY });
    const fork = new ForkSession({
      source: brokenEvents,
      forkAtSeq: 2, // the failing tool call runs live; step 1 replays
      emit: (e) => t.enqueue(e),
    });

    fork.start("toy-agent");
    // step 1: replayed from recording (input must match)
    const m = await fork.step(
      { type: "model_call", name: "toy/canned-model", input: MODEL_IN },
      async () => { throw new Error("must not go live before forkAt"); },
    );
    expect(m).toEqual(MODEL_OUT);
    expect(fork.replaying).toBe(false);
    // step 2: THE FIX — corrected expression runs live
    const fixedInput = { expr: "2+2" };
    const out = await fork.step(
      { type: "tool_call", name: "calculator", input: fixedInput },
      async (req) => calc(req.input as { expr: string }),
    );
    expect(out).toEqual({ result: 4 });
    fork.end("toy-agent");
    await t.close();

    // both runs are separate immutable traces in ClickHouse
    const forked = await loadRunEvents(fork.runId);
    expect(forked).toHaveLength(4);
    expect(forked.every((e) => e.mode === "fork")).toBe(true);
    expect(forked.every((e) => e.parent_run_id === brokenRunId)).toBe(true);
    // replayed prefix preserved the source step's payload + hash
    expect(forked[1]!.input_hash).toBe(brokenEvents[1]!.input_hash);
    // the fixed step is green with the new input
    expect(forked[2]!.status).toBe("ok");
    expect(forked[2]!.input_hash).toBe(hashInput(fixedInput));
    expect(forked[2]!.input_hash).not.toBe(brokenEvents[2]!.input_hash);
    // source run untouched (immutable)
    const sourceAgain = await loadRunEvents(brokenRunId);
    expect(sourceAgain).toEqual(brokenEvents);
  });

  it("throws if the agent diverges BEFORE the fork point (forked at the wrong step)", async () => {
    const fork = new ForkSession({ source: brokenEvents, forkAtSeq: 2, emit: () => {} });
    fork.start("toy-agent");
    await expect(
      fork.step(
        { type: "model_call", name: "toy/canned-model", input: { messages: [{ role: "user", content: "different prompt" }] } },
        async () => ({ output: null }),
      ),
    ).rejects.toThrow(/diverged at seq 1/);
  });
});
