/**
 * TrueFoundry AI Gateway configuration.
 *
 * Integration contract (per truefoundry.com/docs/ai-gateway/quick-start):
 *  - OpenAI-compatible API at the gateway base URL (SaaS: https://gateway.truefoundry.ai)
 *  - Auth: a Personal Access Token (dev) or Virtual Account Token (apps),
 *    passed wherever the OpenAI SDK expects `apiKey`
 *  - Model ids are `{provider-account}/{model}` strings copied verbatim from
 *    the TrueFoundry Playground's Code Snippets tab
 */
export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
}

export class GatewayConfigError extends Error {}

/** Read and validate gateway settings from the environment. */
export function gatewayConfigFromEnv(env: Record<string, string | undefined> = process.env): GatewayConfig {
  const baseUrl = env.TRUEFOUNDRY_GATEWAY_URL?.replace(/\/+$/, "");
  const apiKey = env.TRUEFOUNDRY_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new GatewayConfigError(
      "TrueFoundry gateway not configured. Set TRUEFOUNDRY_GATEWAY_URL " +
        "(SaaS: https://gateway.truefoundry.ai) and TRUEFOUNDRY_API_KEY " +
        "(Personal Access Token from the platform's Access section) in .env",
    );
  }
  return { baseUrl, apiKey };
}

/**
 * Standard headers for every gateway call. X-TFY-LOGGING-CONFIG opts the
 * request into TrueFoundry AI Monitoring (request traces, fallback events,
 * per-model cost) — complementary to AFR's own client-side recording.
 */
export function gatewayHeaders(cfg: GatewayConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.apiKey}`,
    "X-TFY-LOGGING-CONFIG": '{"enabled": true}',
  };
}

/** Model id for a given role, e.g. AFR_DEMO_MODEL / AFR_TIMELINE_MODEL / EVAL_MODEL. */
export function gatewayModelFromEnv(
  varName: "AFR_DEMO_MODEL" | "AFR_TIMELINE_MODEL" | "EVAL_MODEL",
  env: Record<string, string | undefined> = process.env,
): string {
  const model = env[varName];
  if (!model) {
    throw new GatewayConfigError(
      `${varName} is not set. Copy the exact model string (e.g. "openai-main/gpt-4o") ` +
        "from the TrueFoundry Playground's Code Snippets tab into .env",
    );
  }
  return model;
}
