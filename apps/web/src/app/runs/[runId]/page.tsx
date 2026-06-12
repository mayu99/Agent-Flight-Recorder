import Link from "next/link";
import { loadRunEvents } from "@afr/replay-engine";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listEvals } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  run_start: "Run start",
  model_call: "Model call",
  tool_call: "Tool call",
  context_injection: "Context",
  agent_decision: "Decision",
  run_end: "Run end",
  error: "Error",
};

export default async function RunTimelinePage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const [events, evals] = await Promise.all([loadRunEvents(runId), listEvals(runId)]);
  const maxLatency = Math.max(1, ...events.map((e) => e.latency_ms));

  return (
    <main className="mx-auto max-w-4xl p-8">
      <div className="mb-6">
        <Link href="/" className="text-sm text-muted-foreground hover:underline">← runs</Link>
        <h1 className="mt-1 font-mono text-lg">{runId}</h1>
        <p className="text-sm text-muted-foreground">
          {events.length} steps · conventional timeline (generative timeline at milestone 11)
        </p>
        {evals.length > 0 && (
          <div className="mt-2 flex gap-2">
            {evals.map((ev) => (
              <Badge key={ev.eval_id} variant={ev.verdict === "pass" ? "outline" : "destructive"}>
                {ev.rubric}: {ev.verdict} ({ev.score.toFixed(2)})
              </Badge>
            ))}
          </div>
        )}
      </div>

      <ol className="space-y-3">
        {events.map((e) => (
          <li key={e.span_id}>
            <Card className={e.status === "error" ? "border-red-500" : undefined}>
              <CardHeader className="py-3">
                <CardTitle className="flex items-center gap-3 text-sm font-medium">
                  <span className="w-8 text-right font-mono text-xs text-muted-foreground">#{e.seq}</span>
                  <Badge variant={e.status === "error" ? "destructive" : "outline"}>
                    {TYPE_LABEL[e.event_type] ?? e.event_type}
                  </Badge>
                  <span className="font-mono text-xs">{e.name}</span>
                  <span className="ml-auto tabular-nums text-xs text-muted-foreground">
                    {e.latency_ms}ms
                  </span>
                </CardTitle>
                <div className="ml-11 mt-1 h-1 rounded bg-muted">
                  <div
                    className={`h-1 rounded ${e.status === "error" ? "bg-red-500" : "bg-blue-500"}`}
                    style={{ width: `${Math.max(2, (e.latency_ms / maxLatency) * 100)}%` }}
                  />
                </div>
              </CardHeader>
              {(e.event_type === "model_call" || e.event_type === "tool_call" || e.status === "error") && (
                <CardContent className="space-y-2 pb-4 text-xs">
                  {e.status === "error" && (
                    <p className="font-medium text-red-600">{e.error}</p>
                  )}
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">
                      input · hash {e.input_hash.slice(0, 12)}…
                    </summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2">
                      {JSON.stringify(e.input, null, 2)}
                    </pre>
                  </details>
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">output</summary>
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-muted p-2">
                      {JSON.stringify(e.output, null, 2)}
                    </pre>
                  </details>
                  {e.event_type === "model_call" && (
                    <p className="text-muted-foreground">
                      tokens {e.tokens_in}→{e.tokens_out}
                      {e.cost_usd > 0 && <> · ${e.cost_usd.toFixed(6)}</>}
                      {e.ttft_ms !== null && <> · ttft {e.ttft_ms}ms</>}
                    </p>
                  )}
                </CardContent>
              )}
            </Card>
          </li>
        ))}
      </ol>
    </main>
  );
}
