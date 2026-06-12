import type { TraceEvent } from "@afr/recorder-sdk/events";

/** Rubric ids match the LowCardinality(String) values stored in afr.evals. */
export const RUBRICS = ["task_success", "tool_correctness", "efficiency"] as const;
export type RubricId = (typeof RUBRICS)[number];

const RUBRIC_QUESTIONS: Record<RubricId, string> = {
  task_success:
    "Did the agent accomplish the task it was given? Judge from run_start through run_end: " +
    "was the final state/output what the task required?",
  tool_correctness:
    "Were all tool calls well-formed and correct? Check every tool_call step: argument shapes, " +
    "values consistent with the preceding context, and whether any call failed. " +
    "If a tool call failed or carried malformed arguments, the rubric fails and flagged_seq " +
    "MUST be that step's seq.",
  efficiency:
    "Was the run efficient? Consider redundant steps, retries, excessive tokens or latency " +
    "relative to what the task needed. Minor inefficiency still passes; egregious waste fails.",
};

/** Compact a trace for the judge: full fidelity on the fields that matter, payloads truncated. */
export function compactTrace(eventsList: TraceEvent[], payloadCap = 600): unknown[] {
  return eventsList.map((e) => ({
    seq: e.seq,
    event_type: e.event_type,
    name: e.name,
    status: e.status,
    error: e.error || undefined,
    latency_ms: e.latency_ms,
    tokens_in: e.tokens_in || undefined,
    tokens_out: e.tokens_out || undefined,
    input_preview: e.input_text.slice(0, payloadCap),
    output_preview: e.output_text.slice(0, payloadCap),
  }));
}

export interface JudgeMessages {
  system: string;
  user: string;
}

/** Build the chat messages for one rubric over one run's trace. */
export function rubricMessages(rubric: RubricId, eventsList: TraceEvent[]): JudgeMessages {
  return {
    system:
      "You are a strict evaluator of recorded AI-agent runs (Agent Flight Recorder). " +
      "You are given the full step trace of one run as JSON. Judge ONLY from the trace — " +
      "do not assume facts not present in it. " +
      'Respond with ONLY a JSON object: {"verdict": "pass"|"fail", "score": <0..1>, ' +
      '"reasoning": "<concise, cites seq numbers>", "flagged_seq": <number|null>}. ' +
      "flagged_seq is the seq of the single step most responsible for a failure, or null when passing.",
    user:
      `Rubric: ${rubric}\n${RUBRIC_QUESTIONS[rubric]}\n\n` +
      `Trace (${eventsList.length} steps):\n${JSON.stringify(compactTrace(eventsList), null, 1)}`,
  };
}
