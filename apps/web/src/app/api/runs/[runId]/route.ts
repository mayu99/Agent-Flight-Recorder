import { NextResponse } from "next/server";
import { loadRunEvents } from "@afr/replay-engine";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  const events = await loadRunEvents(runId);
  if (events.length === 0) {
    return NextResponse.json({ error: `run ${runId} not found` }, { status: 404 });
  }
  return NextResponse.json({ run_id: runId, events });
}
