import { createLibrary } from "@openuidev/react-lang";
import { TIMELINE_COMPONENT_GROUPS } from "./spec";
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
  componentGroups: TIMELINE_COMPONENT_GROUPS,
});

// Client-side consumers can reuse the server-safe prompt builder.
export { timelinePrompt } from "./timeline-prompt";
