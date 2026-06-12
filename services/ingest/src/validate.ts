import { z } from "zod";
import { TraceEventBatchSchema } from "@afr/recorder-sdk/events";

export const IngestBodySchema = z.object({
  events: TraceEventBatchSchema,
});
export type IngestBody = z.infer<typeof IngestBodySchema>;

export function parseIngestBody(
  raw: string,
): { ok: true; body: IngestBody } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "body is not valid JSON" };
  }
  const result = IngestBodySchema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: z.prettifyError(result.error) };
  }
  return { ok: true, body: result.data };
}
