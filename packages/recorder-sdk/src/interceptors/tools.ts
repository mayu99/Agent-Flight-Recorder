import { events } from "../events";
import { hashInput } from "../hashing";
import type { Recorder } from "../recorder";

/**
 * Tool-call interceptor — Composio execution modifiers.
 *
 * Composio v3's native-tools path lets modifiers wrap every execution when
 * passed to `tools.get()` (agentic providers) or `tools.execute()`:
 *
 *   const tools = await composio.tools.get(userId, { toolkits: [...] },
 *                                          composioModifiers(rec));
 *
 * Structurally typed against the Composio SDK's modifier shapes so the SDK
 * package itself stays dependency-free.
 */

interface BeforeArgs {
  toolSlug: string;
  toolkitSlug: string;
  params: Record<string, unknown>;
}

interface AfterArgs {
  toolSlug: string;
  toolkitSlug: string;
  result: Record<string, unknown>;
}

export interface ComposioModifiers {
  beforeExecute: (args: BeforeArgs) => BeforeArgs["params"];
  afterExecute: (args: AfterArgs) => AfterArgs["result"];
}

export function composioModifiers(rec: Recorder): ComposioModifiers {
  // Composio invokes before/after as a pair per execution; correlate them in
  // call order (tool executions through one agent loop are sequential per slug).
  const pending = new Map<string, Array<{ seq: number; started: number; params: unknown }>>();

  return {
    beforeExecute: ({ toolSlug, toolkitSlug, params }) => {
      const seq = rec.nextSeq();
      const list = pending.get(toolSlug) ?? [];
      list.push({ seq, started: performance.now(), params: structuredClone(params) });
      pending.set(toolSlug, list);
      void toolkitSlug;
      return params;
    },

    afterExecute: ({ toolSlug, toolkitSlug, result }) => {
      const list = pending.get(toolSlug) ?? [];
      const entry = list.shift() ?? { seq: rec.nextSeq(), started: performance.now(), params: {} };
      const failed =
        result && typeof result === "object" && "successful" in result && result.successful === false;
      rec.emit(
        events.toolCall(rec.ctx, entry.seq, toolSlug, {
          input: { toolkit: toolkitSlug, params: entry.params },
          input_hash: hashInput({ toolSlug, params: entry.params }),
          output: result,
          status: failed ? "error" : "ok",
          error: failed ? String((result as { error?: unknown }).error ?? "tool execution failed") : "",
          latency_ms: Math.round(performance.now() - entry.started),
        }),
      );
      return result;
    },
  };
}
