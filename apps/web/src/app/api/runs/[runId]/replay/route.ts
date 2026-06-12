/**
 * Deterministic replay of a recorded run, server-side: every replayable step's
 * recorded input is fed back through the Replayer, which verifies hashes and
 * serves recorded outputs. Proves the trace is self-consistent and returns the
 * replayed sequence. (Fork-replay with live execution runs through the demo
 * CLI — it needs an agent to execute the live half.)
 */
import { NextResponse } from "next/server";
import { fromJSONColumn } from "@afr/recorder-sdk/events";
import { loadRunEvents, Replayer } from "@afr/replay-engine";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const events = await loadRunEvents(runId);
  if (events.length === 0) {
    return NextResponse.json({ error: `run ${runId} not found` }, { status: 404 });
  }

  const replayer = new Replayer(events);
  const steps: Array<{ seq: number; type: string; name: string; ok: boolean }> = [];
  for (const recorded of replayer.replayableSteps) {
    const result = replayer.next({
      type: recorded.event_type,
      name: recorded.name,
      input: fromJSONColumn(recorded.input),
    });
    if (result.kind === "divergence") {
      return NextResponse.json(
        { run_id: runId, replayed: steps, divergence: result.divergence },
        { status: 409 },
      );
    }
    steps.push({ seq: recorded.seq, type: recorded.event_type, name: recorded.name, ok: true });
  }
  return NextResponse.json({ run_id: runId, replayed: steps, divergence: null });
}
