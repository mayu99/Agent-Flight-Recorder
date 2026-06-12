import { describe, expect, it, vi } from "vitest";
import { events, type TraceEvent } from "./events.js";
import { Transport } from "./transport.js";

const ctx = { run_id: "00000000-0000-4000-8000-000000000000" };
const makeEvent = (seq: number): TraceEvent =>
  events.toolCall(ctx, seq, "test_tool", { input: { seq } });

const noSleep = () => Promise.resolve();

function fakeFetch(handler: (body: { events: TraceEvent[] }) => number) {
  const calls: TraceEvent[][] = [];
  const fn = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { events: TraceEvent[] };
    calls.push(body.events);
    const status = handler(body);
    return new Response(status < 400 ? "ok" : "err", { status });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("Transport", () => {
  it("batches enqueued events and flushes them all", async () => {
    const { fn, calls } = fakeFetch(() => 200);
    const t = new Transport({ url: "http://ingest", maxBatchSize: 3, fetchFn: fn, sleepFn: noSleep });
    for (let i = 0; i < 7; i++) t.enqueue(makeEvent(i));
    await t.close();
    expect(t.pending).toBe(0);
    const shipped = calls.flat().map((e) => e.seq).sort((a, b) => a - b);
    expect(shipped).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(calls.every((c) => c.length <= 3)).toBe(true);
  });

  it("flushes immediately when maxBatchSize is reached", async () => {
    const { fn, calls } = fakeFetch(() => 200);
    const t = new Transport({ url: "http://ingest", maxBatchSize: 2, fetchFn: fn, sleepFn: noSleep });
    t.enqueue(makeEvent(0));
    t.enqueue(makeEvent(1)); // hits batch size → flush without timer
    await t.flush();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]).toHaveLength(2);
    await t.close();
  });

  it("retries 5xx with backoff then succeeds, no events lost", async () => {
    let attempt = 0;
    const { fn, calls } = fakeFetch(() => (++attempt <= 2 ? 503 : 200));
    const dropped: TraceEvent[] = [];
    const t = new Transport({
      url: "http://ingest", fetchFn: fn, sleepFn: noSleep,
      onDrop: (e) => dropped.push(...e),
    });
    t.enqueue(makeEvent(0));
    await t.close();
    expect(dropped).toHaveLength(0);
    expect(calls.length).toBe(3); // 2 failures + 1 success, same batch each time
    expect(calls.every((c) => c[0]?.seq === 0)).toBe(true);
  });

  it("drops the batch with a reason after exhausting retries", async () => {
    const { fn } = fakeFetch(() => 503);
    const reasons: string[] = [];
    const t = new Transport({
      url: "http://ingest", fetchFn: fn, sleepFn: noSleep, maxRetries: 2,
      onDrop: (_e, reason) => reasons.push(reason),
    });
    t.enqueue(makeEvent(0));
    await t.close();
    expect(reasons).toEqual(["failed after 2 retries"]);
  });

  it("does not retry 4xx (our bug) — drops with the server reason", async () => {
    const { fn, calls } = fakeFetch(() => 400);
    const reasons: string[] = [];
    const t = new Transport({
      url: "http://ingest", fetchFn: fn, sleepFn: noSleep,
      onDrop: (_e, reason) => reasons.push(reason),
    });
    t.enqueue(makeEvent(0));
    await t.close();
    expect(calls).toHaveLength(1); // no retry
    expect(reasons[0]).toContain("ingest rejected batch: 400");
  });

  it("enqueue never throws after close; events are reported dropped", async () => {
    const { fn } = fakeFetch(() => 200);
    const reasons: string[] = [];
    const t = new Transport({
      url: "http://ingest", fetchFn: fn, sleepFn: noSleep,
      onDrop: (_e, r) => reasons.push(r),
    });
    await t.close();
    expect(() => t.enqueue(makeEvent(0))).not.toThrow();
    expect(reasons).toEqual(["transport closed"]);
  });

  it("sends the api key as a bearer token", async () => {
    let auth: string | null = null;
    const fn = (async (_url: unknown, init?: RequestInit) => {
      auth = new Headers(init?.headers).get("authorization");
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const t = new Transport({ url: "http://ingest", apiKey: "sekret", fetchFn: fn, sleepFn: noSleep });
    t.enqueue(makeEvent(0));
    await t.close();
    expect(auth).toBe("Bearer sekret");
  });
});
