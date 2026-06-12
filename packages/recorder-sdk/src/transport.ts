/**
 * Batched, non-blocking event shipping to the ingest service.
 * enqueue() never blocks the agent; a timer flushes every `flushIntervalMs`
 * or as soon as `maxBatchSize` events accumulate. Retries with backoff are
 * safe: ClickHouse insert deduplication (default-on, 26.2+) absorbs replays
 * of the same batch.
 */
import type { TraceEvent } from "./events.js";

export interface TransportOptions {
  /** Ingest base URL, e.g. http://localhost:4000 */
  url: string;
  apiKey?: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxRetries?: number;
  /** Backoff base in ms; attempt n waits base * 2^n. */
  backoffBaseMs?: number;
  /** Cap on buffered events before oldest are dropped (backpressure guard). */
  maxBufferedEvents?: number;
  /** Injectable for tests. */
  fetchFn?: typeof fetch;
  /** Injectable for tests. */
  sleepFn?: (ms: number) => Promise<void>;
  onDrop?: (events: TraceEvent[], reason: string) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Transport {
  private queue: TraceEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> = Promise.resolve();
  private closed = false;

  private readonly url: string;
  private readonly apiKey: string | undefined;
  private readonly flushIntervalMs: number;
  private readonly maxBatchSize: number;
  private readonly maxRetries: number;
  private readonly backoffBaseMs: number;
  private readonly maxBufferedEvents: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly onDrop: (events: TraceEvent[], reason: string) => void;

  constructor(opts: TransportOptions) {
    this.url = opts.url.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.flushIntervalMs = opts.flushIntervalMs ?? 500;
    this.maxBatchSize = opts.maxBatchSize ?? 100;
    this.maxRetries = opts.maxRetries ?? 3;
    this.backoffBaseMs = opts.backoffBaseMs ?? 200;
    this.maxBufferedEvents = opts.maxBufferedEvents ?? 10_000;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.sleepFn = opts.sleepFn ?? defaultSleep;
    this.onDrop =
      opts.onDrop ??
      ((evts, reason) =>
        console.warn(`[afr-transport] dropped ${evts.length} events: ${reason}`));
  }

  /** Never throws, never blocks. */
  enqueue(event: TraceEvent): void {
    if (this.closed) {
      this.onDrop([event], "transport closed");
      return;
    }
    this.queue.push(event);
    if (this.queue.length > this.maxBufferedEvents) {
      const overflow = this.queue.splice(0, this.queue.length - this.maxBufferedEvents);
      this.onDrop(overflow, "buffer overflow");
    }
    if (this.queue.length >= this.maxBatchSize) void this.flush();
    else this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    // Don't keep the agent's process alive just to flush traces.
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  /** Drain the queue. Serialized: concurrent calls share one pipeline. */
  flush(): Promise<void> {
    this.inflight = this.inflight.then(() => this.drain());
    return this.inflight;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatchSize);
      const ok = await this.sendWithRetry(batch);
      if (!ok) {
        this.onDrop(batch, `failed after ${this.maxRetries} retries`);
      }
    }
  }

  private async sendWithRetry(batch: TraceEvent[]): Promise<boolean> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetchFn(`${this.url}/events`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ events: batch }),
        });
        if (res.ok) return true;
        // 4xx = our bug, retrying won't help; surface immediately.
        if (res.status >= 400 && res.status < 500) {
          this.onDrop(batch, `ingest rejected batch: ${res.status} ${await res.text()}`);
          return true; // handled (dropped with reason), don't double-drop
        }
      } catch {
        // network error — fall through to backoff
      }
      if (attempt < this.maxRetries) {
        await this.sleepFn(this.backoffBaseMs * 2 ** attempt);
      }
    }
    return false;
  }

  /** Flush everything and stop the timer. Call on run_end. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    this.closed = true;
  }

  get pending(): number {
    return this.queue.length;
  }
}
