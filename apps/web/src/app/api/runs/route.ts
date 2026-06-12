import { NextResponse } from "next/server";
import { listRuns } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 50);
  const runs = await listRuns(Number.isFinite(limit) ? limit : 50);
  return NextResponse.json({ runs });
}
