"use client";

import { Renderer } from "@openuidev/react-lang";
import { timelineLibrary } from "./library";

export interface TimelineViewProps {
  /** OpenUI Lang source — streamed from /api/runs/[id]/timeline or static. */
  response: string | null;
  isStreaming?: boolean;
  /** Called when a PayloadInspector (or other component) triggers an action. */
  onInspect?: (runId: string, seq: number) => void;
}

/**
 * Client boundary for the generative timeline. Feed it OpenUI Lang text
 * (partial text re-renders progressively while streaming).
 */
export function TimelineView({ response, isStreaming = false, onInspect }: TimelineViewProps) {
  return (
    <div data-afr="timeline-view" className="text-zinc-200">
      <Renderer
        response={response}
        library={timelineLibrary}
        isStreaming={isStreaming}
        onAction={(event) => {
          const args = (event as { args?: Record<string, unknown> }).args ?? {};
          const runId = typeof args.runId === "string" ? args.runId : undefined;
          const seq = typeof args.seq === "number" ? args.seq : undefined;
          if (onInspect && runId !== undefined && seq !== undefined) onInspect(runId, seq);
        }}
      />
    </div>
  );
}
