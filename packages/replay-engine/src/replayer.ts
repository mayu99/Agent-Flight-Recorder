/**
 * Deterministic replay: serve recorded outputs keyed by (run_id, seq).
 * Replay NEVER re-calls models or tools — outputs come from the trace; the
 * replayer verifies the agent reproduced the same inputs (canonical hash).
 */
import {
  fromJSONColumn,
  type EventType,
  type TraceEvent,
} from "@afr/recorder-sdk/events";
import { hashInput, type CanonicalizeOptions } from "@afr/recorder-sdk/hashing";
import { detectDivergence, type Divergence } from "./divergence";

/** Event types a replayed agent re-requests (everything else is bookkeeping). */
const REPLAYABLE: ReadonlySet<EventType> = new Set(["model_call", "tool_call"]);

export interface ReplayRequest {
  type: EventType;
  name: string;
  input: unknown;
}

export type ReplayResult =
  | { kind: "output"; event: TraceEvent; output: unknown }
  | { kind: "divergence"; divergence: Divergence };

export interface ReplayerOptions {
  /**
   * Must match the options recording used for hashInput, or every step
   * false-diverges. Defaults match the SDK defaults.
   */
  hashOptions?: CanonicalizeOptions;
  /** Throw on divergence instead of returning it. Default false. */
  throwOnDivergence?: boolean;
}

export class DivergenceError extends Error {
  constructor(public readonly divergence: Divergence) {
    super(
      `replay diverged at seq ${divergence.seq} (${divergence.reason}): ` +
        `expected ${divergence.expected?.type}/${divergence.expected?.name ?? "<none>"}, ` +
        `got ${divergence.actual.type}/${divergence.actual.name}`,
    );
    this.name = "DivergenceError";
  }
}

export class Replayer {
  private readonly steps: TraceEvent[];
  private cursor = 0;

  constructor(
    runEvents: TraceEvent[],
    private readonly opts: ReplayerOptions = {},
  ) {
    this.steps = [...runEvents]
      .sort((a, b) => a.seq - b.seq)
      .filter((e) => REPLAYABLE.has(e.event_type));
  }

  /** Recorded steps remaining to be served. */
  get remaining(): number {
    return this.steps.length - this.cursor;
  }

  /** The full ordered replayable step list (for fork/diff tooling). */
  get replayableSteps(): readonly TraceEvent[] {
    return this.steps;
  }

  /**
   * Serve the next recorded output. Verifies the live request matches the
   * recording (type, name, canonical input hash) before handing it out.
   */
  next(request: ReplayRequest): ReplayResult {
    const recorded = this.steps[this.cursor];
    const live = {
      type: request.type,
      name: request.name,
      input_hash: hashInput(request.input, this.opts.hashOptions),
    };
    const lastSeq = this.steps.length
      ? this.steps[this.steps.length - 1]!.seq
      : -1;
    const divergence = detectDivergence(recorded, live, lastSeq);
    if (divergence) {
      if (this.opts.throwOnDivergence) throw new DivergenceError(divergence);
      return { kind: "divergence", divergence };
    }
    this.cursor += 1;
    return {
      kind: "output",
      event: recorded!,
      output: fromJSONColumn(recorded!.output),
    };
  }
}
