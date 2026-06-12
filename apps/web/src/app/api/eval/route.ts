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

// POST { run_id } — judge the run via the gateway and persist verdicts.
export async function POST(request: Request) {
  const { run_id } = (await request.json().catch(() => ({}))) as { run_id?: string };
  if (!run_id) {
    return NextResponse.json({ error: "body must be JSON with run_id" }, { status: 400 });
  }
  try {
    const { evalRun } = await import("@afr/auto-eval");
    const verdicts = await evalRun(run_id);
    return NextResponse.json({ run_id, verdicts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // GatewayConfigError carries the missing-key setup instructions verbatim
    const status = message.includes("not configured") || message.includes("not set") ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
