import { describe, expect, it } from "vitest";
import { events, type RunContext, type TraceEvent } from "@afr/recorder-sdk/events";
import { hashInput } from "@afr/recorder-sdk/hashing";
import { diffRuns } from "./diff.js";

const ctxA: RunContext = { run_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
const ctxB: RunContext = { run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

const MODEL_IN = { messages: [{ role: "user", content: "compute" }] };
const MODEL_OUT = { choices: [{ message: { content: "use calc" } }] };

function modelStep(ctx: RunContext, seq: number, output: unknown = MODEL_OUT): TraceEvent {
  return events.modelCall(ctx, seq, "toy/model", { input: MODEL_IN, input_hash: hashInput(MODEL_IN), output });
}
function toolStep(ctx: RunContext, seq: number, expr: string, output: unknown, status: "ok" | "error" = "ok"): TraceEvent {
  return events.toolCall(ctx, seq, "calculator", { input: { expr }, input_hash: hashInput({ expr }), output, status });
}

describe("diff engine", () => {
  it("broken vs fixed run: divergence at exactly the fixed step", () => {
    const broken = [
      events.runStart(ctxA, 0, "agent"),
      modelStep(ctxA, 1),
      toolStep(ctxA, 2, "2+x", { result: null }, "error"),
      events.runEnd(ctxA, 3, "agent"),
    ];
    const fixed = [
      events.runStart(ctxB, 0, "agent"),
      modelStep(ctxB, 1),
      toolStep(ctxB, 2, "2+2", { result: 4 }),
      events.runEnd(ctxB, 3, "agent"),
    ];
    const diff = diffRuns(broken, fixed);
    expect(diff.steps.map((s) => s.kind)).toEqual(["identical", "changed-input"]);
    expect(diff.firstDivergenceIndex).toBe(1);
    const d = diff.steps[1]!;
    expect(d.a?.seq).toBe(2); // exactly the fixed step
    expect(d.b?.seq).toBe(2);
    expect(d.a?.status).toBe("error");
    expect(d.b?.status).toBe("ok");
  });

  it("identical runs produce no divergence", () => {
    const mk = (ctx: RunContext) => [modelStep(ctx, 1), toolStep(ctx, 2, "2+2", { result: 4 })];
    const diff = diffRuns(mk(ctxA), mk(ctxB));
    expect(diff.steps.every((s) => s.kind === "identical")).toBe(true);
    expect(diff.firstDivergenceIndex).toBeNull();
  });

  it("same input but different output → changed-output", () => {
    const diff = diffRuns(
      [modelStep(ctxA, 1, { choices: [{ message: { content: "answer A" } }] })],
      [modelStep(ctxB, 1, { choices: [{ message: { content: "answer B" } }] })],
    );
    expect(diff.steps.map((s) => s.kind)).toEqual(["changed-output"]);
  });

  it("a different tool at the same position → divergent-path", () => {
    const a = [modelStep(ctxA, 1), toolStep(ctxA, 2, "2+2", { result: 4 })];
    const b = [
      modelStep(ctxB, 1),
      events.toolCall(ctxB, 2, "web_search", { input: { q: "2+2" }, input_hash: hashInput({ q: "2+2" }), output: { hits: [] } }),
    ];
    const diff = diffRuns(a, b);
    expect(diff.steps.map((s) => s.kind)).toEqual(["identical", "divergent-path"]);
  });

  it("LCS keeps alignment across an inserted step (no cascade)", () => {
    const a = [modelStep(ctxA, 1), toolStep(ctxA, 2, "2+2", { result: 4 })];
    const b = [
      modelStep(ctxB, 1),
      events.toolCall(ctxB, 2, "web_search", { input: { q: "context" }, input_hash: hashInput({ q: "context" }), output: { hits: [1] } }),
      toolStep(ctxB, 3, "2+2", { result: 4 }),
    ];
    const diff = diffRuns(a, b);
    expect(diff.steps.map((s) => s.kind)).toEqual(["identical", "divergent-path", "identical"]);
    expect(diff.steps[1]!.a).toBeNull(); // the inserted step is B-only
    expect(diff.steps[1]!.b?.name).toBe("web_search");
  });

  it("extra trailing steps are one-sided divergent-path entries", () => {
    const a = [modelStep(ctxA, 1)];
    const b = [modelStep(ctxB, 1), toolStep(ctxB, 2, "2+2", { result: 4 })];
    const diff = diffRuns(a, b);
    expect(diff.steps.map((s) => s.kind)).toEqual(["identical", "divergent-path"]);
    expect(diff.steps[1]!.a).toBeNull();
  });

  it("ignores bookkeeping events (run_start/run_end/context)", () => {
    const a = [events.runStart(ctxA, 0, "agent"), modelStep(ctxA, 1), events.runEnd(ctxA, 2, "agent")];
    const b = [modelStep(ctxB, 5)]; // different seq numbering, no bookkeeping
    const diff = diffRuns(a, b);
    expect(diff.steps.map((s) => s.kind)).toEqual(["identical"]);
  });
});
