import { NextResponse } from "next/server";
import { listEvals } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const runId = new URL(request.url).searchParams.get("run");
  if (!runId) {
    return NextResponse.json({ error: "query param run (run id) is required" }, { status: 400 });
  }
  return NextResponse.json({ run_id: runId, evals: await listEvals(runId) });
}

// POST (trigger an eval) lands with milestone 12 — needs EVAL_MODEL via the gateway.
export async function POST() {
  return NextResponse.json(
    { error: "eval triggering lands with auto-eval (milestone 12); set EVAL_MODEL in .env" },
    { status: 501 },
  );
}
