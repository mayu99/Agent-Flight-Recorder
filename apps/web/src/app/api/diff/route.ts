import { NextResponse } from "next/server";
import { diffRuns, loadRunEvents } from "@afr/replay-engine";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const runA = url.searchParams.get("a");
  const runB = url.searchParams.get("b");
  if (!runA || !runB) {
    return NextResponse.json({ error: "query params a and b (run ids) are required" }, { status: 400 });
  }
  const [a, b] = await Promise.all([loadRunEvents(runA), loadRunEvents(runB)]);
  if (a.length === 0 || b.length === 0) {
    return NextResponse.json({ error: "one or both runs not found" }, { status: 404 });
  }
  return NextResponse.json({ a: runA, b: runB, diff: diffRuns(a, b) });
}
