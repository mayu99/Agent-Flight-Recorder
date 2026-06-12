import { NextResponse } from "next/server";
import { loadRunEvents } from "@afr/replay-engine";
import { compactTrace } from "@afr/auto-eval";
import { gatewayConfigFromEnv, gatewayHeaders, gatewayModelFromEnv } from "@afr/recorder-sdk";
import { timelinePrompt } from "@/components/timeline/timeline-prompt";

export const dynamic = "force-dynamic";

/**
 * GET — generate the OpenUI Lang timeline for a run.
 * Streams plain text (openui-lang statements) as the LLM composes them;
 * the client feeds accumulated text to <Renderer /> for progressive render.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;

  let gateway, model;
  try {
    gateway = gatewayConfigFromEnv();
    model = gatewayModelFromEnv("AFR_TIMELINE_MODEL");
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 503 },
    );
  }

  const events = await loadRunEvents(runId);
  if (events.length === 0) {
    return NextResponse.json({ error: `run ${runId} has no events` }, { status: 404 });
  }

  const upstream = await fetch(`${gateway.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: gatewayHeaders(gateway),
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0,
      messages: [
        { role: "system", content: timelinePrompt() },
        {
          role: "user",
          content:
            `run_id: ${runId}\n` +
            `Render the replay timeline for this trace (${events.length} steps):\n` +
            JSON.stringify(compactTrace(events), null, 1),
        },
      ],
    }),
  });

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: `gateway HTTP ${upstream.status}: ${detail.slice(0, 500)}` },
      { status: 502 },
    );
  }

  // SSE → plain text deltas. The OpenUI streaming parser consumes raw text.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> })
            .choices?.[0]?.delta?.content;
          if (delta) controller.enqueue(encoder.encode(delta));
        } catch {
          // partial SSE line split across chunks — keep buffering
        }
      }
    },
  });

  return new Response(upstream.body.pipeThrough(transform), {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
