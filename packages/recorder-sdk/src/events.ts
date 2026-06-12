/**
 * Trace event model — THE shared contract (CLAUDE.md: change it here or nowhere).
 * Mirrors clickhouse/schema.sql `afr.events` column-for-column. SDK, ingest,
 * replay engine, and dashboard all import from this file.
 */
import { z } from "zod";

export const EVENT_TYPES = [
  "run_start",
  "model_call",
  "tool_call",
  "context_injection",
  "agent_decision",
  "run_end",
  "error",
] as const;
export const EventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventTypeSchema>;

export const STATUSES = ["ok", "error", "timeout"] as const;
export const StatusSchema = z.enum(STATUSES);
export type Status = z.infer<typeof StatusSchema>;

export const MODES = ["record", "replay", "fork"] as const;
export const ModeSchema = z.enum(MODES);
export type Mode = z.infer<typeof ModeSchema>;

/** SHA-256 hex. Events with no meaningful input (run_start/run_end) use ZERO_HASH. */
export const ZERO_HASH = "0".repeat(64);
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** ClickHouse DateTime64(3) — 'YYYY-MM-DD HH:mm:ss.SSS' in UTC. */
const TsSchema = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/);

export const TraceEventSchema = z.object({
  run_id: z.uuid(),
  seq: z.number().int().nonnegative(),
  span_id: z.uuid(),
  parent_span_id: z.uuid().nullable().default(null),
  event_type: EventTypeSchema,
  name: z.string().default(""),
  input: z.unknown().default({}),
  input_hash: HashSchema.default(ZERO_HASH),
  output: z.unknown().default({}),
  input_text: z.string().default(""),
  output_text: z.string().default(""),
  status: StatusSchema.default("ok"),
  error: z.string().default(""),
  latency_ms: z.number().int().nonnegative().default(0),
  ttft_ms: z.number().int().nonnegative().nullable().default(null),
  tokens_in: z.number().int().nonnegative().default(0),
  tokens_out: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().default(0),
  mode: ModeSchema.default("record"),
  parent_run_id: z.uuid().nullable().default(null),
  ts: TsSchema,
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type TraceEventInput = z.input<typeof TraceEventSchema>;

export const TraceEventBatchSchema = z.array(TraceEventSchema).min(1);

/** Format a Date as ClickHouse DateTime64(3) UTC. */
export function formatTs(date: Date = new Date()): string {
  return date.toISOString().replace("T", " ").replace("Z", "");
}

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Flatten a JSON payload's string leaves for the full-text-search columns.
 * Capped so giant payloads don't bloat rows — full payloads live in input/output.
 */
export function flattenForSearch(value: unknown, cap = 8_192): string {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") parts.push(v);
    else if (typeof v === "number" || typeof v === "boolean") parts.push(String(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return parts.join(" ").slice(0, cap);
}

/** Fields every builder needs from the surrounding run. */
export interface RunContext {
  run_id: string;
  mode?: Mode;
  parent_run_id?: string | null;
}

type BuilderExtras = Partial<
  Pick<
    TraceEvent,
    | "span_id"
    | "parent_span_id"
    | "input"
    | "input_hash"
    | "output"
    | "status"
    | "error"
    | "latency_ms"
    | "ttft_ms"
    | "tokens_in"
    | "tokens_out"
    | "cost_usd"
    | "ts"
  >
>;

function build(
  ctx: RunContext,
  seq: number,
  event_type: EventType,
  name: string,
  extras: BuilderExtras = {},
): TraceEvent {
  return TraceEventSchema.parse({
    run_id: ctx.run_id,
    mode: ctx.mode ?? "record",
    parent_run_id: ctx.parent_run_id ?? null,
    seq,
    span_id: extras.span_id ?? newId(),
    event_type,
    name,
    ts: extras.ts ?? formatTs(),
    input_text: flattenForSearch(extras.input),
    output_text: flattenForSearch(extras.output),
    ...extras,
  });
}

/** Typed builders — one per event_type. */
export const events = {
  runStart: (ctx: RunContext, seq: number, agentName: string, extras?: BuilderExtras) =>
    build(ctx, seq, "run_start", agentName, extras),

  modelCall: (ctx: RunContext, seq: number, modelId: string, extras?: BuilderExtras) =>
    build(ctx, seq, "model_call", modelId, extras),

  toolCall: (ctx: RunContext, seq: number, toolSlug: string, extras?: BuilderExtras) =>
    build(ctx, seq, "tool_call", toolSlug, extras),

  contextInjection: (ctx: RunContext, seq: number, source: string, extras?: BuilderExtras) =>
    build(ctx, seq, "context_injection", source, extras),

  agentDecision: (ctx: RunContext, seq: number, name: string, extras?: BuilderExtras) =>
    build(ctx, seq, "agent_decision", name, extras),

  runEnd: (ctx: RunContext, seq: number, agentName: string, extras?: BuilderExtras) =>
    build(ctx, seq, "run_end", agentName, extras),

  error: (ctx: RunContext, seq: number, name: string, message: string, extras?: BuilderExtras) =>
    build(ctx, seq, "error", name, { status: "error", error: message, ...extras }),
};

/**
 * Serialize for ClickHouse JSONEachRow insert. JSON columns take objects as-is;
 * `input`/`output` of non-object type are wrapped so the JSON column always
 * receives an object root.
 */
export function toJSONEachRow(e: TraceEvent): Record<string, unknown> {
  const wrap = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? v : { value: v ?? null };
  return { ...e, input: wrap(e.input), output: wrap(e.output) };
}
