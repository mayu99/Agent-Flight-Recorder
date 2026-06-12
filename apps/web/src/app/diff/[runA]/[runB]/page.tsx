import Link from "next/link";
import { diffRuns, loadRunEvents, type StepDiff } from "@afr/replay-engine";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

const KIND_STYLE: Record<StepDiff["kind"], { label: string; cls: string }> = {
  identical: { label: "identical", cls: "bg-muted text-muted-foreground" },
  "changed-input": { label: "changed input", cls: "bg-amber-500 text-white" },
  "changed-output": { label: "changed output", cls: "bg-blue-500 text-white" },
  "divergent-path": { label: "divergent path", cls: "bg-red-600 text-white" },
};

function Side({ step, side }: { step: StepDiff["a"]; side: "A" | "B" }) {
  if (!step) {
    return (
      <div className="flex-1 rounded border border-dashed p-3 text-center text-xs text-muted-foreground">
        no step in run {side}
      </div>
    );
  }
  return (
    <div className={`flex-1 rounded border p-3 ${step.status === "error" ? "border-red-500" : ""}`}>
      <p className="font-mono text-xs">
        #{step.seq} · {step.event_type} · {step.name}
        {step.status === "error" && <span className="ml-2 text-red-600">error</span>}
      </p>
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted-foreground">
          input · {step.input_hash.slice(0, 12)}…
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2">
          {JSON.stringify(step.input, null, 2)}
        </pre>
      </details>
      <details className="mt-1 text-xs">
        <summary className="cursor-pointer text-muted-foreground">output</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2">
          {JSON.stringify(step.output, null, 2)}
        </pre>
      </details>
      {step.status === "error" && <p className="mt-1 text-xs text-red-600">{step.error}</p>}
    </div>
  );
}

export default async function DiffPage({
  params,
}: {
  params: Promise<{ runA: string; runB: string }>;
}) {
  const { runA, runB } = await params;
  const [a, b] = await Promise.all([loadRunEvents(runA), loadRunEvents(runB)]);
  const diff = diffRuns(a, b);

  return (
    <main className="mx-auto max-w-6xl p-8">
      <Link href="/" className="text-sm text-muted-foreground hover:underline">← runs</Link>
      <h1 className="mt-1 text-lg font-semibold">Run diff</h1>
      <p className="font-mono text-xs text-muted-foreground">
        A <Link className="underline" href={`/runs/${runA}`}>{runA}</Link> · B{" "}
        <Link className="underline" href={`/runs/${runB}`}>{runB}</Link>
      </p>
      <p className="mb-6 mt-2 text-sm">
        {diff.firstDivergenceIndex === null ? (
          <Badge variant="outline">runs are identical</Badge>
        ) : (
          <Badge className="bg-amber-500 text-white">
            first divergence at step {diff.firstDivergenceIndex + 1} of {diff.steps.length}
          </Badge>
        )}
      </p>

      <ol className="space-y-3">
        {diff.steps.map((step, i) => {
          const style = KIND_STYLE[step.kind];
          const isFirstDivergence = i === diff.firstDivergenceIndex;
          return (
            <li key={i}>
              <Card className={isFirstDivergence ? "border-2 border-amber-500" : undefined}>
                <CardHeader className="py-3">
                  <CardTitle className="flex items-center gap-3 text-sm">
                    <span className="w-6 text-right font-mono text-xs text-muted-foreground">{i + 1}</span>
                    <Badge className={style.cls}>{style.label}</Badge>
                    {isFirstDivergence && (
                      <span className="text-xs font-medium text-amber-600">← first divergence</span>
                    )}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex gap-4 pb-4">
                  <Side step={step.a} side="A" />
                  <Side step={step.b} side="B" />
                </CardContent>
              </Card>
            </li>
          );
        })}
      </ol>
    </main>
  );
}
