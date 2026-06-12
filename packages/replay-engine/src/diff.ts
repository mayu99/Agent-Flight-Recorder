/**
 * Diff engine: align two runs step-by-step and classify each step.
 * Alignment is LCS over canonical input hashes (insert/delete tolerant), so
 * a fixed step in the middle doesn't cascade misalignment down the run.
 * Classification:
 *   identical       — same input hash, same output
 *   changed-output  — same input hash, different output (nondeterminism/provider drift)
 *   changed-input   — same position/type/name, different input (the classic "the fix")
 *   divergent-path  — step exists on one side only, or a different call entirely
 */
import type { EventType, TraceEvent } from "@afr/recorder-sdk/events";
import { canonicalJson } from "@afr/recorder-sdk/hashing";

export type StepDiffKind =
  | "identical"
  | "changed-input"
  | "changed-output"
  | "divergent-path";

export interface StepDiff {
  kind: StepDiffKind;
  /** Step from run A (null when B-only). */
  a: TraceEvent | null;
  /** Step from run B (null when A-only). */
  b: TraceEvent | null;
}

export interface RunDiff {
  steps: StepDiff[];
  /** Index into steps of the first non-identical step, or null if runs match. */
  firstDivergenceIndex: number | null;
}

const REPLAYABLE: ReadonlySet<EventType> = new Set(["model_call", "tool_call"]);

function replayable(events: TraceEvent[]): TraceEvent[] {
  return [...events].sort((x, y) => x.seq - y.seq).filter((e) => REPLAYABLE.has(e.event_type));
}

/** Classic LCS table over input_hash sequences → list of matched index pairs. */
function lcsPairs(a: TraceEvent[], b: TraceEvent[]): Array<[number, number]> {
  const n = a.length;
  const m = b.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i]![j] =
        a[i]!.input_hash === b[j]!.input_hash
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]!.input_hash === b[j]!.input_hash) {
      pairs.push([i, j]);
      i++; j++;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

function classifyGapPair(a: TraceEvent, b: TraceEvent): StepDiffKind {
  return a.event_type === b.event_type && a.name === b.name
    ? "changed-input"
    : "divergent-path";
}

export function diffRuns(aEvents: TraceEvent[], bEvents: TraceEvent[]): RunDiff {
  const a = replayable(aEvents);
  const b = replayable(bEvents);
  const pairs = lcsPairs(a, b);
  const steps: StepDiff[] = [];

  let ai = 0;
  let bi = 0;
  const emitGap = (aEnd: number, bEnd: number): void => {
    // pair positionally inside the gap; leftovers are one-sided
    while (ai < aEnd && bi < bEnd) {
      steps.push({ kind: classifyGapPair(a[ai]!, b[bi]!), a: a[ai]!, b: b[bi]! });
      ai++; bi++;
    }
    while (ai < aEnd) steps.push({ kind: "divergent-path", a: a[ai++]!, b: null });
    while (bi < bEnd) steps.push({ kind: "divergent-path", a: null, b: b[bi++]! });
  };

  for (const [pa, pb] of pairs) {
    emitGap(pa, pb);
    const stepA = a[pa]!;
    const stepB = b[pb]!;
    steps.push({
      kind: canonicalJson(stepA.output) === canonicalJson(stepB.output) ? "identical" : "changed-output",
      a: stepA,
      b: stepB,
    });
    ai = pa + 1;
    bi = pb + 1;
  }
  emitGap(a.length, b.length);

  const firstDivergenceIndex = steps.findIndex((s) => s.kind !== "identical");
  return {
    steps,
    firstDivergenceIndex: firstDivergenceIndex === -1 ? null : firstDivergenceIndex,
  };
}
