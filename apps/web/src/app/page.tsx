import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { listRuns } from "@/lib/clickhouse";

export const dynamic = "force-dynamic";

function StatusBadge({ hasError }: { hasError: 0 | 1 }) {
  return hasError ? (
    <Badge variant="destructive">failed</Badge>
  ) : (
    <Badge className="bg-green-600 text-white hover:bg-green-600">green</Badge>
  );
}

function ModeBadge({ mode }: { mode: string }) {
  const variant = mode === "fork" ? "secondary" : "outline";
  return <Badge variant={variant}>{mode}</Badge>;
}

export default async function RunListPage() {
  const runs = await listRuns();
  return (
    <main className="mx-auto max-w-6xl p-8">
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Agent Flight Recorder</h1>
          <p className="text-sm text-muted-foreground">
            {runs.length} recorded runs — newest first
          </p>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Mode</TableHead>
            <TableHead>Eval</TableHead>
            <TableHead className="text-right">Steps</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Cost</TableHead>
            <TableHead>Started</TableHead>
            <TableHead>Lineage</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {runs.map((run) => (
            <TableRow key={run.run_id}>
              <TableCell className="font-mono text-xs">
                <Link className="underline-offset-2 hover:underline" href={`/runs/${run.run_id}`}>
                  {run.run_id.slice(0, 8)}…
                </Link>
              </TableCell>
              <TableCell><StatusBadge hasError={run.has_error} /></TableCell>
              <TableCell><ModeBadge mode={run.mode} /></TableCell>
              <TableCell>
                {run.verdict ? (
                  <Badge variant={run.verdict === "pass" ? "outline" : "destructive"}>
                    {run.verdict}
                  </Badge>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{run.steps}</TableCell>
              <TableCell className="text-right tabular-nums">{run.tokens}</TableCell>
              <TableCell className="text-right tabular-nums">
                {run.cost > 0 ? `$${run.cost.toFixed(5)}` : "—"}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{run.started_at}</TableCell>
              <TableCell className="font-mono text-xs">
                {run.parent_run_id ? (
                  <Link className="text-muted-foreground underline-offset-2 hover:underline" href={`/diff/${run.parent_run_id}/${run.run_id}`}>
                    diff vs {run.parent_run_id.slice(0, 8)}…
                  </Link>
                ) : ("—")}
              </TableCell>
            </TableRow>
          ))}
          {runs.length === 0 && (
            <TableRow>
              <TableCell colSpan={9} className="py-10 text-center text-muted-foreground">
                No runs recorded yet — run <code>npm run demo</code>.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </main>
  );
}
