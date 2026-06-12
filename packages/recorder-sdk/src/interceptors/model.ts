import { events } from "../events";
import { hashInput } from "../hashing";
import type { Recorder } from "../recorder";

/**
 * Model-call interceptor — the TrueFoundry gateway choke point.
 *
 * The OpenAI SDK (and anything OpenAI-compatible pointed at the gateway)
 * accepts a custom `fetch`. This wrapper records every POST to a
 * /chat/completions endpoint: full request body, full response (streaming
 * responses are teed and accumulated), latency, time-to-first-token, and
 * token usage. The agent's traffic is passed through untouched.
 *
 *   const openai = new OpenAI({
 *     baseURL: gateway.baseUrl,        // https://gateway.truefoundry.ai
 *     apiKey: gateway.apiKey,          // TrueFoundry PAT / VAT
 *     fetch: recordedFetch(rec),
 *   });
 */
type FetchInput = Parameters<typeof fetch>[0];

export function recordedFetch(rec: Recorder, baseFetch: typeof fetch = fetch): typeof fetch {
  const wrapped = (async (input: FetchInput, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "POST" || !/\/chat\/completions(\?|$)/.test(url)) {
      return baseFetch(input, init);
    }

    const rawBody = typeof init?.body === "string" ? init.body : await new Response(init?.body).text();
    let requestJson: unknown;
    try {
      requestJson = JSON.parse(rawBody);
    } catch {
      requestJson = { __afr_unparsed_request__: rawBody };
    }
    const req = requestJson as { model?: string; stream?: boolean };
    const seq = rec.nextSeq();
    const started = performance.now();

    let response: Response;
    try {
      response = await baseFetch(input, init);
    } catch (err) {
      rec.emit(
        events.modelCall(rec.ctx, seq, req.model ?? "unknown", {
          input: requestJson,
          input_hash: hashInput(requestJson),
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          latency_ms: Math.round(performance.now() - started),
        }),
      );
      throw err;
    }

    if (!response.ok) {
      const errText = await response.clone().text().catch(() => "");
      rec.emit(
        events.modelCall(rec.ctx, seq, req.model ?? "unknown", {
          input: requestJson,
          input_hash: hashInput(requestJson),
          output: { http_status: response.status, body: errText.slice(0, 8_192) },
          status: "error",
          error: `HTTP ${response.status} from gateway`,
          latency_ms: Math.round(performance.now() - started),
        }),
      );
      return response;
    }

    if (req.stream && response.body) {
      // Tee: one branch to the caller untouched, one accumulated for the trace.
      const [toCaller, toRecorder] = response.body.tee();
      void accumulateStream(toRecorder, started).then(({ text, chunks, ttftMs, usage, finishedAt }) => {
        rec.emit(
          events.modelCall(rec.ctx, seq, req.model ?? "unknown", {
            input: requestJson,
            input_hash: hashInput(requestJson),
            output: { streamed: true, text, chunks, usage: usage ?? null },
            status: "ok",
            latency_ms: Math.round(finishedAt - started),
            ttft_ms: ttftMs,
            tokens_in: usage?.prompt_tokens ?? 0,
            tokens_out: usage?.completion_tokens ?? 0,
          }),
        );
      });
      return new Response(toCaller, { status: response.status, statusText: response.statusText, headers: response.headers });
    }

    const responseJson = (await response.clone().json().catch(() => null)) as {
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    rec.emit(
      events.modelCall(rec.ctx, seq, req.model ?? "unknown", {
        input: requestJson,
        input_hash: hashInput(requestJson),
        output: responseJson ?? {},
        status: "ok",
        latency_ms: Math.round(performance.now() - started),
        tokens_in: responseJson?.usage?.prompt_tokens ?? 0,
        tokens_out: responseJson?.usage?.completion_tokens ?? 0,
      }),
    );
    return response;
  }) as typeof fetch;
  return wrapped;
}

interface StreamSummary {
  text: string;
  chunks: number;
  ttftMs: number | null;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
  finishedAt: number;
}

/** Accumulate an OpenAI-style SSE stream: concatenated delta text, chunk count, ttft, usage. */
async function accumulateStream(stream: ReadableStream<Uint8Array>, started: number): Promise<StreamSummary> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let chunks = 0;
  let ttftMs: number | null = null;
  let usage: StreamSummary["usage"] = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string } }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        chunks += 1;
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          if (ttftMs === null) ttftMs = Math.round(performance.now() - started);
          text += delta;
        }
        if (parsed.usage) usage = parsed.usage;
      } catch {
        // partial line across chunk boundary — keep buffering
      }
    }
  }
  return { text, chunks, ttftMs, usage, finishedAt: performance.now() };
}
