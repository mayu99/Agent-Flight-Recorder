/**
 * Timeline component contract — names, descriptions, prop schemas.
 * Framework-free: imported by BOTH the React renderers (primitives.tsx)
 * and the server-side prompt builder (timeline-prompt.ts). No React here.
 */
import { z } from "zod";

export const stackSpec = {
  name: "Stack",
  description: "Vertical layout container. Use as the root: Stack([RunSummaryHeader, Timeline]).",
  props: z.object({
    children: z.array(z.unknown()).describe("Components rendered top to bottom"),
  }),
};

export const runSummaryHeaderSpec = {
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
};

export const timelineSpec = {
  name: "Timeline",
  description:
    "Vertical container for the run timeline. Children must be StepCard or DivergenceMarker components in chronological (seq) order.",
  props: z.object({
    children: z
      .array(z.unknown())
      .describe("StepCard / DivergenceMarker components, ordered by seq ascending"),
  }),
};

export const stepCardSpec = {
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
};

export const latencyBarSpec = {
  name: "LatencyBar",
  description:
    "Horizontal bar visualizing one step's latency relative to the slowest step in the run. Use inside StepCard for steps slower than 500ms.",
  props: z.object({
    durationMs: z.number().describe("This step's latency"),
    maxMs: z.number().describe("The slowest step latency in the run (scales the bar)"),
  }),
};

export const payloadInspectorSpec = {
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
};

export const divergenceMarkerSpec = {
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
};

export interface TimelineComponentSpec {
  name: string;
  description: string;
  props: z.ZodObject<z.ZodRawShape>;
}

export const TIMELINE_SPECS: TimelineComponentSpec[] = [
  stackSpec,
  runSummaryHeaderSpec,
  timelineSpec,
  stepCardSpec,
  latencyBarSpec,
  payloadInspectorSpec,
  divergenceMarkerSpec,
];

export const TIMELINE_COMPONENT_GROUPS = [
  {
    name: "Structure",
    components: ["Stack", "RunSummaryHeader", "Timeline"],
    notes: ["Every response: root = Stack([header, timeline]) with exactly one RunSummaryHeader and one Timeline."],
  },
  {
    name: "Steps",
    components: ["StepCard", "LatencyBar", "PayloadInspector", "DivergenceMarker"],
  },
];

export const TIMELINE_PROMPT_OPTIONS = {
  preamble:
    "You render replay timelines for recorded AI-agent runs (Agent Flight Recorder). " +
    "You are given the run's trace as JSON: an ordered list of step events with seq, event_type, name, " +
    "status, latency_ms, payload previews and optional divergence records. " +
    "Compose a timeline that makes failures instantly findable. Use ONLY data from the trace — " +
    "never invent step contents, payloads, or error messages.",
  additionalRules: [
    "Order StepCards strictly by seq ascending; never omit a step.",
    "Every step with status error or timeout: set errorMessage and include an expanded PayloadInspector child with the recorded input preview.",
    "Include a LatencyBar child for any step slower than 500ms; maxMs is the slowest step in the trace.",
    "Render DivergenceMarker exactly where the trace's divergence records indicate, between the surrounding steps.",
    "PayloadInspector previews must quote the trace data verbatim (truncate with … past 200 chars).",
    "Keep summaries one sentence, concrete, and derived from the payload preview.",
  ],
};
