import { events, newId, type Mode, type RunContext, type Status, type TraceEvent } from "./events";
import { hashInput } from "./hashing";
import { Transport, type TransportOptions } from "./transport";

export interface RecorderOptions {
  agentName: string;
  ingestUrl: string;
  apiKey: string;
  mode?: Mode;
  runId?: string;
  parentRunId?: string | null;
  transport?: Partial<Pick<TransportOptions, "flushIntervalMs" | "maxBatchSize" | "fetchFn">>;
}

/**
 * One recording session = one run. Owns the run context, the atomic seq
 * counter (safe under parallel tool calls), and the transport. All
 * interceptors emit through this.
 */
export class Recorder {
  readonly ctx: RunContext;
  readonly agentName: string;
  private seq = 0;
  private readonly transport: Transport;
  private ended = false;

  constructor(opts: RecorderOptions) {
    this.agentName = opts.agentName;
    this.ctx = {
      run_id: opts.runId ?? newId(),
      mode: opts.mode ?? "record",
      parent_run_id: opts.parentRunId ?? null,
    };
    this.transport = new Transport({
      url: opts.ingestUrl,
      apiKey: opts.apiKey,
      ...opts.transport,
    });
    this.emit(events.runStart(this.ctx, this.nextSeq(), this.agentName));
  }

  get runId(): string {
    return this.ctx.run_id;
  }

  /** Monotonic, synchronous — JS single-threadedness makes this atomic. */
  nextSeq(): number {
    return this.seq++;
  }

  emit(event: TraceEvent): void {
    this.transport.enqueue(event);
  }

  /** Record a context injection (system prompt, retrieved docs, memory, ...). */
  context(source: string, payload: unknown): void {
    this.emit(
      events.contextInjection(this.ctx, this.nextSeq(), source, {
        input: payload,
        input_hash: hashInput(payload),
        status: "ok",
        latency_ms: 0,
      }),
    );
  }

  /** Record an explicit agent decision/plan step. */
  decision(name: string, payload: unknown): void {
    this.emit(
      events.agentDecision(this.ctx, this.nextSeq(), name, {
        input: payload,
        input_hash: hashInput(payload),
        status: "ok",
        latency_ms: 0,
      }),
    );
  }

  /** Close the run and flush everything. Idempotent. */
  async end(status: Status = "ok", error?: string): Promise<void> {
    if (this.ended) return;
    this.ended = true;
    this.emit(
      events.runEnd(this.ctx, this.nextSeq(), this.agentName, {
        status,
        error: error ?? "",
        latency_ms: 0,
      }),
    );
    await this.transport.close();
  }
}

/** Entry point: start recording a run. Pair with `await rec.end()`. */
export function record(opts: RecorderOptions): Recorder {
  return new Recorder(opts);
}
