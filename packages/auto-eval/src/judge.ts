import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { newId, formatTs, type TraceEvent } from "@afr/recorder-sdk/events";
import { gatewayConfigFromEnv, gatewayHeaders, gatewayModelFromEnv, type GatewayConfig } from "@afr/recorder-sdk";
import { loadRunEvents } from "@afr/replay-engine";
import { z } from "zod";
import { RUBRICS, rubricMessages, type RubricId } from "./rubrics";

const VerdictSchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  score: z.number().min(0).max(1),
  reasoning: z.string(),
  flagged_seq: z.number().int().nullable(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export interface RubricVerdict extends Verdict {
  rubric: RubricId;
  eval_id: string;
  model: string;
}

export interface JudgeOptions {
  gateway?: GatewayConfig;
  model?: string;
  fetchFn?: typeof fetch;
  /** Re-ask once when the model returns unparseable JSON. */
  maxAttempts?: number;
}

/** Judge one rubric over a trace via the gateway's OpenAI-compatible API. */
export async function judgeRubric(
  rubric: RubricId,
  eventsList: TraceEvent[],
  opts: JudgeOptions = {},
): Promise<RubricVerdict> {
  const gateway = opts.gateway ?? gatewayConfigFromEnv();
  const model = opts.model ?? gatewayModelFromEnv("EVAL_MODEL");
  const fetchFn = opts.fetchFn ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 2;
  const messages = rubricMessages(rubric, eventsList);

  let lastError = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetchFn(`${gateway.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: gatewayHeaders(gateway),
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
      }),
    });
    if (!res.ok) {
      lastError = `gateway HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`;
      continue;
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content ?? "";
    try {
      const verdict = VerdictSchema.parse(JSON.parse(extractJson(content)));
      return { ...verdict, rubric, eval_id: newId(), model };
    } catch (err) {
      lastError = `unparseable verdict: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`judge failed for rubric ${rubric} after ${maxAttempts} attempts: ${lastError}`);
}

/** Tolerate models that wrap JSON in code fences. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

/** Judge all rubrics for a trace. */
export async function judgeTrace(eventsList: TraceEvent[], opts: JudgeOptions = {}): Promise<RubricVerdict[]> {
  return Promise.all(RUBRICS.map((r) => judgeRubric(r, eventsList, opts)));
}

export interface EvalRunOptions extends JudgeOptions {
  clickhouse?: ClickHouseClient;
}

/** Load a run from ClickHouse, judge it, write verdicts to afr.evals. */
export async function evalRun(runId: string, opts: EvalRunOptions = {}): Promise<RubricVerdict[]> {
  const eventsList = await loadRunEvents(runId);
  if (eventsList.length === 0) throw new Error(`run ${runId} has no events`);
  const verdicts = await judgeTrace(eventsList, opts);
  const client =
    opts.clickhouse ??
    createClient({
      url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
      username: process.env.CLICKHOUSE_USER ?? "default",
      password: process.env.CLICKHOUSE_PASSWORD ?? "",
      database: process.env.CLICKHOUSE_DATABASE ?? "afr",
    });
  await client.insert({
    table: "evals",
    values: verdicts.map((v) => ({
      run_id: runId,
      eval_id: v.eval_id,
      verdict: v.verdict,
      score: v.score,
      rubric: v.rubric,
      reasoning: v.reasoning,
      flagged_seq: v.flagged_seq,
      model: v.model,
      created_at: formatTs(),
    })),
    format: "JSONEachRow",
    clickhouse_settings: { async_insert: 1, wait_for_async_insert: 1 },
  });
  return verdicts;
}
