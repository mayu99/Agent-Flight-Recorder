import { createLibrary } from "@openuidev/react-lang";
import {
  DivergenceMarker,
  LatencyBar,
  PayloadInspector,
  RunSummaryHeader,
  Stack,
  StepCard,
  Timeline,
} from "./primitives";

export const timelineLibrary = createLibrary({
  components: [Stack, RunSummaryHeader, Timeline, StepCard, LatencyBar, PayloadInspector, DivergenceMarker],
  componentGroups: [
    {
      name: "Structure",
      components: ["Stack", "RunSummaryHeader", "Timeline"],
      notes: ["Every response: root = Stack([header, timeline]) with exactly one RunSummaryHeader and one Timeline."],
    },
    {
      name: "Steps",
      components: ["StepCard", "LatencyBar", "PayloadInspector", "DivergenceMarker"],
    },
  ],
});

export function timelinePrompt(): string {
  return timelineLibrary.prompt({
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
  });
}
