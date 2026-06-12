/**
 * Fork mode: replay a recorded run up to step N, then go live — the
 * fix-and-verify flow. The fork is a NEW run (new run_id, mode='fork',
 * parent_run_id linking lineage); replayed prefix steps are re-emitted as
 * events of the new run, live steps are recorded as they execute. Source
 * traces are never mutated.
 */
import {
  events,
  newId,
  type RunContext,
  type Status,
  type TraceEvent,
} from "@afr/recorder-sdk/events";
import { hashInput } from "@afr/recorder-sdk/hashing";
import { Replayer, type ReplayerOptions, type ReplayRequest } from "./replayer";

export interface LiveResult {
  output: unknown;
  status?: Status;
  error?: string;
  latency_ms?: number;
  ttft_ms?: number | null;
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
}

export type LiveExecutor = (request: ReplayRequest) => Promise<LiveResult>;

export interface ForkSessionOptions extends ReplayerOptions {
  /** Recorded events of the source run (all event types). */
  source: TraceEvent[];
  /** First seq executed LIVE; everything before is served from the recording. */
  forkAtSeq: number;
  /** Where new-run events go (Transport.enqueue or any sink). */
  emit: (e: TraceEvent) => void;
  runId?: string;
}

export class ForkSession {
  readonly runId: string;
  private readonly ctx: RunContext;
  private readonly replayer: Replayer;
  private readonly emit: (e: TraceEvent) => void;
  private seq = 0;

  constructor(private readonly opts: ForkSessionOptions) {
    const sourceRunId = opts.source[0]?.run_id;
    if (!sourceRunId) throw new Error("fork: source run has no events");
    this.runId = opts.runId ?? newId();
    this.ctx = { run_id: this.runId, mode: "fork", parent_run_id: sourceRunId };
    this.emit = opts.emit;
    const prefix = opts.source.filter((e) => e.seq < opts.forkAtSeq);
    this.replayer = new Replayer(prefix, {
      hashOptions: opts.hashOptions,
      // The prefix must match by construction — a fix that changes inputs
      // BEFORE the fork point means the user forked at the wrong step.
      throwOnDivergence: true,
    });
  }

  /** Steps still served from the recording. */
  get replaying(): boolean {
    return this.replayer.remaining > 0;
  }

  start(agentName: string): void {
    this.emit(events.runStart(this.ctx, this.seq++, agentName));
  }

  /**
   * One agent step. Identical call shape in both phases: while recorded
   * prefix remains it is replayed (and re-emitted under the new run); after
   * that the live executor runs and is recorded.
   */
  async step(request: ReplayRequest, live: LiveExecutor): Promise<unknown> {
    if (this.replaying) {
      const r = this.replayer.next(request); // throws DivergenceError on mismatch
      if (r.kind !== "output") throw new Error("unreachable: throwOnDivergence is set");
      const src = r.event;
      this.emit({
        ...src,
        run_id: this.runId,
        seq: this.seq++,
        span_id: newId(),
        mode: "fork",
        parent_run_id: this.ctx.parent_run_id ?? null,
      });
      return r.output;
    }

    const started = Date.now();
    const result = await live(request);
    const builder = request.type === "model_call" ? events.modelCall : events.toolCall;
    this.emit(
      builder(this.ctx, this.seq++, request.name, {
        input: request.input,
        input_hash: hashInput(request.input, this.opts.hashOptions),
        output: result.output,
        status: result.status ?? "ok",
        error: result.error ?? "",
        latency_ms: result.latency_ms ?? Date.now() - started,
        ttft_ms: result.ttft_ms ?? null,
        tokens_in: result.tokens_in ?? 0,
        tokens_out: result.tokens_out ?? 0,
        cost_usd: result.cost_usd ?? 0,
      }),
    );
    return result.output;
  }

  end(agentName: string): void {
    this.emit(events.runEnd(this.ctx, this.seq++, agentName));
  }
}
