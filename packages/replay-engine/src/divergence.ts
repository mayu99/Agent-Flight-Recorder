/**
 * Divergence detection — the heart of deterministic replay.
 * A replayed agent must produce the same *inputs* the recording saw; the
 * canonical input hash is the comparison key. A mismatch IS the signal the
 * diff view visualizes: the exact step where behavior changed.
 */
import type { EventType, TraceEvent } from "@afr/recorder-sdk/events";

export type DivergenceReason =
  | "input_hash_mismatch" // same step position, different input — the classic divergence
  | "type_mismatch" // agent made a tool call where the recording has a model call (or vice versa)
  | "name_mismatch" // same type but different model/tool
  | "trace_exhausted"; // agent took more steps than the recording has

export interface LiveStep {
  type: EventType;
  name: string;
  input_hash: string;
}

export interface Divergence {
  /** seq of the recorded step the live step was compared against (or the last seq + 1 when exhausted). */
  seq: number;
  reason: DivergenceReason;
  expected: { type: EventType; name: string; input_hash: string } | null;
  actual: LiveStep;
}

export function detectDivergence(
  recorded: TraceEvent | undefined,
  live: LiveStep,
  lastSeq: number,
): Divergence | null {
  if (!recorded) {
    return { seq: lastSeq + 1, reason: "trace_exhausted", expected: null, actual: live };
  }
  const expected = {
    type: recorded.event_type,
    name: recorded.name,
    input_hash: recorded.input_hash,
  };
  if (recorded.event_type !== live.type) {
    return { seq: recorded.seq, reason: "type_mismatch", expected, actual: live };
  }
  if (recorded.name !== live.name) {
    return { seq: recorded.seq, reason: "name_mismatch", expected, actual: live };
  }
  if (recorded.input_hash !== live.input_hash) {
    return { seq: recorded.seq, reason: "input_hash_mismatch", expected, actual: live };
  }
  return null;
}
