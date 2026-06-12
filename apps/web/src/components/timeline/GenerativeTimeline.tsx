"use client";

import { useCallback, useEffect, useState } from "react";
import { TimelineView } from "./TimelineView";

type State =
  | { kind: "loading" }
  | { kind: "streaming" | "done"; text: string }
  | { kind: "unavailable"; reason: string };

/**
 * Fetches /api/runs/[id]/timeline and progressively renders the OpenUI Lang
 * stream. When the gateway isn't configured (503) it reports why and the
 * page's conventional timeline remains the fallback.
 */
export function GenerativeTimeline({ runId }: { runId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const res = await fetch(`/api/runs/${runId}/timeline`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ kind: "unavailable", reason: body.error ?? `HTTP ${res.status}` });
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        setState({ kind: "streaming", text });
      }
      setState({ kind: "done", text });
    } catch (err) {
      setState({ kind: "unavailable", reason: err instanceof Error ? err.message : String(err) });
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.kind === "unavailable") {
    return (
      <p className="rounded-md border border-zinc-800 bg-zinc-900/60 p-3 text-sm text-zinc-400">
        Generative timeline unavailable: {state.reason}
      </p>
    );
  }
  if (state.kind === "loading") {
    return <p className="animate-pulse text-sm text-zinc-500">Composing timeline…</p>;
  }
  return (
    <div>
      <TimelineView response={state.text} isStreaming={state.kind === "streaming"} />
      <button
        onClick={() => void load()}
        className="mt-3 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
      >
        Recompose
      </button>
    </div>
  );
}
