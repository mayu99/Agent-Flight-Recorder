/**
 * Canonical input hashing — the replay/diff alignment key.
 * Same logical input MUST produce the same SHA-256 across runs, regardless of
 * object key order, insignificant whitespace in strings, or -0 vs 0.
 * Volatile fields (timestamps, request ids) are excluded by key allowlist so
 * replays don't false-diverge.
 */
import { createHash } from "node:crypto";

export interface CanonicalizeOptions {
  /** Keys dropped at ANY depth before hashing (volatile fields: ts, request_id…). */
  excludeKeys?: ReadonlySet<string> | readonly string[];
  /** Collapse whitespace runs in strings and trim. Default true. */
  normalizeStrings?: boolean;
}

function normStr(s: string, normalize: boolean): string {
  return normalize ? s.replace(/\s+/g, " ").trim() : s;
}

function canonicalValue(value: unknown, exclude: Set<string>, normalize: boolean): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return normStr(value, normalize);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => canonicalValue(v, exclude, normalize));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (exclude.has(key)) continue;
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canonicalValue(v, exclude, normalize);
    }
    return out;
  }
  // functions/symbols/bigints have no canonical JSON form — treat as null
  return null;
}

/** Deterministic JSON: sorted keys, normalized strings/floats, volatile keys dropped. */
export function canonicalJson(value: unknown, opts: CanonicalizeOptions = {}): string {
  const exclude = new Set(opts.excludeKeys ?? []);
  return JSON.stringify(canonicalValue(value, exclude, opts.normalizeStrings ?? true));
}

/** Canonical SHA-256 hex (64 chars) — what goes in events.input_hash. */
export function hashInput(value: unknown, opts: CanonicalizeOptions = {}): string {
  return createHash("sha256").update(canonicalJson(value, opts)).digest("hex");
}
