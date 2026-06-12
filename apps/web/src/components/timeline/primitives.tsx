import { defineComponent } from "@openuidev/react-lang";
import { z } from "zod";

const STATUS_STYLES: Record<string, string> = {
  ok: "border-emerald-700/60 bg-emerald-950/40",
  error: "border-red-600 bg-red-950/50",
  timeout: "border-amber-600 bg-amber-950/40",
};

const STATUS_DOT: Record<string, string> = {
  ok: "bg-emerald-400",
  error: "bg-red-400",
  timeout: "bg-amber-400",
};

const EVENT_LABELS: Record<string, string> = {
  run_start: "Run start",
  model_call: "Model call",
  tool_call: "Tool call",
  context_injection: "Context",
  agent_decision: "Decision",
  run_end: "Run end",
  error: "Error",
};

export const Stack = defineComponent({
  name: "Stack",
  description: "Vertical layout container. Use as the root: Stack([RunSummaryHeader, Timeline]).",
  props: z.object({
    children: z.array(z.unknown()).describe("Components rendered top to bottom"),
  }),
  component: ({ props, renderNode }) => (
    <div data-afr="stack" className="flex flex-col gap-2">
      {(props.children as unknown[]).map((child, i) => (
        <div key={i}>{renderNode(child)}</div>
      ))}
    </div>
  ),
});

export const RunSummaryHeader = defineComponent({
  name: "RunSummaryHeader",
  description:
    "Header summarizing one agent run: id, status, mode, step count, duration, cost and tokens. Use exactly once, first.",
  props: z.object({
    runId: z.string().describe("Full run UUID"),
    status: z.enum(["ok", "error", "timeout"]).describe("Overall run status"),
    mode: z.enum(["record", "replay", "fork"]).describe("How the run was produced"),
    steps: z.number().describe("Total recorded steps"),
    durationMs: z.number().describe("Wall-clock duration in milliseconds"),
    costUsd: z.number().describe("Total cost in USD"),
    tokens: z.number().describe("Total tokens in + out"),
  }),
  component: ({ props }) => (
    <header
      data-afr="run-summary"
      className={`mb-4 rounded-lg border p-4 ${STATUS_STYLES[props.status] ?? STATUS_STYLES.ok}`}
    >
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[props.status] ?? STATUS_DOT.ok}`} />
        <span className="font-mono text-xs text-zinc-400">{props.runId}</span>
        <span className="ml-auto rounded bg-zinc-800 px-2 py-0.5 text-xs uppercase tracking-wide text-zinc-300">
          {props.mode}
        </span>
      </div>
      <div className="mt-2 flex gap-6 text-sm text-zinc-300">
        <span>{props.steps} steps</span>
        <span>{(props.durationMs / 1000).toFixed(2)}s</span>
        <span>${props.costUsd.toFixed(4)}</span>
        <span>{props.tokens.toLocaleString()} tokens</span>
      </div>
    </header>
  ),
});

export const Timeline = defineComponent({
  name: "Timeline",
  description:
    "Vertical container for the run timeline. Children must be StepCard or DivergenceMarker components in chronological (seq) order.",
  props: z.object({
    children: z
      .array(z.unknown())
      .describe("StepCard / DivergenceMarker components, ordered by seq ascending"),
  }),
  component: ({ props, renderNode }) => (
    <ol data-afr="timeline" className="relative ml-3 space-y-3 border-l border-zinc-800 pl-5">
      {(props.children as unknown[]).map((child, i) => (
        <li key={i}>{renderNode(child)}</li>
      ))}
    </ol>
  ),
});

export const StepCard = defineComponent({
  name: "StepCard",
  description:
    "One trace step (model call, tool call, context injection or decision). Failed steps (status error/timeout) must always include errorMessage and a PayloadInspector child.",
  props: z.object({
    seq: z.number().describe("Step index within the run"),
    title: z.string().describe("Model id or tool slug, e.g. GITHUB_SEARCH or openai-main/gpt-4o"),
    eventType: z
      .enum(["run_start", "model_call", "tool_call", "context_injection", "agent_decision", "run_end", "error"])
      .describe("Kind of trace event"),
    status: z.enum(["ok", "error", "timeout"]),
    durationMs: z.number().describe("Step latency in milliseconds"),
    summary: z.string().describe("One-line human summary of what happened in this step"),
    errorMessage: z.string().optional().describe("Error text — required when status is not ok"),
    children: z
      .array(z.unknown())
      .optional()
      .describe("Optional LatencyBar / PayloadInspector components for this step"),
  }),
  component: ({ props, renderNode }) => (
    <article
      data-afr="step-card"
      data-seq={props.seq}
      data-status={props.status}
      className={`rounded-md border p-3 ${STATUS_STYLES[props.status] ?? STATUS_STYLES.ok}`}
    >
      <div className="flex items-center gap-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${STATUS_DOT[props.status] ?? STATUS_DOT.ok}`} />
        <span className="font-mono text-xs text-zinc-500">#{props.seq}</span>
        <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
          {EVENT_LABELS[props.eventType] ?? props.eventType}
        </span>
        <span className="font-medium text-zinc-100">{props.title}</span>
        <span className="ml-auto font-mono text-xs text-zinc-500">{props.durationMs}ms</span>
      </div>
      <p className="mt-1.5 text-sm text-zinc-400">{props.summary}</p>
      {props.errorMessage ? (
        <p data-afr="step-error" className="mt-1.5 rounded bg-red-950 px-2 py-1 font-mono text-xs text-red-300">
          {props.errorMessage}
        </p>
      ) : null}
      {props.children ? (
        <div className="mt-2 space-y-2">{(props.children as unknown[]).map((c, i) => <div key={i}>{renderNode(c)}</div>)}</div>
      ) : null}
    </article>
  ),
});

