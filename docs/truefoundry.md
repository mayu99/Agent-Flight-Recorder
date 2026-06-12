# TrueFoundry — Research Notes for Agent Flight Recorder

> Researched June 2026 against live docs at `https://www.truefoundry.com/docs/` (the docs serve raw
> markdown at `*.md` URLs and publish a machine-readable index at
> `https://www.truefoundry.com/docs/llms.txt`). All code samples below are taken verbatim or
> minimally adapted from the official documentation.
>
> **Why we care:** TrueFoundry's AI Gateway is a candidate *inference path* for the flight
> recorder — a single OpenAI-compatible endpoint in front of every model provider that already
> records per-request latency, tokens, cost, TTFT, and inter-token latency as **queryable spans**,
> exports them over **OpenTelemetry**, and even documents a first-class **ClickHouse (ClickStack)
> trace export** — which matches our ClickHouse storage layer exactly.

---

## Table of Contents

1. [Overview](#1-overview)
2. [AI Gateway (deep dive)](#2-ai-gateway-deep-dive)
3. [Latest changes (2025–2026)](#3-latest-changes-2025-2026)
4. [Getting started](#4-getting-started)
5. [Observability & logging](#5-observability--logging)
6. [Tracing & evals](#6-tracing--evals)
7. [Model deployment (brief)](#7-model-deployment-brief)
8. [Pricing & free tier](#8-pricing--free-tier)
9. [Relevance to Agent Flight Recorder](#9-relevance-to-agent-flight-recorder)
10. [Links](#10-links)

---

## 1. Overview

**TrueFoundry** is an enterprise AI platform built on Kubernetes. As of 2026 it positions itself
as "an enterprise-grade AI Gateway combining **LLM, MCP, and Agent Gateways** to connect, monitor,
and govern agentic AI applications across providers from a unified control plane." It was
recognized in the Gartner Hype Cycle for Platform Engineering 2026.

Main products:

| Product | What it does |
|---|---|
| **AI Gateway (LLM Gateway)** | Unified OpenAI-compatible proxy for 1000+ models / 30+ providers. Auth, routing, load balancing, fallback, rate/budget limits, guardrails, caching, observability. |
| **MCP Gateway** | Centralized registry + proxy for MCP servers: OAuth token management, tool-level RBAC, MCP guardrails, virtual MCP servers (combine tools from multiple servers), full audit trail of tool calls. |
| **Agent Gateway / Agent Harness** | Managed agent runtime built on the AI + MCP gateways: orchestration loop, sandbox, skills registry, subagents, human-in-the-loop approvals, generative UI, per-step traces. |
| **Agent & Skills Registries** | Register/discover agents (including remote agents on Bedrock/Vertex/etc.) and versioned `SKILL.md` skills with RBAC. |
| **AI Engineering platform** | The original MLOps layer: deploy services/jobs/workflows (Flyte-based), deploy LLMs (vLLM / SGLang / TRT-LLM), notebooks, model registry, experiment tracking, prompt management, fine-tuning — all on your Kubernetes clusters (AWS/GCP/Azure/on-prem/OpenShift). |

Architecture is split into a **control plane** (UI, registry, configs, metrics storage) and a
**gateway plane / compute plane** (the data path). Deployment options range from fully-managed
SaaS to fully self-hosted (see §4 and §8).

---

## 2. AI Gateway (deep dive)

Docs root: <https://www.truefoundry.com/docs/ai-gateway/intro-to-llm-gateway>

The AI Gateway is "the proxy layer that sits between your applications and the LLM providers and
MCP Servers" exposing **one endpoint with an OpenAI-compatible schema for every provider**.

### 2.1 Base URL, model naming, authentication

| Thing | Value |
|---|---|
| SaaS base URL | `https://gateway.truefoundry.ai` |
| Self-hosted base URL | shown in the Playground → Code Snippets tab |
| Model ID format | `provider_account/model_name`, e.g. `openai-main/gpt-4o-mini`, `anthropic-main/claude-4-sonnet`, `tfy-ai-bedrock/global-anthropic-claude-opus-4-5-20251101-v1-0` |
| Auth | `Authorization: Bearer <TrueFoundry API key>` — a **PAT** (Personal Access Token, dev) or **VAT** (Virtual Account Token, production/CI). You never use provider keys client-side; the gateway holds provider credentials centrally. |

The *provider account* prefix is a configured connection to a provider — an org can have multiple
accounts per provider (e.g. `openai-main` for prod, `openai-dev` for testing), which is also the
access-control boundary (users/virtual accounts are granted access per provider account).

The SaaS gateway is **globally distributed** (multi-region, multi-zone, multi-cloud); requests are
routed to the nearest region and automatically tagged with `tfy_gateway_region` /
`tfy_gateway_zone` metadata.

### 2.2 Supported providers (30+)

Gemini & Vertex AI, Google Gemini, AWS Bedrock, AWS SageMaker, Azure OpenAI, Azure AI Foundry,
OpenAI, Anthropic, Cohere, Databricks, AI21, Together AI, xAI, DeepInfra, Perplexity AI, Mistral,
Groq, Cerebras, SambaNova, Baseten (added v0.133, Mar 2026), Deepgram, ElevenLabs, Cartesia,
Smallest AI (Waves, added v0.141), **self-hosted models** (any OpenAI-compatible endpoint), and a
generic **Custom Endpoints** provider type (added v0.141, Apr 2026).

Docs note: *"If you don't see the provider you need, there is a high chance it will just work as
self hosted models or OpenAI provider."*

### 2.3 Supported APIs

OpenAI-compatible endpoints (per-provider support matrix in the intro doc):

- `/chat/completions` — streaming + non-streaming, tools, JSON mode, schema mode, prompt caching,
  reasoning tokens. Supported across OpenAI, Azure OpenAI, Anthropic, Bedrock, Vertex, Gemini,
  Cohere, Groq, xAI, Together, DeepInfra, etc.
- `/messages` — **Anthropic Messages API** natively (use the Anthropic SDK against the gateway)
- `/responses` — OpenAI Responses API (added v0.139, Apr 2026)
- `/embeddings`, `/v2/rerank`, `/moderations`
- `/images` (generation/edit/variations), audio: TTS, transcription (STT), translation
- `/live` — bidirectional realtime/WebSocket API (Gemini, Vertex, OpenAI, Azure AI Foundry)
- `/batches` (batch pricing; **no virtual-model routing** for batches), `/files`, `/fine_tuning`
- `/models` — model discovery (OpenAI-compatible list of models your key can access)
- `/proxy` — provider-native passthrough (e.g. `{base}/bedrock/proxy` for boto3,
  `{base}/gemini/{providerAccount}/proxy` for the Google Gen AI SDK) while keeping gateway auth,
  cost tracking, and limits
- `/agent/responses` and `/mcp-server/...` — agent and MCP gateway traffic

**Native SDK support** (tracing, cost tracking, rate/budget limits work for all):

| SDK | Models | Cost tracking | Rate/Budget limits | Routing config |
|---|---|---|---|---|
| OpenAI SDK | All models | Yes | Yes | Yes |
| Anthropic SDK | Anthropic models | Yes | Yes | Yes |
| Google Gen AI SDK | Gemini/Vertex | Yes | Yes | No |
| boto3 (Bedrock Runtime: `converse`, `invoke_model`, streaming variants) | Bedrock models | Yes | Yes | No |
| langchain_aws (`ChatBedrockConverse`) | Bedrock models | Yes | Yes | No |

### 2.4 Virtual Models — load balancing, fallback, retries

Docs: <https://www.truefoundry.com/docs/ai-gateway/virtual-model>

A **virtual model** is a named alias (e.g. `my-group/production-chat`) backed by one routing
strategy and N real targets. This is now the **recommended** routing mechanism (the older global
YAML "Routing Config" still works but is deprecated for new setups; the `x-tfy-routing-config`
request header was **removed in v0.133**, Mar 2026).

Three routing strategies:

| Strategy | Behavior | Best for |
|---|---|---|
| `weight-based-routing` | Split traffic by weights summing to 100. Supports **sticky routing** (pin a session to a target for `ttl_seconds` keyed by headers/metadata). | Canary rollouts, A/B, capacity splits |
| `priority-based-routing` | Route to highest-priority healthy target (0 = highest), fall back down the chain. Supports **SLA cutoff**: per-target `sla_cutoff.time_per_output_token_ms` threshold over a 3-min rolling window (≥3 samples) marks a target unhealthy. | Primary + backup, on-prem-first with cloud burst |
| `latency-based-routing` | Deterministic per-caller selection weighted by recent **TPOT** (time per output token) over the last 20 minutes; **inherently sticky per caller per 10-minute epoch** (good for prompt-cache reuse). Faster targets get a larger share. | Performance chasing across regions/providers |

Full per-target config shape (verbatim from docs):

```yaml
routing_config:
  type: weight-based-routing | latency-based-routing | priority-based-routing

  # Sticky routing (weight-based only)
  sticky_routing:
    ttl_seconds: integer              # how long a session stays pinned (seconds)
    session_identifiers:
      - key: string                   # header or metadata field name
        source: headers | metadata    # where to read the session key from

  load_balance_targets:
    - target: string                  # model identifier in the gateway (e.g. azure/gpt-4o)
      weight: integer                 # 0–100, sum to 100 (weight-based only)
      priority: integer               # lower = higher priority (priority-based only)

      retry_config:
        attempts: integer             # retries on the SAME target; default: 2
        delay: integer                # ms between retries; default: 100
        on_status_codes: string[]     # default: ["429","500","502","503"]

      fallback_status_codes: string[] # codes that trigger trying a DIFFERENT target
                                      # default: ["401","403","404","429","500","502","503"]
      fallback_candidate: boolean     # eligible to receive fallback traffic? default: true

      sla_cutoff:                     # priority-based only
        time_per_output_token_ms: integer

      metadata_match:                 # target only eligible when resolved request metadata matches (AND)
        key1: value1

      headers_override:
        set: { header-name: header-value }
        remove: [header-name]

      override_params:
        temperature: number
        max_tokens: integer
        prompt_version_fqn: string    # per-target prompt version
```

Example — priority chain with retries and fallback:

```yaml
routing_config:
  type: priority-based-routing
  load_balance_targets:
    - target: azure/gpt-4o
      priority: 0
      retry_config:
        attempts: 3
        delay: 200
        on_status_codes: ["429", "500", "503"]
      fallback_status_codes: ["429", "500", "502", "503"]
      fallback_candidate: true
    - target: openai/gpt-4o
      priority: 1
      retry_config:
        attempts: 2
        delay: 100
      fallback_status_codes: ["429"]
      fallback_candidate: true
    - target: anthropic/claude-sonnet
      priority: 2
      fallback_candidate: false   # only used as primary, never receives fallback traffic
```

Key operational details:

- **Unhealthy target detection** (all strategies): a target is marked unhealthy after ≥2 failures
  (5xx/429/401/403) in a rolling 2-minute window; unhealthy targets are moved to the end of the
  list and recover automatically.
- **Which target actually served the request** is returned in the **`x-tfy-resolved-model`**
  response header — important for replay determinism (see §9).
- **Anthropic streaming overload fallback**: for Anthropic streaming, the gateway waits for the
  first non-empty stream chunk; if an `overloaded_error` arrives before it, the gateway falls back
  to the next target.
- `metadata_match` works against resolved metadata (request `x-tfy-metadata` header < default
  gateway metadata < virtual-account tags; plus auto `tfy_gateway_region`/`tfy_gateway_zone` on
  SaaS) enabling region routing without client changes.
- Virtual models cannot point at other virtual models; batch API doesn't support them.
- Per-request timeouts: `x-tfy-request-timeout` (ms, applied **per attempt** including fallbacks)
  and `x-tfy-ttft-timeout-ms` (time-to-first-token timeout for streams → 408 → triggers fallback;
  added v0.127, Mar 2026).

### 2.5 Rate limiting

Docs: <https://www.truefoundry.com/docs/ai-gateway/ratelimiting>

YAML config (`type: gateway-rate-limiting-config`) with ordered rules — **first matching rule
wins**. Each rule:

- `when` — AND of `subjects` (`user:…`, `team:…`, `virtualaccount:…`), `models`, and `metadata`
  (matched against the `X-TFY-METADATA` request header).
- `limit_to` + `unit` — `requests_per_minute|hour|day` or `tokens_per_minute|hour|day`.
- `rate_limit_applies_per` — creates a separate counter per `user`, `model`, `virtualaccount`, or
  `metadata.<key>` (max 2 combined, e.g. `['user', 'model']`). This replaced the old dynamic
  `{user}-daily-limit` rule-ID format (breaking change, v0.109, Dec 2025).

```yaml
name: ratelimiting-config
type: gateway-rate-limiting-config
rules:
  - id: "openai-gpt4-dev-env"
    when:
      subjects: ["user:bob@email.com"]
      models: ["openai-main/gpt4"]
    limit_to: 1000
    unit: requests_per_day
  - id: "user-model-daily-limit"
    when: {}
    limit_to: 1000000
    unit: tokens_per_day
    rate_limit_applies_per: ['user', 'model']
  - id: "project-hourly-limit"      # X-TFY-METADATA: {"project_id": "proj-123"}
    when: {}
    limit_to: 50000
    unit: tokens_per_hour
    rate_limit_applies_per: ['metadata.project_id']
```

Implementation: sliding-window token bucket — 60 s sliding window of 5 s buckets per
user/model/team/custom segment.

### 2.6 Budget limiting (cost controls)

Docs: <https://www.truefoundry.com/docs/ai-gateway/budgetlimiting>

Ordered rules with the same `when` filters. Two-phase semantics: **cost is tracked against every
matching rule**, but the **first matching rule decides allow/block**. Per-rule:

- Budget in **USD** per **day / week / month** (and **quarter** since v0.144, May 2026). Resets at
  UTC midnight / Monday / 1st of month. Tracking starts at rule creation (not retroactive).
- **Apply budget per** — one of `user`, `model`, `virtualaccount`, or a metadata key → separate
  budget per entity.
- **Audit mode** (`audit_mode: true` / "Block if usage limit exceeded" OFF) — tracks usage and
  fires milestone alerts at **75% / 90% / 95% / 100%** (Email, Slack, PagerDuty) without blocking.

### 2.7 Caching — exact-match and semantic

Docs: <https://www.truefoundry.com/docs/ai-gateway/caching>

Gateway-level response caching (distinct from provider prompt caching, which the gateway also
passes through and meters via `cache_read_input_tokens` / `cache_creation_input_tokens`):

- **Exact-match** — keyed by a hash of the complete request (messages, model, all params).
- **Semantic** — last message embedded (OpenAI `text-embedding-3-small` on SaaS) and matched by
  cosine similarity against cached embeddings; *all other params must still hash-match exactly*.
  Semantic is a superset of exact-match.
- Per-request opt-in via header (stringified JSON):

```bash
curl {GATEWAY_BASE_URL}/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-truefoundry-api-key" \
  -H "x-tfy-cache-config: {\"type\": \"semantic\", \"similarity_threshold\": 0.9, \"ttl\": 600, \"namespace\": \"tenant-123\"}" \
  -d '{"model": "openai-main/gpt-4o", "messages": [{"role": "user", "content": "How do I reset my password?"}]}'
```

- `similarity_threshold` 0–1.0 (recommended start: 0.9), `ttl` seconds, optional `namespace` for
  per-tenant isolation. Cache entries are automatically scoped per user/virtual account.
- Response headers: `x-tfy-cache-status` (`hit|miss|error`), `x-tfy-cached-trace-id` (trace ID of
  the request that populated the cache), `x-tfy-cache-similarity-score`.
- Self-hosted needs Redis (bundled in the `tfy-llm-gateway` Helm chart or BYO) + an embedding
  model for semantic mode.

### 2.8 Guardrails

Docs: <https://www.truefoundry.com/docs/ai-gateway/guardrails-overview>

Input and output guardrails with `validate` (block) / `mutate` (redact/transform) / `flag` modes,
configurable per model/subject/metadata, with results recorded in traces
(`tfy.guardrail.result` = `pass|mutate|flag`, plus per-guardrail latency).

- **TrueFoundry-managed** (launched Feb 2026, v0.117–0.118): PII/PHI detection & redaction,
  prompt-injection/jailbreak detection, content moderation, secrets detection, regex pattern
  match, SQL sanitizer, code safety linter, metadata validation.
- **Integrations**: Azure Content Safety / Prompt Shield / Azure PII, AWS Bedrock Guardrails,
  Google Model Armor (validate + mutate), NVIDIA NeMo, Guardrails AI Hub, Enkrypt AI, Pillar
  Security, CrowdStrike AIDR (replaced Pangea, v0.144), TrojAI DEFEND, Lasso, GraySwan Cygnal,
  Palo Alto; policy engines: **OPA** and **Cedar**; plus fully custom guardrail webhooks/plugins.
- **MCP tool-call guardrails**: pre/post tool-execution checks, enforced on SSE streaming too;
  can target individual tools via `server:tool` IDs (v0.139).
- Since v0.142 guardrails inspect **tool call inputs and tool results**, not just visible text.
- Tenant-level defaults: guardrail timeout + run input guardrails in parallel with model exec
  (v0.144).

### 2.9 Custom metadata & headers (full reference)

Docs: <https://www.truefoundry.com/docs/ai-gateway/request-headers>

**Request headers:**

| Header | Purpose |
|---|---|
| `Authorization: Bearer <key>` | TrueFoundry PAT/VAT |
| `x-tfy-metadata` | Stringified JSON (string keys/values, ≤128 chars per value) — tags requests for log filtering, custom metric grouping, and routing/rate-limit/budget rule matching. e.g. `{"application":"booking-bot","environment":"staging","customer_id":"123456"}` |
| `x-tfy-provider-name` | Selects provider account for Responses/File/Batch APIs |
| `x-tfy-strict-openai` | `false` exposes Claude thinking/reasoning tokens through the OpenAI schema |
| `x-tfy-request-timeout` | ms, per model attempt (each retry/fallback gets its own timeout) |
| `x-tfy-ttft-timeout-ms` | ms until first stream token, else 408 + fallback |
| `x-tfy-logging-config` | `{"enabled": true|false}` — per-request log opt-in/out |
| `x-tfy-cache-config` | exact/semantic cache config (see §2.7) |
| `x-tfy-mcp-headers` | pass per-request headers to MCP servers |

**Response headers:**

| Header | Purpose |
|---|---|
| `x-tfy-resolved-model` | The **actual** model that served the request after load balancing/fallback |
| `x-tfy-applied-configurations` | Dict of applied load-balancing/fallback/guardrail/rate-limit configs |
| `x-tfy-feedback-target-id` | Opaque ID of the trace root span — use with the feedback API (§6.3) |
| `x-tfy-cache-status` / `x-tfy-cached-trace-id` / `x-tfy-cache-similarity-score` | Cache outcome |
| `server-timing` | (non-streaming) per-stage timing: authentication, input guardrails, model call, output guardrails, logging, load balancing, rate limiting, cost budget |
| `provider` field in response body | Which upstream provider served the request (v0.136) |

### 2.10 Performance claims

From TrueFoundry's published benchmarks ("Why the TrueFoundry LLM Gateway Is Blazing Fast" and
the docs FAQ):

- Latency overhead "minimal, typically **less than 5 ms**"; benchmark blog reports **~3 ms added
  latency at up to 250 RPS** and ~4 ms past 300 RPS on a single **1 vCPU / 1 GB** pod.
- A single 1 vCPU/1 GB pod sustains **~250 RPS**, degrading only past ~350 RPS; a t2.2xlarge spot
  instance (~$43/mo) sustains **~3000 RPS**.
- SaaS gateway is multi-region for low latency and HA; overhead stays low with auth, rate-limit,
  and load-balancing rules applied.

---

## 3. Latest changes (2025–2026)

Verified against the official changelog: <https://www.truefoundry.com/docs/changelog>
(Helm-versioned releases; selected gateway-relevant highlights, newest first.)

### 2026

- **v0.146.6 (May 22, 2026)** — **Skills registry GA** (register/manage agent skills). Agent max
  execution time enforcement (default 1 h). Latency-based routing became deterministic
  sticky-per-epoch. Provider `discount_percent` for cost calc. Anthropic 1-hour extended cache
  writes billed separately. **Guardrail metrics queryable via the flexible metrics API**
  (`guardrailMetrics` datasource).
- **v0.144.0 (May 18, 2026)** — Agent file uploads; tenant-wide guardrail settings; image-token
  pricing split from text; client disconnects return 499 and short-circuit LB retries;
  external-JWT → user/virtual-account mapping; CrowdStrike AIDR guardrail; **quarterly budget
  limits**; identity & access revamp (multiple roles per user, roles for teams).
- **v0.142.3 (May 6, 2026)** — Guardrails moderate tool-call inputs/outputs across Bedrock,
  Gemini, Messages adapters; `anthropic_beta` header forwarding to Bedrock/Vertex.
- **v0.141.1 (Apr 30, 2026)** — **Custom Endpoints provider** (bring-your-own inference endpoint
  as a first-class provider); Vertex multi-region (`us`/`eu`/`global`); Smallest AI TTS/STT.
- **v0.139.4 (Apr 27, 2026)** — **OpenAI Responses API support**; **end-to-end request tracing
  extended to all provider operation endpoints** (batches, files, fine-tuning, images,
  moderation); **OTel metrics export enabled by default** (`ENABLE_OTEL_METRICS_EXPORTER`);
  MCP elicitation for remote servers; auto-deploy of stdio MCP servers; guardrail scoping to
  individual MCP tools; Claude Code Max support.
- **v0.136.6 (Apr 9, 2026)** — **Breaking: all gateway metrics renamed `llm_gateway_*` →
  `ai_gateway_*`**; `provider` field added to responses; trace search made faster.
- **v0.135.4 (Apr 7, 2026)** — TrojAI DEFEND guardrail; PagerDuty budget alerts;
  Gemini/Vertex thinking tokens included in completion-token accounting.
- **v0.133.3 (Mar 27, 2026)** — Baseten provider; per-user MCP auth overrides; **`metadata_match`
  on virtual-model targets**; TLS/proxy for remote MCP; **Breaking: `x-tfy-routing-config`
  request header removed** (migrate to Virtual Models).
- **v0.132.5 (Mar 24, 2026)** — **Sticky routing for virtual models**; MCP guardrails on SSE
  streams; new MCP Gateway endpoint format (v0.130 breaking change); playground snippets for
  Pydantic-AI, Agno, CrewAI, Instructor, OpenAI Agents, Strands, Codex; simplified GitOps
  `tfy apply --diffs-only`.
- **v0.127.3 (Mar 10, 2026)** — **TTFT-based timeout header `x-tfy-ttft-timeout-ms`**.
- **v0.126.2 (Mar 9, 2026)** — **Overview metrics dashboard**; model verification at integration
  time; live/realtime API for Gemini/OpenAI/Azure; **AI Gateway tracing performance improved to
  show live logs without delay**.
- **v0.125.10 (Mar 2, 2026)** — Groq TTS/STT; Gemini realtime models; OpenAI `compaction` API.
- **v0.122.3 (Feb 24, 2026)** — TTS/STT for ElevenLabs, Cartesia, Deepgram, Vertex, Gemini.
- **v0.117–0.118 (early Feb 2026)** — **TrueFoundry-managed guardrails launched** (PII, prompt
  injection, moderation, secrets, regex, SQL sanitizer, code linter); guardrail YAML schema
  change (v0.116).
- **v0.116.3 (Feb 1, 2026)** — **Data Access Rules for request logs/metrics** (who can see which
  traces) and **Data Routing Rules** (route request logs to specific storage destinations —
  relevant for `data_routing_destination` in the spans query API).
- **v0.115.2 (Jan 23, 2026)** — multi-subagent queries.
- **v0.113.2 (Jan 16, 2026)** — **TrueFoundry Agent Hub** introduced.
- **v0.110.3 (Jan 5, 2026)** — **OAuth inbound auth for MCP Gateway**.

### Late 2025

- **v0.109.3 (Dec 22, 2025)** — SCIM support; **improved rate-limit config**
  (`rate_limit_applies_per`, static rule IDs — breaking).
- Through Q3–Q4 2025: MCP server registry & MCP gateway buildout, virtual MCP servers, agents
  API (`/agent/responses`), prompt management, the request-logs spans Query API, and the OTel
  exporter integrations (Datadog, New Relic, Dynatrace, Splunk, SigNoz, Honeycomb, Arize,
  LangSmith, Traceloop, ClickStack, …).

**Deprecations to watch:** global Routing Config (use Virtual Models), MCP servers in prompts,
built-in common tools (removed after May 15, 2026), old MCP gateway URL format (v0.130), Pangea
guardrails (use CrowdStrike AIDR), dynamic rate-limit rule IDs.

---

## 4. Getting started

### 4.1 Signup / self-host

- **SaaS**: register at <https://www.truefoundry.com/register> (free Developer tier, §8). Add a
  provider account (OpenAI, Anthropic, Bedrock, …) with your provider credentials under
  **Integrations**; multiple accounts per provider are supported. Models can be verified at
  integration time before being exposed.
- **Self-host**: install the `truefoundry` (control plane) and `tfy-llm-gateway` Helm charts on
  any Kubernetes cluster (AWS/GCP/Azure/on-prem/OpenShift). A gateway-plane-only install (control
  plane stays TrueFoundry-hosted) is also supported — docs:
  <https://www.truefoundry.com/docs/ai-gateway/install-only-llm-gateway>.

### 4.2 API keys

Two token types (created in the dashboard under **Access**):

- **Personal Access Token (PAT)** — tied to your user; for local dev. (Becomes invalid if the
  user leaves the org — don't ship to prod.)
- **Virtual Account Token (VAT)** — tied to a non-user identity with its own RBAC and tags;
  recommended for production apps, CI/CD, shared services. Virtual-account tags flow into request
  metadata (usable in routing/limits).

Everything you need (base URL, model ID, key) is shown pre-filled in **Playground → Code**
snippets (formats: OpenAI SDK, LangChain, LangGraph, Google ADK, Stream API, REST, Go-OpenAI,
Rust-OpenAI, cURL, Node.js, LlamaIndex, Langchain4j, plus agent frameworks).

### 4.3 OpenAI SDK — Python

```python
from openai import OpenAI

client = OpenAI(
    api_key="your-truefoundry-api-key",
    base_url="https://gateway.truefoundry.ai",
)

response = client.chat.completions.create(
    model="openai-main/gpt-4o-mini",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

Or via environment variables (any OpenAI-compatible tool then works unchanged):

```bash
export OPENAI_BASE_URL="https://gateway.truefoundry.ai"
export OPENAI_API_KEY="your-truefoundry-api-key"
```

### 4.4 OpenAI SDK — TypeScript / Node.js

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
    apiKey: 'your_truefoundry_api_key',
    baseURL: 'https://gateway.truefoundry.ai',
    defaultHeaders: {
        "X-TFY-METADATA": '{"application":"flight-recorder","environment":"dev"}',
        "X-TFY-LOGGING-CONFIG": '{"enabled": true}',
    },
});

const response = await client.chat.completions.create({
    model: 'openai-main/gpt-4o-mini',
    messages: [{ role: 'user', content: 'Hello' }],
});
console.log(response.choices[0].message.content);
```

### 4.5 Anthropic SDK (native `/messages` support)

```python
from anthropic import Anthropic

BASE_URL = "https://gateway.truefoundry.ai"
API_KEY = "your-truefoundry-api-key"

client = Anthropic(
    api_key=API_KEY,
    base_url=BASE_URL,
    default_headers={
        "Authorization": f"Bearer {API_KEY}"   # gateway auth header required
    }
)

response = client.messages.create(
    model="anthropic-main/claude-4-sonnet",   # tfy model name
    max_tokens=1024,
    messages=[{"role": "user", "content": "Explain quantum computing simply."}]
)
print(response.content)
```

### 4.6 cURL

```bash
curl https://gateway.truefoundry.ai/chat/completions \
  -H "Authorization: Bearer your_truefoundry_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai-main/gpt-4o-mini",
    "messages": [{"role": "user", "content": "Hello"}]
  }'
```

(Provider-prefixed paths like `/openai/chat/completions` also appear in docs examples; the plain
`/chat/completions` path with the `provider_account/model` ID is the canonical form.)

### 4.7 Model discovery

```python
models = client.models.list()          # OpenAI SDK against the gateway
for m in models.data:
    print(m.id)                        # e.g. "openai-main/gpt-4o-mini"
```

Returns only models your PAT/VAT has been granted; OpenAI-compatible response shape.

---

## 5. Observability & logging

This is the section that matters most for the flight recorder. The gateway's design: **every
request generates a trace** (root span + child spans for guardrails, model call, MCP tool calls),
stored by TrueFoundry (or in *your* blob storage/parquet under deployment options 2–4), viewable
in the UI, **queryable via API/SDK**, and **exportable via OTLP**.

### 5.1 What is logged per request (span attributes)

Reference: <https://www.truefoundry.com/docs/ai-gateway/fetch-request-logs-span-attributes>

Core:

| Attribute | Meaning |
|---|---|
| `tfy.span_type` | `ChatCompletion`, `Completion`, `MCP`, `Rerank`, `Embedding`, `Model`, `AgentResponse`, `Guardrail` |
| `tfy.input` / `tfy.output` | **Complete input and output payloads** (model, MCP server, guardrail) |
| `tfy.input_short_hand` | Abbreviated input for display |
| `tfy.error_message` | Error message if failed |
| `tfy.prompt_version_fqn`, `tfy.prompt_variables` | Prompt-management info |
| `tfy.triggered_guardrail_fqns` | Guardrails triggered |

Request context:

| Attribute | Meaning |
|---|---|
| `tfy.request.model_name` | Requested model |
| `tfy.request.created_by_subject` / `…_teams` | Caller identity / teams |
| `tfy.request.metadata` | Your `x-tfy-metadata` payload |
| `tfy.request.conversation_id` | Conversation ID |

Model + **performance metrics** (the latency/token/cost goldmine):

| Attribute | Meaning |
|---|---|
| `tfy.model.id` / `.name` / `.fqn` / `.request_url` | Resolved model identity & endpoint |
| `tfy.model.streaming` | Streaming or not |
| `tfy.model.request_type` | `ChatCompletion`, `Embedding`, `AgentResponse`, `MCPGateway`, … |
| `tfy.model.metric.latency_in_ms` | **Total request latency** |
| `tfy.model.metric.time_to_first_token_in_ms` | **TTFT** (streaming) |
| `tfy.model.metric.inter_token_latency_in_ms` | **Avg inter-token latency** (streaming) |
| `tfy.model.metric.input_tokens` / `.output_tokens` | Token counts |
| `tfy.model.metric.cost_in_usd` | **Cost in USD** |
| `tfy.model.metric.cache_read_input_tokens` / `.cache_creation_input_tokens` | Provider prompt-cache accounting |

Policy attribution: `applied_loadbalance_rule_ids`, `applied_budget_rule_ids`,
`applied_ratelimit_rule_ids`.

MCP spans: `tfy.mcp_server.{id,name,url,fqn,server_name,method,primitive_name,error_code,
is_tool_call_execution_error}` + `tfy.mcp_server.metric.latency_in_ms`,
`tfy.mcp_server.metric.number_of_tools`.

Guardrail spans: `tfy.guardrail.{id,name,fqn,result}` (`pass|mutate|flag`), applied-entity info,
`tfy.guardrail.metric.latency_in_ms`. Plus `http.response.status_code`.

### 5.2 Controlling what gets logged

Docs: <https://www.truefoundry.com/docs/ai-gateway/request-logging>

- Per-request header: `X-TFY-LOGGING-CONFIG: {"enabled": true|false}` (stringified JSON).
- Global setting: `HEADER_CONTROLLED` (default: log unless header says no) / `ALWAYS` / `NEVER`.
- Logs visible in UI under **AI Gateway → Monitor → Requests**, with filtering by time, user,
  model, virtual account, trace ID, metadata keys.
- **Data Access Rules** (v0.116) gate who can read which traces; **Data Routing Rules** choose
  the storage destination per subset of traffic.

### 5.3 Getting per-request data out programmatically (Query Spans API)

Docs: <https://www.truefoundry.com/docs/ai-gateway/fetch-request-logs> — this is the
flight-recorder-relevant pull path.

**TrueFoundry Python SDK:**

```python
from truefoundry import client

# Fetch LLM Gateway request logs (spans)
spans = client.traces.query_spans(
    data_routing_destination="default",
    start_time="2026-06-01T00:00:00.000Z",
)

for span in spans:
    print(span.span_name, span.span_attributes.get('tfy.span_type'))
```

(Install/auth via the TrueFoundry CLI setup guide:
<https://www.truefoundry.com/docs/setup-cli>. The `tracing_project_fqn` is shown via the
"Fetch via API" button on the Request Logs page.)

**Raw HTTP API** (`POST /api/svc/v1/spans/query` on the control plane, paginated):

```python
import requests

page_token = None
done = False
while not done:
    response = requests.post(
        "https://{control_plane_url}/api/svc/v1/spans/query",
        headers={
            "Authorization": "Bearer YOUR_API_TOKEN",
            "Content-Type": "application/json"
        },
        json={
            "dataRoutingDestination": "default",
            "startTime": "2026-06-01T00:00:00",
            "pageToken": page_token
        }
    )
    response.raise_for_status()
    data = response.json()

    for span in data['data']:
        print(span['spanName'], span['spanAttributes'].get('tfy.span_type', ''))

    page_token = data['pagination'].get("nextPageToken")
    done = page_token is None
```

Companion pages document **trace inspection** (single trace + span hierarchy), **filtering** (by
time, user, trace ID, metadata), and advanced queries (model spans, MCP spans). API reference:
"Get Filtered Spans Data With Detailed Attributes" under
<https://www.truefoundry.com/docs/api-reference/traces/get-filtered-spans-data-with-detailed-attributes>.

### 5.4 Metrics dashboard

Docs: <https://www.truefoundry.com/docs/ai-gateway/analytics>

Tabs: Overview / Model Metrics / MCP Metrics / Guardrails / Routing / Caching. All support
time-range, filters (model, user, virtual account, team, **custom metadata keys**), and a
"View by" pivot (Models, Virtual Models, Users, Virtual Accounts, Teams, Metadata).

- Counters: total cost, LLM calls, MCP calls, input/output tokens, with period-over-period.
- Performance: RPS, failure rate (by error type / status code).
- **Latency charts with P50/P75/P90/P99**: request latency, **TTFT**, **inter-token latency
  (ITL)**, **time per output token (TPOT)**.
- Cost of inference over time; token volumes; top models/providers/users/virtual accounts/MCP
  servers/tools leaderboards; per-endpoint traffic split (`/chat/completions`, `/messages`,
  `/agent/responses`, `/mcp-server`, …).
- Guardrail evaluations with blocked/flagged/mutated outcomes; guardrail metrics also queryable
  through the flexible metrics API (`guardrailMetrics`, v0.146).

### 5.5 OpenTelemetry export (traces + metrics)

Docs: <https://www.truefoundry.com/docs/ai-gateway/export-opentelemetry-data>

The gateway is **OTEL-compliant**. Two independent exporters configured in
**AI Gateway → Controls → Settings → OTEL Config**:

- **OTEL Traces Exporter** — OTLP HTTP or gRPC, `proto` or `json` encoding, custom headers
  (auth). Sends spans to any OTLP backend *in addition to* TrueFoundry's own storage.
- **OTEL Metrics Exporter** — same editor, separate endpoint; **enabled by default since
  v0.139** (env `ENABLE_OTEL_METRICS_EXPORTER`). Example: Datadog OTLP intake needs
  `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=Delta` on the `tfy-llm-gateway` deployment
  plus `dd-api-key` / `dd-otel-metric-config` headers; metric names look like
  `ai_gateway_request_processing_ms` (renamed from `llm_gateway_*` in v0.136).
- Self-hosted gateways also expose a Prometheus-scrapable `/metrics` endpoint — see
  <https://www.truefoundry.com/docs/ai-gateway/prometheus-grafana-integration>.

Documented exporter integrations: **Traceloop (OpenLLMetry)**, Arize, Axiom, **ClickStack
(ClickHouse)**, Coralogix, CoreWeave Weave, Dash0, Datadog, Dynatrace, Elastic, Grafana Cloud,
Honeycomb, HoneyHive, Laminar, LangSmith, LangWatch, Last9, Lunary, Middleware, New Relic,
OpenLIT, PromptLayer, Pydantic Logfire, SigNoz, Splunk Observability Cloud.

### 5.6 ClickStack / ClickHouse export (directly relevant to us)

Docs: <https://www.truefoundry.com/docs/ai-gateway/clickstack>

TrueFoundry documents an end-to-end flow shipping gateway traces into **ClickHouse**:

```text
[TrueFoundry AI Gateway]
        ↓ OTLP HTTP (json)
[ClickStack OTEL Collector :4318 /v1/traces]
        ↓
[ClickHouse Cloud :8443]
        ↓
[ClickStack UI (HyperDX)]
```

```bash
docker run -d \
  --name clickstack-otel-collector \
  -p 4317:4317 \
  -p 4318:4318 \
  -e CLICKHOUSE_ENDPOINT=https://<clickhouse-endpoint>:8443 \
  -e CLICKHOUSE_USER=default \
  -e CLICKHOUSE_PASSWORD=<password> \
  clickhouse/clickstack-otel-collector:latest
```

Then in TrueFoundry: OTEL Config → enable Traces Exporter → HTTP → endpoint
`https://<domain>/v1/traces` → encoding **Json** → header `Content-Type: application/json`.
Spans arrive with `ServiceName = tfy-llm-gateway`. For the flight recorder we could either reuse
the ClickStack collector schema or run our own OTLP collector writing to our ClickHouse tables.

### 5.7 Storing raw request/response data in your own bucket

Under deployment options 2–4 (§4.1 / §8), the full request–response data is written to **your S3
/ GCS / Azure / S3-compatible bucket in parquet format** — explicitly intended for "analytics,
debugging and evaluation via Spark, DuckDB, Athena or any tool of your choice." Custom
S3-compatible stores for tracing/data routing were added in v0.134 (Mar 2026).

---

## 6. Tracing & evals

### 6.1 Gateway-native tracing

Tracing is built into the gateway rather than being a separate SDK product: every gateway request
produces a trace with the span taxonomy in §5.1, browsable in the UI (span hierarchy, raw data),
queryable via the spans API, and exportable via OTLP. v0.126 (Mar 2026) made trace ingestion
fast enough to "show live logs without delay"; v0.139 extended tracing coverage to every provider
operation endpoint (batches, files, fine-tuning, images, moderation). There is also a tracing
concepts overview at `/docs/tracing/overview` referenced by the request-logs docs, and Agent
Harness runs emit end-to-end traces per agent run (LLM calls, tool calls, sandbox executions,
subagents) with cost/tokens/latency per step.

### 6.2 Traceloop / OpenLLMetry integration

Docs: <https://www.truefoundry.com/docs/ai-gateway/traceloop>

Export gateway traces to Traceloop (built on OpenLLMetry, `gen_ai` semantic conventions):
endpoint `https://api.traceloop.com/v1/traces`, HTTP + Proto encoding, header
`Authorization: Bearer <traceloop-key>`. Note: Traceloop ingests **traces only**; token/latency/
cost metrics are derived from span attributes — keep the metrics exporter disabled for it.
Similar guides exist for LangSmith, Arize, Laminar, LangWatch, Lunary, HoneyHive, OpenLIT,
PromptLayer, Pydantic Logfire, etc.

### 6.3 Feedback API (human eval signal)

Docs: <https://www.truefoundry.com/docs/ai-gateway/feedback-for-traces>

Every gateway response carries `x-tfy-feedback-target-id` (identifies the trace root span).
You can attach a 1–5 rating + comment + metadata:

```python
import requests

response = requests.post(
    "https://{control_plane_url}/api/svc/v1/gateway-feedback",
    headers={"Authorization": "Bearer YOUR_API_TOKEN", "Content-Type": "application/json"},
    json={
        "target": {"feedbackTargetId": "<value of x-tfy-feedback-target-id>"},
        "rating": 4,
        "comment": "Optional comment",
        "metadata": {"key": "value"}
    }
)
```

Feedback is shown alongside the span in the trace view (`tfyGatewayFeedbacks` in raw data) and is
PUT/DELETE-able by feedback ID. There is no separate "evals" product; evals are served by this
feedback mechanism + the metadata/metrics pivots + exporting data to eval platforms (LangSmith,
Arize, HoneyHive…) or to your own bucket in parquet.

---

## 7. Model deployment (brief)

Docs: <https://www.truefoundry.com/docs/deploying-an-llm-model-from-the-model-catalogue>

The AI Engineering side deploys LLMs on your own GPUs/Kubernetes:

- **Model servers: vLLM, SGLang, and TRT-LLM** — pick per model; deploy from a model catalogue or
  by **pasting a HuggingFace URL** (TrueFoundry infers the optimal GPU + deployment config).
- **Model caching** (weights cached + mounted to pods → fast startup/autoscale), **image
  streaming** (~3× faster vLLM/SGLang image pulls), **sticky routing** for KV-cache reuse,
  **RPS-based autoscaling**, **scale-to-zero**, built-in GPU metrics (utilization, temp, memory).
- Deployed LLMs expose OpenAI-compatible `/v1/chat/completions` & `/v1/completions` and can be
  added to the AI Gateway in one click as **self-hosted models** — so the flight recorder would
  see self-hosted and SaaS models through the exact same gateway API.
- The gateway is usable standalone; the deployment platform is optional.

---

## 8. Pricing & free tier

From <https://www.truefoundry.com/pricing> (June 2026; verify before quoting — SaaS pricing):

| Tier | Price | Includes |
|---|---|---|
| **Developer (free)** | $0/mo | 50k gateway requests/mo, 3 users, universal API, community support; MCP: 5 servers / 50k tool calls; 10 saved prompts |
| **Pro** | $499/mo | 1M requests/mo, 10 users; adds RBAC on models, multiple gateway endpoints, **semantic caching**, weight/latency/priority routing, budget & rate limiting; +$499 per extra 2M requests & 5 API keys; MCP: 25 servers / 1M calls |
| **Pro Plus** | $2,999/mo | 1M requests/mo, 25 users, stricter data controls; MCP: 50 servers / 5M calls |
| **Enterprise** | Custom | 10M+ requests/mo, unlimited users, priority support, full self-hosting options |

Self-hosting infra cost guidance: gateway plane only ≈ **$600/mo**, control + gateway plane ≈
**$800–1,000/mo** (your cloud bill; Enterprise pricing tier). SaaS data-in-your-bucket option
costs only your S3 storage. Compliance: SOC2, ISO27001, GDPR, HIPAA.

---

## 9. Relevance to Agent Flight Recorder

How TrueFoundry maps onto our harness if we use it as the inference path:

1. **Single recording choke-point.** Point the agent's OpenAI/Anthropic SDK at
   `https://gateway.truefoundry.ai` and every model call (any provider, self-hosted included) is
   captured with full input/output (`tfy.input`/`tfy.output`), latency, TTFT, ITL, tokens, and
   USD cost — without us instrumenting each provider client.
2. **ClickHouse-native export.** The documented ClickStack integration (§5.6) ships gateway spans
   to ClickHouse over OTLP/HTTP JSON. We can point the exporter at our own collector and land
   spans in our existing ClickHouse schema, or batch-pull via the spans Query API (§5.3).
3. **Replay/diff correlation.** Tag every recorded step with
   `x-tfy-metadata: {"run_id": "...", "step": "..."}`; metadata round-trips into
   `tfy.request.metadata` on spans and is filterable in the logs API. Capture
   `x-tfy-resolved-model` per response so a replay can pin the *actual* model that served the
   original request (critical when virtual-model routing/fallback is active). The
   `x-tfy-cached-trace-id` header links cache hits back to the originating trace.
4. **Deterministic-ish replay aids.** Exact-match caching (`x-tfy-cache-config:
   {"type":"exact-match"}` with a long TTL + a per-run `namespace`) effectively gives
   record-once/replay-many of model responses at the gateway layer — worth evaluating as a
   replay mechanism vs. our own response store. Per-target `override_params` and virtual models
   keep model config out of agent code.
5. **Tool calls too.** If agent tools go through the MCP Gateway, tool-call spans
   (`tfy.span_type: "MCP"`, latency, errors, method, tool name) land in the same trace stream as
   model calls — one timeline for the whole agent step.
6. **Caveats.** The spans Query API is pull-based via the control plane (pagination, slight
   ingest delay — "live" since v0.126); for strictly-ordered real-time capture our own
   wrapper should still record locally, with TrueFoundry as the authoritative cost/latency
   source and cross-check. Free tier (50k req/mo) is plenty for a hackathon.

---

## 10. Links

**Product / marketing**

- AI Gateway: <https://www.truefoundry.com/ai-gateway>
- MCP Gateway: <https://www.truefoundry.com/mcp-gateway>
- Agent Gateway: <https://www.truefoundry.com/agent-gateway>
- Tracing/observability: <https://www.truefoundry.com/tracing>
- Pricing: <https://www.truefoundry.com/pricing> · Register: <https://www.truefoundry.com/register>

**Docs (all serve raw markdown at `…​.md`)**

- Docs index (llms.txt): <https://www.truefoundry.com/docs/llms.txt>
- Gateway intro: <https://www.truefoundry.com/docs/ai-gateway/intro-to-llm-gateway>
- Quick start: <https://www.truefoundry.com/docs/ai-gateway/quick-start>
- Making your first request: <https://www.truefoundry.com/docs/ai-gateway/making-llm-requests-via-gateway>
- Authentication: <https://www.truefoundry.com/docs/ai-gateway/authentication> · API keys: <https://www.truefoundry.com/docs/generating-truefoundry-api-keys>
- Native SDK support (OpenAI/Anthropic/Google/boto3): <https://www.truefoundry.com/docs/ai-gateway/native-sdk-support>
- Model discovery: <https://www.truefoundry.com/docs/ai-gateway/model-discovery>
- Virtual models (routing/LB/fallback): <https://www.truefoundry.com/docs/ai-gateway/virtual-model>
- Routing config (legacy): <https://www.truefoundry.com/docs/ai-gateway/load-balancing-overview>
- Rate limiting: <https://www.truefoundry.com/docs/ai-gateway/ratelimiting>
- Budget limiting: <https://www.truefoundry.com/docs/ai-gateway/budgetlimiting>
- Caching: <https://www.truefoundry.com/docs/ai-gateway/caching>
- Guardrails: <https://www.truefoundry.com/docs/ai-gateway/guardrails-overview>
- Headers & metadata: <https://www.truefoundry.com/docs/ai-gateway/request-headers>
- Request logging: <https://www.truefoundry.com/docs/ai-gateway/request-logging>
- Spans Query API: <https://www.truefoundry.com/docs/ai-gateway/fetch-request-logs> · Span attributes: <https://www.truefoundry.com/docs/ai-gateway/fetch-request-logs-span-attributes>
- Metrics dashboard: <https://www.truefoundry.com/docs/ai-gateway/analytics>
- OTel export: <https://www.truefoundry.com/docs/ai-gateway/export-opentelemetry-data>
- **ClickStack/ClickHouse export**: <https://www.truefoundry.com/docs/ai-gateway/clickstack>
- Prometheus/Grafana: <https://www.truefoundry.com/docs/ai-gateway/prometheus-grafana-integration>
- Traceloop export: <https://www.truefoundry.com/docs/ai-gateway/traceloop>
- Feedback API: <https://www.truefoundry.com/docs/ai-gateway/feedback-for-traces>
- MCP Gateway overview: <https://www.truefoundry.com/docs/ai-gateway/mcp/mcp-overview>
- Agent Harness: <https://www.truefoundry.com/docs/ai-gateway/agent-harness/overview>
- Deployment options: <https://www.truefoundry.com/docs/ai-gateway/modes-of-deployment> · Gateway plane architecture: <https://www.truefoundry.com/docs/platform/gateway-plane-architecture>
- Deploying LLMs (vLLM/SGLang/TRT-LLM): <https://www.truefoundry.com/docs/deploying-an-llm-model-from-the-model-catalogue>
- **Changelog**: <https://www.truefoundry.com/docs/changelog> · Change announcements: metrics rename <https://www.truefoundry.com/docs/change-announcements/refactoring-of-ai-gateway-metrics>, routing header removal <https://www.truefoundry.com/docs/change-announcements/routing-config-header-removal-v0.133>, MCP URL change <https://www.truefoundry.com/docs/change-announcements/mcp-gateway-url-transport-v0.130>, identity revamp <https://www.truefoundry.com/docs/change-announcements/identity-and-access-revamp-v0.143>

**Blog (performance & background)**

- "Why the TrueFoundry LLM Gateway Is Blazing Fast": <https://www.truefoundry.com/blog/truefoundry-llm-gateway-is-blazing-fast>
- "How should Enterprises evaluate LLM Gateway for Scale?": <https://www.truefoundry.com/blog/how-should-enterprises-evaluate-llm-gateway-for-scale>
- "Observability in AI Gateways": <https://www.truefoundry.com/blog/observability-in-ai-gateway>
- "What is an AI Gateway? (2026)": <https://www.truefoundry.com/blog/ai-gateway> · "What is an Agent Gateway? (2026)": <https://www.truefoundry.com/blog/agent-gateway>