export const LatencyBar = defineComponent({
  name: "LatencyBar",
  description:
    "Horizontal bar visualizing one step's latency relative to the slowest step in the run. Use inside StepCard for steps slower than 500ms.",
  props: z.object({
    durationMs: z.number().describe("This step's latency"),
    maxMs: z.number().describe("The slowest step latency in the run (scales the bar)"),
  }),
  component: ({ props }) => {
    const pct = Math.max(2, Math.min(100, Math.round((props.durationMs / Math.max(props.maxMs, 1)) * 100)));
    return (
      <div data-afr="latency-bar" className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded bg-zinc-800">
          <div
            className={`h-full rounded ${pct > 66 ? "bg-red-500" : pct > 33 ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="font-mono text-[10px] text-zinc-500">{props.durationMs}ms</span>
      </div>
    );
  },
});

export const PayloadInspector = defineComponent({
  name: "PayloadInspector",
  description:
    "Collapsible inspector showing a step's recorded input or output payload preview. The full payload is fetched from the trace store via the inspect_payload action — never invent payload content.",
  props: z.object({
    label: z.string().describe('"input" or "output" plus context, e.g. "input — tool args"'),
    preview: z.string().describe("Short verbatim excerpt of the recorded payload (from the trace data provided)"),
    runId: z.string().describe("Run UUID this payload belongs to"),
    seq: z.number().describe("Step seq this payload belongs to"),
    expanded: z.boolean().optional().describe("Render expanded — use true for failed steps"),
  }),
  component: ({ props }) => (
    <details data-afr="payload-inspector" data-run={props.runId} data-seq={props.seq} open={props.expanded ?? false}>
      <summary className="cursor-pointer text-xs text-zinc-400 hover:text-zinc-200">{props.label}</summary>
      <pre className="mt-1 max-h-48 overflow-auto rounded bg-zinc-900 p-2 font-mono text-[11px] leading-relaxed text-zinc-300">
        {props.preview}
      </pre>
    </details>
  ),
});

export const DivergenceMarker = defineComponent({
  name: "DivergenceMarker",
  description:
    "Marker between steps where a replay/fork diverged from its source run. Place at the exact seq where input hashes stopped matching.",
  props: z.object({
    seq: z.number().describe("Step seq where divergence was detected"),
    kind: z
      .enum(["input_hash_mismatch", "type_mismatch", "name_mismatch", "trace_exhausted"])
      .describe("Divergence classification from the replay engine"),
    detail: z.string().describe("One-line explanation of what changed"),
  }),
  component: ({ props }) => (
    <div
      data-afr="divergence"
      data-seq={props.seq}
      className="rounded-md border border-dashed border-fuchsia-500 bg-fuchsia-950/40 p-2 text-sm"
    >
      <span className="font-semibold text-fuchsia-300">⑂ divergence @ #{props.seq}</span>
      <span className="ml-2 rounded bg-fuchsia-900 px-1.5 py-0.5 font-mono text-[10px] text-fuchsia-200">
        {props.kind}
      </span>
      <p className="mt-1 text-zinc-300">{props.detail}</p>
    </div>
  ),
});
