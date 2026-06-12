# Composio — Integration Guide for Agent Flight Recorder

> Researched against live Composio docs, changelog, blog, npm/PyPI — **June 2026**.
> Current SDKs: **`composio` (Python, v0.13.x)** and **`@composio/core` (TypeScript, v0.10.x)** — the "next-generation" (v3) SDKs. The legacy `composio-core` / `composio_core` v1 SDKs are deprecated and the legacy `/api/v1` and `/api/v2` REST endpoints now return **HTTP 410 Gone** (removed June 2026). Build only against v3/v3.1.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Latest changes (2025–2026)](#2-latest-changes-20252026)
3. [Getting started](#3-getting-started)
4. [Authentication & connected accounts](#4-authentication--connected-accounts)
5. [Sessions (the recommended entry point)](#5-sessions-the-recommended-entry-point)
6. [Executing tools](#6-executing-tools)
7. [LLM framework providers (full examples)](#7-llm-framework-providers-full-examples)
8. [Tool execution lifecycle & hooks (modifiers, custom tools)](#8-tool-execution-lifecycle--hooks)
9. [Triggers & webhooks](#9-triggers--webhooks)
10. [MCP support](#10-mcp-support)
11. [Record/replay patterns for the Flight Recorder](#11-recordreplay-patterns-for-the-flight-recorder)
12. [Links & sources](#12-links--sources)

---

## 1. Overview

**Composio** is a tool/integration platform for AI agents. It provides:

- **1,000+ toolkits** (integrations: Gmail, GitHub, Slack, Notion, Linear, Google Calendar, HubSpot, …) exposing **20,000+ tools** (individual API actions, e.g. `GITHUB_LIST_STARGAZERS`, `GMAIL_SEND_EMAIL`).
- **Managed authentication** — OAuth2, API key, Bearer, Basic, and custom schemes, with token storage/refresh handled by Composio.
- **Tool Router / sessions** — a dynamic tool-search layer (originating from their consumer product **Rube**, GA since ~Oct 2025) that surfaces only relevant tools to the model instead of dumping thousands of schemas into context.
- **Triggers** — webhook and polling listeners for external events (new email, new commit, Slack message…).
- **MCP servers** — every session exposes an MCP endpoint; standalone MCP servers can also be created.
- **A sandboxed workbench** — remote code-execution sandbox available inside sessions.

### Core concepts (v3 terminology)

The v3 SDKs renamed everything. The old → new mapping matters because most blog posts/AI training data use v1 terms:

| Concept | v3 term | Old (v1) term | Notes |
|---|---|---|---|
| One callable API action | **Tool** | Action | Identified by a **slug**, e.g. `GITHUB_CREATE_AN_ISSUE` |
| Group of tools for one app | **Toolkit** | App | Slug, e.g. `github`, `gmail` |
| Auth blueprint for a toolkit | **Auth Config** (`ac_…`) | Integration | Defines auth method + scopes; one per (toolkit, environment, scope-set) |
| A user's authenticated link | **Connected Account** (`ca_…`) | Connection | Holds the actual credentials; has statuses (ACTIVE/INITIATED/EXPIRED/FAILED/INACTIVE) |
| End user identifier | **User ID** (`user_id`) | Entity ID | Free-form string — your app's user id/email. Mandatory on every execution |
| Main SDK class | **`Composio`** | ComposioToolSet | |
| Framework adapter | **Provider** | Toolset | e.g. `OpenAIProvider`, `AnthropicProvider`, `VercelProvider` |
| Tool middleware | **Modifiers** | Processors | `beforeExecute` / `afterExecute` / `schema` |
| Event listener instance | **Trigger** (`ti_…`) | Trigger | Trigger *type* (template) vs trigger *instance* (per connected account) |

IDs are nano-IDs with resource-type prefixes (`ca_8x9w2l3k5m`, `ac_1234567890`, `ti_So9EQf8XnAcy`, `we_…` for webhook endpoints) instead of v1 UUIDs.

### Two integration modes

1. **Native tools** — `session.tools()` returns tools formatted for your agent framework (via a Provider); your framework's agent loop executes them through Composio.
2. **MCP** — `session.mcp.url` + `session.mcp.headers` plug into any MCP-compatible client (Claude, OpenAI Agents, Cursor, custom MCP clients).

Docs guidance (2026): *"For most use cases, use a regular session… Sessions provide dynamic tool access and a much better MCP experience with context management handled by us."* Direct `composio.tools.get/execute` remains fully supported and is actually the better fit for a deterministic harness (see §11).

---

## 2. Latest changes (2025–2026)

### Next-generation SDKs (the "v3" generation)

- Announced in beta **July 1, 2025** ("Our new SDK is in beta", composio.dev blog); now the default documented path.
- Package renames: Python `composio-core` → **`composio`**; TypeScript `composio-core` → **`@composio/core`**.
- Current versions (June 2026): **`composio` 0.13.1** on PyPI (Python ≥3.9, Apache-2.0, released May 14 2026); **`@composio/core` 0.10.0** on npm (peer dep `zod ^3.25 || ^4`; depends on `@composio/client`, `pusher-js` for trigger subscriptions). Session preload/direct-tools features require ≥ `@composio/core` 0.9.0 / `composio` 0.13.0.
- Provider packages: Python `composio_<provider>` (`composio_openai`, `composio_anthropic`, `composio_langchain`, `composio_langgraph`, `composio_openai_agents`, `composio_crewai`, …); TypeScript `@composio/<provider>` (`@composio/openai`, `@composio/anthropic`, `@composio/vercel`, `@composio/langchain`, `@composio/openai-agents`, `@composio/mastra`, …).
- TypeScript SDK reached **full feature parity** with Python (modifiers, triggers, custom tools).
- Design changes: explicit over magic (e.g. multiple connected accounts per user now require an `allowMultiple` flag; `link()` aligned with `initiate()` duplicate guards in Apr 2026), per-call configuration scoping, nano-ID resources.

### Rube → Tool Router → Sessions

- **Rube** (mid-2025): consumer "jack-of-all-trades" MCP server that auto-picks app/tool.
- **Tool Router** (beta blog Oct 1, 2025; GA by May 2026): developer API for the same idea — pre-signed, per-user MCP session URLs plus **meta tools** (`COMPOSIO_SEARCH_TOOLS`, execute, manage-connections, workbench) so agents discover tools dynamically across 20k+ tools instead of receiving giant static schema lists. Composio frames it as "v0 of a skills framework."
- This is now surfaced in the SDK as **sessions** (`composio.create(user_id=…)` → `session.tools()` / `session.mcp.url`). May 2026 added: preloaded tools, `SESSION_PRESET_DIRECT_TOOLS` (narrow tool sets, meta tools off), `session.update()` for in-place reconfiguration, `composio.use(session_id)` for reuse, per-toolkit `connected_accounts` arrays.

### API & platform changes (2026 changelog highlights)

- **June 2026 security wave**: legacy `/v1` & `/v2` endpoints removed (410); **Proxy Execute disabled on v3 — use v3.1** (250 MB payload cap); MCP requests require an API key / `Authorization: Bearer`; scoped API keys rolling out (first preset: `proxyExecute`) + IP whitelisting; OAuth token redaction in API responses; per-IP rate limiting (429s); remote workbench (`COMPOSIO_REMOTE_WORKBENCH`, `COMPOSIO_REMOTE_BASH_TOOL`) only runs inside a Composio session; **webhook URLs must be publicly reachable** (loopback rejected) and **deliveries are signed** (verify `webhook-signature`); new `composio.trigger.disabled` event.
- **May 7, 2026 — Webhook Triggers V2**: dedicated `webhook_endpoints` resource with per-app ingress URLs (`/api/v3.1/webhook_ingress/{toolkit}/{we_xxx}/trigger_event`), HMAC-SHA256/Ed25519 ingress verification, timestamp replay protection, project-scoped OAuth apps, new Slack V2 trigger slugs.
- **Apr 27, 2026**: `POST /api/v3.1/connected_accounts/{id}/revoke` — explicit upstream credential revocation (`REVOKED` status).
- **June 9, 2026 — CLI 0.2.31**: legacy custom-tools APIs removed from both SDKs (use the `experimental` custom-tools API in §8.4); security bumps.
- "Platform" renamed to **"Dashboard"** in docs/UI (May 2026).

### Pricing (composio.dev/pricing, 2026)

| Plan | Price | Included | Overage |
|---|---|---|---|
| Free | $0/mo | 20K tool calls/mo, community support | — |
| Growth ("Ridiculously Cheap") | $29/mo | 200K tool calls/mo, email support | $0.299 / 1K calls |
| Scale ("Serious Business") | $229/mo | 2M tool calls/mo, Slack support | $0.249 / 1K calls |
| Enterprise | Custom | custom volume, SLA, SOC-2, VPC/on-prem | — |

---

## 3. Getting started

### Account & API key

1. Sign up at https://app.composio.dev (dashboard: https://dashboard.composio.dev).
2. Get an API key from **Dashboard → Project → Settings → API Keys** (https://dashboard.composio.dev/~/project/settings/api-keys). Note: scoped keys + IP whitelisting are available as of June 2026 — for the recorder use a key scoped to what the harness needs.

### Install

```bash
# Python (>=3.9)
pip install composio python-dotenv
# plus a provider for your LLM framework, e.g.:
pip install composio_openai openai
pip install composio_anthropic anthropic
pip install composio_langchain langchain langchain_openai
pip install composio_langgraph langgraph

# TypeScript / Node
npm install @composio/core
# plus a provider:
npm install @composio/openai openai
npm install @composio/anthropic @anthropic-ai/sdk
npm install @composio/vercel ai @ai-sdk/anthropic
npm install @composio/langchain @langchain/openai @langchain/langgraph @langchain/core
```

### Environment variables

```bash
# .env
COMPOSIO_API_KEY=...        # picked up automatically by both SDKs
OPENAI_API_KEY=...          # whichever LLM you use
ANTHROPIC_API_KEY=...
COMPOSIO_WEBHOOK_SECRET=... # only if you consume trigger webhooks
```

### Hello world (direct execution, no LLM)

```python
from composio import Composio

composio = Composio()  # reads COMPOSIO_API_KEY; or Composio(api_key="...")

result = composio.tools.execute(
    "HACKERNEWS_GET_LATEST_POSTS",   # tool slug
    user_id="user_123",
    arguments={"size": 5},
)
print(result)  # {"data": {...}, "error": None, "successful": True}
```

```typescript
import { Composio } from "@composio/core";

const composio = new Composio(); // reads COMPOSIO_API_KEY

const result = await composio.tools.execute("HACKERNEWS_GET_LATEST_POSTS", {
  userId: "user_123",
  arguments: { size: 5 },
});
console.log(result); // { data: {...}, error: null, successful: true }
```

---

## 4. Authentication & connected accounts

### Auth Configs

An **Auth Config** (`ac_…`) is the per-toolkit blueprint: auth method (OAuth2 / API key / Bearer / Basic / custom), scopes, and whose OAuth app credentials to use. Create them in the dashboard (**Auth Configs → Create**, https://dashboard.composio.dev/~/project/auth-configs) or via API (`POST /api/v3/auth_configs`). For dev you can use **Composio-managed** OAuth apps; for production supply your own client ID/secret. Create multiple configs per toolkit when you need different methods, scopes, or environments.

Inspect what an auth config requires:

```python
auth_config = composio.auth_configs.get("ac_your_config_id")
print(auth_config.auth_scheme)            # e.g. "OAUTH2"
print(auth_config.expected_input_fields)  # fields the user must supply
```

```typescript
const authConfig = await composio.authConfigs.get("ac_your_config_id");
console.log(authConfig.authScheme);
console.log(authConfig.expectedInputFields);
```

### OAuth flow (per user)

```python
from composio import Composio

composio = Composio(api_key="YOUR_COMPOSIO_API_KEY")

connection_request = composio.connected_accounts.initiate(
    user_id="user-1349-129-12",
    auth_config_id="ac_your_github_config",
    config={"auth_scheme": "OAUTH2"},
    callback_url="https://www.yourapp.com/callback",
)
print(f"Send the user here: {connection_request.redirect_url}")

# Polls until the user completes OAuth (optional timeout in seconds)
connected_account = connection_request.wait_for_connection(120)
print(f"Connected: {connected_account.id}")  # ca_...

# Or later, with only the connection id:
connected_account = composio.connected_accounts.wait_for_connection(connection_request.id, 60)
```

```typescript
import { Composio } from "@composio/core";

const composio = new Composio({ apiKey: "YOUR_COMPOSIO_API_KEY" });

const connRequest = await composio.connectedAccounts.initiate(
  "user_4567",
  "ac_your_github_config",
  { callbackUrl: "https://www.yourapp.com/callback" }
);
console.log(`Redirect URL: ${connRequest.redirectUrl}`);

const connectedAccount = await connRequest.waitForConnection(120_000); // ms
console.log(`Connected: ${connectedAccount.id}`);
```

After OAuth completes, Composio redirects to your callback with query params:
`?user_id=user_123&status=success&connected_account_id=ca_abc123` (`status` is `success` or `failed`).

### API-key / token auth (no redirect)

```python
connection_request = composio.connected_accounts.initiate(
    user_id="user_12323",
    auth_config_id="ac_your_config",
    config={"auth_scheme": "API_KEY", "val": {"api_key": user_api_key}},
)
print(f"Connected immediately: {connection_request.id}")
```

```typescript
import { Composio, AuthScheme } from "@composio/core";

const connectionRequest = await composio.connectedAccounts.initiate(
  "user12345678",
  "ac_your_config",
  { config: AuthScheme.APIKey({ api_key: userApiKey }) }
);
```

Some toolkits need extra parameters (e.g. Zendesk subdomain):

```typescript
const connRequest = await composio.connectedAccounts.initiate(userId, authConfigId, {
  config: AuthScheme.OAuth2({ subdomain: "mycompany" }),
});
```

### Managing many users / accounts

```python
# One Composio project serves all your users; everything is keyed by user_id.
accounts = composio.connected_accounts.list(
    user_ids=["user_123"],
    auth_config_ids=["ac_your_config"],
    statuses=["ACTIVE"],
)
for c in accounts.items:
    print(c.id, c.status)
```

| Status | Meaning |
|---|---|
| `ACTIVE` | Working; tools executable |
| `INITIATED` | OAuth started, awaiting user (≈10-min expiry) |
| `EXPIRED` | Credentials invalid; auto-refresh failed → re-auth |
| `FAILED` | Auth failed; check `status_reason` |
| `INACTIVE` | Manually disabled |
| `REVOKED` | Upstream tokens explicitly revoked via `/v3.1/connected_accounts/{id}/revoke` (new Apr 2026) |

Multiple accounts of the same toolkit for one user require explicit `allow_multiple=True` / `allowMultiple: true` on initiate/link — otherwise the SDK guards against silent duplicates (Apr 2026 change). Disambiguate at execution time with `connected_account_id`, or at session level with `connected_accounts={"gmail": ["ca_work_gmail"]}`.

Inside a session you can also just call `session.authorize("github")` to kick off auth, and agents using meta tools can trigger connection flows themselves (`COMPOSIO_MANAGE_CONNECTIONS`).

---

## 5. Sessions (the recommended entry point)

Sessions are the productized Tool Router: per-user, per-conversation scopes that bundle tool search (meta tools), auth state, custom tools, and an MCP endpoint.

```python
from composio import Composio, SESSION_PRESET_DIRECT_TOOLS

composio = Composio()

session = composio.create(
    user_id="user_123",
    toolkits=["github", "gmail", "slack"],            # or {"disable": ["exa"]}
    preload={"tools": ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"]},  # or "all"
    auth_configs={"github": "ac_your_github_config"},  # your own OAuth apps
    connected_accounts={"gmail": ["ca_work_gmail"]},   # pick account when user has several
    workbench={"enable": False},                       # disable code sandbox (or sandbox_size: "large")
    # session_preset=SESSION_PRESET_DIRECT_TOOLS,      # narrow static tool set, meta tools off
    # tools={"gmail": {"enable": ["GMAIL_FETCH_EMAILS"]}},  # used with direct-tools preset
)

tools = session.tools()          # native tools for your provider/framework
print(session.session_id)        # persist; reuse with composio.use(session_id)
print(session.mcp.url)           # MCP endpoint for this session
session.authorize("github")      # manual auth trigger
print(session.toolkits())        # toolkits + connection status
result = session.execute("GMAIL_FETCH_EMAILS", arguments={"max_results": 5})  # direct exec in session scope
```

```typescript
import { Composio } from "@composio/core";

const composio = new Composio();

const session = await composio.create("user_123", {
  toolkits: ["github", "gmail", "slack"],
  preload: { tools: ["GMAIL_FETCH_EMAILS", "GMAIL_CREATE_EMAIL_DRAFT"] },
});

const tools = await session.tools();
const sessionId = session.sessionId;          // store in DB for multi-turn
// later:
const restored = await composio.use(sessionId);
```

Notes:
- Each `create()` call generates a **new session id** (May 2026 change); reuse via `composio.use()`, reconfigure in place via `session.update()`.
- Default sessions include **meta tools**: `COMPOSIO_SEARCH_TOOLS` (structured search returning `primary_tool_slugs`, `related_tool_slugs`, `toolkits`, connection statuses, `task_difficulty`), plus execute / manage-connections / workbench meta tools. The agent searches → executes dynamically, so you don't ship 20k schemas to the model.
- Custom tools registered on a session get `LOCAL_`-prefixed slugs and are discoverable via `COMPOSIO_SEARCH_TOOLS`.
- Connected-account resolution priority: session overrides → auth-config overrides → existing auth → new managed auth.

**Sessions vs direct execution for a flight recorder:** sessions give dynamic discovery (great UX, less determinism — tool search results can change); direct `composio.tools.get/execute` with pinned tool slugs and toolkit versions gives maximum determinism. The recorder should *record* both, but replay is easiest against direct execution (§11).

---

## 6. Executing tools

Every execution requires a `user_id`. Three approaches:

### 6.1 Fetch tool schemas

```python
tools = composio.tools.get(
    user_id="user-k7334",
    tools=["GOOGLECALENDAR_EVENTS_LIST", "GITHUB_LIST_STARGAZERS"],  # by slug
    # or: toolkits=["github"], search="...", limit=10
)
```

```typescript
const tools = await composio.tools.get("user-k7334", {
  tools: ["GOOGLECALENDAR_EVENTS_LIST", "GITHUB_LIST_STARGAZERS"],
});
```

### 6.2 Execute a specific tool by slug (deterministic-replay-friendly)

This is the pattern the flight recorder replays against — no LLM involvement, fully parameterized:

```python
result = composio.tools.execute(
    "GITHUB_LIST_STARGAZERS",          # slug
    user_id="user-k7334",
    arguments={"owner": "ComposioHQ", "repo": "composio", "page": 1},
    # connected_account_id="ca_...",   # disambiguate multi-account users
    # version="20260101_00",           # pin toolkit version for stable schemas
)
# Response envelope:
# {
#   "data": {...},        # tool-specific payload
#   "error": None,        # error message if failed
#   "successful": True    # bool
# }
```

```typescript
const result = await composio.tools.execute("GITHUB_LIST_STARGAZERS", {
  userId: "user-k7334",
  arguments: { owner: "ComposioHQ", repo: "composio", page: 1 },
  // connectedAccountId: "ca_...",
});
if (!result.successful) throw new Error(result.error ?? "tool failed");
```

### 6.3 Let the LLM pick the tool

Fetch tools with a provider, hand them to the model, then execute whatever the model called via `provider.handle_tool_calls` (chat-completions style) or let an agentic framework auto-execute (OpenAI Agents, Vercel AI SDK, LangGraph). Full examples in §7.

### 6.4 Proxy execute (raw authenticated HTTP)

For endpoints Composio doesn't wrap as tools. **v3 proxy is disabled — requires v3.1 / current SDKs** (June 2026):

```python
response = composio.tools.proxy(
    endpoint="/repos/composiohq/composio/issues/1",
    method="GET",
    connected_account_id="ca_jI6...",   # required
)
```

### 6.5 Versioning & files

- **Toolkit versioning:** pin versions per init or per execution when you parse outputs programmatically (replay!); use `latest` only when an LLM consumes outputs.
- **File handling:** opt-in auto upload/download via `dangerously_allow_auto_upload_download_files=True`; Python also has a `@before_file_upload` modifier to audit local paths before upload (path-denylist protection against credential exfiltration is built in).

---

## 7. LLM framework providers (full examples)

The provider only changes the *format* of `session.tools()` / `composio.tools.get()` and supplies `handle_tool_calls`. Two provider styles:

- **Non-agentic** (OpenAI chat completions, Anthropic messages): you run the loop and call `handle_tool_calls` — *this is the natural interception point for recording*.
- **Agentic** (Vercel AI SDK, OpenAI Agents, LangChain/LangGraph): tools carry their own `execute`; the framework runs the loop — record via **modifiers** (§8) instead.

### 7.1 OpenAI

```bash
pip install composio composio_openai openai        # Python
npm install @composio/core @composio/openai openai  # TS
```

```python
from composio import Composio
from composio_openai import OpenAIProvider
from openai import OpenAI

openai_client = OpenAI()
composio = Composio(provider=OpenAIProvider())
session = composio.create(user_id="user_123")
tools = session.tools()   # OpenAI function-calling format

messages = [{"role": "user", "content": "Star ComposioHQ/composio on GitHub"}]
response = openai_client.chat.completions.create(
    model="gpt-5.2",
    tools=tools,
    messages=messages,
)

# Agentic loop: keep executing while the model emits tool calls
while response.choices[0].message.tool_calls:
    messages.append(response.choices[0].message)
    tool_results = composio.provider.handle_tool_calls(
        response=response,
        user_id="user_123",
    )
    messages.extend(tool_results)
    response = openai_client.chat.completions.create(
        model="gpt-5.2", tools=tools, messages=messages,
    )

print(response.choices[0].message.content)
```

```typescript
import OpenAI from "openai";
import { Composio } from "@composio/core";
import { OpenAIProvider } from "@composio/openai";

const openai = new OpenAI();
const composio = new Composio({ provider: new OpenAIProvider() });
const session = await composio.create("user_123");
const tools = await session.tools();

const messages: OpenAI.ChatCompletionMessageParam[] = [
  { role: "user", content: "Star ComposioHQ/composio on GitHub" },
];
let response = await openai.chat.completions.create({
  model: "gpt-5.2",
  tools,
  messages,
});

while (response.choices[0].message.tool_calls?.length) {
  messages.push(response.choices[0].message);
  const toolResults = await composio.provider.handleToolCalls("user_123", response);
  messages.push(...toolResults);
  response = await openai.chat.completions.create({ model: "gpt-5.2", tools, messages });
}
console.log(response.choices[0].message.content);
```

The OpenAI **Responses API** variant is the same shape but uses `client.responses.create()` and chains `previous_response_id`. The **OpenAI Agents SDK** uses `composio_openai_agents` / `@composio/openai-agents` and auto-executes (`Agent(name=..., tools=tools)`).

### 7.2 Anthropic Claude

```bash
pip install composio composio_anthropic anthropic
npm install @composio/core @composio/anthropic @anthropic-ai/sdk
```

```python
from anthropic import Anthropic
from composio import Composio
from composio_anthropic import AnthropicProvider

anthropic = Anthropic()
composio = Composio(provider=AnthropicProvider())
session = composio.create(user_id="user_123")
tools = session.tools()   # Anthropic tool-use format

messages = [{"role": "user", "content": "Fetch my 3 most recent emails"}]
response = anthropic.messages.create(
    model="claude-opus-4-6",
    max_tokens=2048,
    tools=tools,
    messages=messages,
)

while response.stop_reason == "tool_use":
    messages.append({"role": "assistant", "content": response.content})
    tool_results = composio.provider.handle_tool_calls(
        response=response,
        user_id="user_123",
    )
    messages.append({"role": "user", "content": tool_results})
    response = anthropic.messages.create(
        model="claude-opus-4-6", max_tokens=2048, tools=tools, messages=messages,
    )

print(response.content[0].text)
```

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { Composio } from "@composio/core";
import { AnthropicProvider } from "@composio/anthropic";

const anthropic = new Anthropic();
const composio = new Composio({ provider: new AnthropicProvider() });
const session = await composio.create("user_123");
const tools = await session.tools();

let messages: Anthropic.MessageParam[] = [
  { role: "user", content: "Fetch my 3 most recent emails" },
];
let response = await anthropic.messages.create({
  model: "claude-opus-4-6",
  max_tokens: 2048,
  tools,
  messages,
});

while (response.stop_reason === "tool_use") {
  messages.push({ role: "assistant", content: response.content });
  const toolResults = await composio.provider.handleToolCalls("user_123", response);
  messages.push({ role: "user", content: toolResults });
  response = await anthropic.messages.create({
    model: "claude-opus-4-6", max_tokens: 2048, tools, messages,
  });
}
```

There is also a **Claude Agent SDK** provider that wraps session tools with `create_sdk_mcp_server()` for `ClaudeSDKClient` (auto-executed), and the MCP route (§10) works with `mcp_servers` on the Anthropic API directly.

### 7.3 Vercel AI SDK

```bash
npm install @composio/core @composio/vercel ai @ai-sdk/anthropic
```

```typescript
import { anthropic } from "@ai-sdk/anthropic";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { generateText, stepCountIs } from "ai";

const composio = new Composio({ provider: new VercelProvider() });
const session = await composio.create("user_123");
const tools = await session.tools(); // AI SDK ToolSet — each tool has execute()

const { text } = await generateText({
  model: anthropic("claude-opus-4-6"),
  tools,
  prompt: "Create a GitHub issue titled 'replay drift' on ComposioHQ/composio",
  stopWhen: stepCountIs(10), // AI SDK v5 agent loop
});
console.log(text);

// Multi-turn: persist session.sessionId, restore with composio.use(sessionId)
```

The Vercel provider is **agentic**: tools include `execute`, the AI SDK runs the loop. To record, attach modifiers when fetching tools (§8) — there is no `handleToolCalls` call site to hook.

### 7.4 LangChain / LangGraph

```bash
pip install composio composio_langchain langchain langchain_openai     # LangChain (Py)
pip install composio composio_langgraph langgraph langchain_openai    # LangGraph (Py-only provider)
npm install @composio/core @composio/langchain @langchain/openai @langchain/langgraph @langchain/core
```

```python
# LangChain (Python)
from composio import Composio
from composio_langchain import LangchainProvider
from langchain.agents import create_agent
from langchain_openai import ChatOpenAI

composio = Composio(provider=LangchainProvider())
session = composio.create(user_id="user_123")
tools = session.tools()   # LangChain StructuredTool list

agent = create_agent(tools=tools, model=ChatOpenAI(model="gpt-5.2"))
result = agent.invoke({"messages": [("user", "Star ComposioHQ/composio on GitHub")]})
print(result)
```

```python
# LangGraph (Python) — same pattern with LanggraphProvider
from composio import Composio
from composio_langgraph import LanggraphProvider
from langgraph.prebuilt import create_react_agent
from langchain_openai import ChatOpenAI

composio = Composio(provider=LanggraphProvider())
session = composio.create(user_id="user_123")
tools = session.tools()

graph = create_react_agent(ChatOpenAI(model="gpt-5.2"), tools)
result = graph.invoke({"messages": [("user", "List open issues on ComposioHQ/composio")]})
```

```typescript
// LangGraph (TypeScript) — StateGraph with a tool node
import { Composio } from "@composio/core";
import { LangchainProvider } from "@composio/langchain";
import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const composio = new Composio({ provider: new LangchainProvider() });
const session = await composio.create("user_123");
const tools = await session.tools();

const agent = createReactAgent({ llm: new ChatOpenAI({ model: "gpt-5.2" }), tools });
const result = await agent.invoke({
  messages: [{ role: "user", content: "Star ComposioHQ/composio on GitHub" }],
});
```

---

## 8. Tool execution lifecycle & hooks

**This is the section that matters most for the Flight Recorder.** Composio's middleware ("modifiers", formerly "processors") gives three interception points around every tool execution, in both SDKs:

```
            ┌────────────────────────────────────────────────────────┐
 schema ───►│ tool schema shown to LLM                               │
            └────────────────────────────────────────────────────────┘
                       │ LLM emits tool call (slug + args)
                       ▼
 beforeExecute ───► mutate/inspect/record arguments ──► Composio executes (remote API)
                       │
 afterExecute  ───► mutate/inspect/record result ──► returned to agent
```

Where modifiers attach:
- **Non-agentic flows** (chat completions / direct execution): pass modifiers to `composio.tools.execute(...)` or `composio.provider.handle_tool_calls(..., modifiers=[...])`.
- **Agentic frameworks** (Vercel, LangChain, CrewAI, Mastra, OpenAI Agents): pass modifiers to `composio.tools.get(...)` / `session.tools(...)` — they are baked into each tool's embedded `execute`, so they fire even though the framework runs the loop. **This is how the recorder hooks agentic stacks.**

### 8.1 Before-execution modifiers

Python uses decorators (`@before_execute(tools=[...])` or `toolkits=[...]`; omit both to match **all** tools):

```python
from composio import Composio, before_execute
from composio.types import ToolExecuteParams

@before_execute()  # match every tool — flight-recorder style
def record_inputs(tool: str, toolkit: str, params: ToolExecuteParams) -> ToolExecuteParams:
    # params["arguments"] is the dict the LLM produced; params also carries user_id etc.
    recorder.log_step(kind="tool_call.start", tool=tool, toolkit=toolkit,
                      arguments=params["arguments"])
    return params  # may mutate arguments before execution

@before_execute(tools=["HACKERNEWS_GET_LATEST_POSTS"])
def clamp_size(tool: str, toolkit: str, params: ToolExecuteParams) -> ToolExecuteParams:
    params["arguments"]["size"] = 1   # inject/override args the LLM emitted
    return params

composio = Composio()
result = composio.provider.handle_tool_calls(
    response=llm_response,
    user_id="default",
    modifiers=[record_inputs, clamp_size],
)
```

TypeScript passes callbacks in the options object (3rd arg of `execute`, or in `tools.get` for agentic providers):

```typescript
const result = await composio.tools.execute(
  "HACKERNEWS_GET_LATEST_POSTS",
  { userId, arguments: JSON.parse(toolArgs) },
  {
    beforeExecute: ({ toolSlug, toolkitSlug, params }) => {
      recorder.logStep({ kind: "tool_call.start", toolSlug, toolkitSlug,
                         arguments: params.arguments });
      if (toolSlug === "HACKERNEWS_GET_LATEST_POSTS") params.arguments.size = 1;
      return params;
    },
  }
);
```

### 8.2 After-execution modifiers

Receive the full result envelope; whatever you return is what the agent sees — so they can **transform, truncate, redact, or completely replace** the result (the mocking primitive for replay):

```python
from composio import Composio, after_execute
from composio.types import ToolExecutionResponse

@after_execute()  # all tools
def record_outputs(tool: str, toolkit: str, response: ToolExecutionResponse) -> ToolExecutionResponse:
    recorder.log_step(kind="tool_call.end", tool=tool, toolkit=toolkit,
                      successful=response["successful"],
                      error=response.get("error"),
                      data=response["data"])
    return response

@after_execute(tools=["HACKERNEWS_GET_USER"])
def shrink_output(tool: str, toolkit: str, response: ToolExecutionResponse) -> ToolExecutionResponse:
    return {**response, "data": {"karma": response["data"]["karma"]}}

# direct-execution attachment:
result = composio.provider.handle_tool_calls(
    response=llm_response, user_id="default",
    modifiers=[record_outputs, shrink_output],
)

# agentic attachment (modifiers ride inside the tools):
tools = composio.tools.get(user_id="default",
                           tools=["HACKERNEWS_GET_USER"],
                           modifiers=[record_outputs])
```

```typescript
const result = await composio.tools.execute(
  "HACKERNEWS_GET_USER",
  { userId, arguments: JSON.parse(toolArgs) },
  {
    afterExecute: ({ toolSlug, toolkitSlug, result }) => {
      recorder.logStep({ kind: "tool_call.end", toolSlug,
                         successful: result.successful, data: result.data });
      return result; // or a replacement object → replay/mocking
    },
  }
);

// Agentic (e.g. Vercel provider): pass to tools.get / session.tools
const tools = await composio.tools.get("user_123",
  { toolkits: ["github"] },
  {
    beforeExecute: ({ toolSlug, params }) => { /* record */ return params; },
    afterExecute: ({ toolSlug, result }) => { /* record */ return result; },
  }
);
```

### 8.3 Schema modifiers

Run when schemas are fetched; mutate what the LLM sees (descriptions, params, defaults). Record these too — schema drift between record and replay is a top diff signal:

```python
from composio import Composio, schema_modifier
from composio.types import Tool

@schema_modifier(tools=["HACKERNEWS_GET_LATEST_POSTS"])
def modify_schema(tool: str, toolkit: str, schema: Tool) -> Tool:
    _ = schema.input_parameters["properties"].pop("page", None)  # hide a param
    schema.input_parameters["required"] = ["size"]               # force-require
    schema.description += " Defaults to the frontpage feed."
    recorder.log_schema(tool, schema)                            # snapshot for diffing
    return schema

tools = composio.tools.get(user_id="default",
                           tools=["HACKERNEWS_GET_LATEST_POSTS"],
                           modifiers=[modify_schema])
```

```typescript
const tools = await composio.tools.get(
  userId,
  { tools: ["HACKERNEWS_GET_LATEST_POSTS"] },
  {
    modifySchema: ({ toolSlug, toolkitSlug, schema }) => {
      delete (schema.inputParameters?.properties as any)?.page;
      recorder.logSchema(toolSlug, schema);
      return schema;
    },
  }
);
```

### 8.4 Custom tools (experimental API — the only custom-tools API since June 2026)

Legacy custom tools were **removed in June 2026**; use the `experimental` API. Three flavors: standalone (pure local logic), extension (inherits a toolkit's credentials via `ctx.proxy_execute`), and custom toolkits (namespaced groups).

```python
from pydantic import BaseModel, Field
from composio import Composio

composio = Composio()

class GetIssueInfoInput(BaseModel):
    issue_number: int = Field(description="Issue number")

@composio.experimental.tool(extends_toolkit="github")   # inherits GitHub auth
def get_issue_info(input: GetIssueInfoInput, ctx) -> dict:
    """Get minimal info about a GitHub issue."""
    result = ctx.proxy_execute(            # authenticated request via Composio
        toolkit="github",
        endpoint=f"/repos/ComposioHQ/composio/issues/{input.issue_number}",
        method="GET",
    )
    return {"data": result.data}
    # ctx also exposes: ctx.user_id, ctx.execute(<other tool slug>, ...)

@composio.experimental.tool(preload=True)  # standalone, preloaded into context
def get_reply_style_guide(input, ctx):
    """Return the team's email reply style guide."""
    return {"tone": "concise and helpful"}

session = composio.create(
    user_id="user_1",
    toolkits=["github"],
    experimental={"custom_tools": [get_issue_info, get_reply_style_guide]},
)
tools = session.tools()
result = session.execute("LOCAL_GET_ISSUE_INFO", arguments={"issue_number": 1})
```

```typescript
import { Composio, experimental_createTool, experimental_createToolkit } from "@composio/core";
import { z } from "zod/v3";

const composio = new Composio();

const getIssueInfo = experimental_createTool("GET_ISSUE_INFO", {
  name: "Get issue info",
  description: "Get minimal info about a GitHub issue",
  extendsToolkit: "github",
  inputParams: z.object({ issue_number: z.number() }),
  execute: async (input, ctx) => {
    const res = await ctx.proxyExecute({
      toolkit: "github",
      endpoint: `/repos/ComposioHQ/composio/issues/${input.issue_number}`,
      method: "GET",
    });
    return { data: res.data };
  },
});

const session = await composio.create("user_1", {
  toolkits: ["github"],
  experimental: { customTools: [getIssueInfo] },
});
```

Custom tools are slugged `LOCAL_<NAME>` (toolkit-scoped: `LOCAL_<TOOLKIT>_<NAME>`), discoverable via `COMPOSIO_SEARCH_TOOLS`, and run **in-process** — which means a custom tool is also a clean way to host fully recorder-controlled mock tools during replay.

### 8.5 Custom providers

If a framework isn't supported, you can write a custom Provider (docs: `/docs/providers/custom-providers`) that controls how tools are wrapped and executed — the deepest hook available: a `FlightRecorderProvider` could wrap any base provider, intercept every `execute`, and switch between live/replay modes globally.

---

## 9. Triggers & webhooks

Triggers deliver external events (new email, commit, Slack message) to your app.

- **Webhook triggers**: provider pushes to a Composio ingress URL in real time (Slack, Asana, Notion, Outlook…). Since May 2026 (Triggers V2): per-project `webhook_endpoints` (`we_…`), ingress URL `https://backend.composio.dev/api/v3.1/webhook_ingress/{toolkit_slug}/{we_xxx}/trigger_event`, HMAC-SHA256/Ed25519 + timestamp replay protection at ingress; unsigned/tampered requests → 400. If using your own OAuth app and `requires_webhook_endpoint_setup` is true, register the ingress URL with the provider manually.
- **Polling triggers**: Composio polls (15-min minimum interval on managed auth) — Gmail, Google Calendar.

### Create a trigger instance

```python
from composio import Composio

composio = Composio()
session = composio.create(user_id="user_123")
trigger = session.triggers.create(
    event="GITHUB_COMMIT_EVENT",
    connected_account_id="ca_...",
)
print(trigger.id)  # ti_...
```

```typescript
const session = await composio.create("user_123");
const trigger = await session.triggers.create({
  event: "GITHUB_COMMIT_EVENT",
  connectedAccountId: "ca_...",
});
```

### Subscribe your endpoint (production)

```bash
curl -X POST https://backend.composio.dev/api/v3.1/webhook_subscriptions \
  -H "X-API-KEY: $COMPOSIO_API_KEY" -H "Content-Type: application/json" \
  -d '{"webhook_url": "https://example.com/webhook",
       "enabled_events": ["composio.trigger.message"]}'
# Response includes the signing secret → COMPOSIO_WEBHOOK_SECRET
```

Event types: `composio.trigger.message` (trigger fired), `composio.connected_account.expired`, `composio.trigger.disabled` (new 2026). Webhook URL must be **publicly reachable** (loopback rejected, June 2026).

V3 payload:

```json
{
  "id": "msg_abc123",
  "type": "composio.trigger.message",
  "metadata": {
    "trigger_slug": "GITHUB_COMMIT_EVENT",
    "trigger_id": "ti_xyz789",
    "connected_account_id": "ca_def456",
    "user_id": "user_123"
  },
  "data": { "commit_sha": "a1b2c3d", "author": "jane" },
  "timestamp": "2026-01-15T10:30:00Z"
}
```

### Verify signatures (mandatory in practice)

Headers: `webhook-id`, `webhook-timestamp`, `webhook-signature` (HMAC-SHA256, base64). SDK helper:

```python
result = composio.triggers.verify_webhook(
    id=request.headers["webhook-id"],
    payload=request.get_data(as_text=True),
    signature=request.headers["webhook-signature"],
    timestamp=request.headers["webhook-timestamp"],
    secret=os.environ["COMPOSIO_WEBHOOK_SECRET"],
    # tolerance=300 seconds by default
)
```

```typescript
const result = await composio.triggers.verifyWebhook({
  id: req.headers["webhook-id"], payload: req.body,
  signature: req.headers["webhook-signature"],
  timestamp: req.headers["webhook-timestamp"],
  secret: process.env.COMPOSIO_WEBHOOK_SECRET!,
});
```

Manual scheme: signing string is `{webhook-id}.{webhook-timestamp}.{raw_body}`, HMAC-SHA256 with the secret, base64; compare timing-safely against the part after the comma in `webhook-signature`. The SDK auto-detects V1/V2/V3 payload versions.

### Local development (no public URL)

```python
subscription = composio.triggers.subscribe()        # WebSocket (pusher) based

@subscription.handle(trigger_id="ti_your_trigger")
def handle_event(data):
    print("Event:", data)

subscription.wait_forever()
```

```typescript
await composio.triggers.subscribe(
  (data) => console.log("Event:", data),
  { triggerId: "ti_your_trigger" }
);
```

For the recorder: trigger payloads are *external nondeterministic inputs* — persist the full payload (`metadata.trigger_id`, `webhook-id` for dedup, `timestamp`) so replay can re-inject identical events.

---

## 10. MCP support

Two routes:

### 10.1 Session MCP (recommended)

Every session is an MCP server with dynamic tool search and managed context:

```python
session = composio.create(user_id="user_123", toolkits=["gmail", "github"])
print(session.mcp.url)      # pre-signed, user-scoped MCP endpoint
print(session.mcp.headers)  # auth headers to send
```

Use with the Anthropic API (`mcp_servers=[{"type": "url", "url": session.mcp.url, ...headers}]`), OpenAI Agents (`tools=[{"type": "mcp", "server_url": ...}]`), Claude Code/Desktop, Cursor, or any MCP client. **Since June 2026, MCP requests must carry an API key or `Authorization: Bearer` token** (`x-api-key` header for Composio MCP).

### 10.2 Standalone MCP servers

```python
server = composio.mcp.create(
    name="my-gmail-server",
    toolkits=[{"toolkit": "gmail", "auth_config": "ac_xyz123"}],
    allowed_tools=["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
)
url = composio.mcp.generate(user_id="user_123", server_id=server.id)  # per-user URL
```

```typescript
const server = await composio.mcp.create("my-gmail-server", {
  toolkits: [{ authConfigId: "ac_xyz123", toolkit: "gmail" }],
  allowedTools: ["GMAIL_FETCH_EMAILS", "GMAIL_SEND_EMAIL"],
});
const url = await composio.mcp.generate("user_123", server.id);
```

Full CRUD (`list`/`get`/`update`/`delete`) exists for servers.

**Recorder note:** MCP traffic bypasses SDK modifiers (execution happens server-side via the MCP protocol). To record MCP-mode agents, the flight recorder must sit at the MCP transport layer (proxy the MCP endpoint, log `tools/call` requests/results) rather than rely on Composio hooks. For native-tools mode, modifiers (§8) are sufficient and simpler.

---

## 11. Record/replay patterns for the Flight Recorder

### 11.1 What to record per tool call

From `beforeExecute` + `afterExecute` you can capture everything needed for a trace row:

| Field | Source |
|---|---|
| `tool_slug`, `toolkit_slug` | modifier args |
| `arguments` (LLM-emitted, post-modifier) | `params["arguments"]` in beforeExecute |
| `user_id`, `connected_account_id` | execute params |
| `successful`, `error`, `data` | afterExecute `result` envelope |
| latency | timestamp delta between the two modifiers (correlate via a request id you stash; modifiers for one execution run in the same call chain) |
| schema snapshot / toolkit version | schema modifier + pinned `version` |
| session id, session config | `session.session_id` at run start |

A minimal recording wrapper (TypeScript, works for both direct and agentic providers because modifiers attach at `tools.get`):

```typescript
import { randomUUID } from "crypto";

function recordingModifiers(recorder: Recorder, runId: string) {
  const inflight = new Map<string, { start: number; args: unknown }>();
  return {
    beforeExecute: ({ toolSlug, toolkitSlug, params }: any) => {
      const callId = randomUUID();
      (params as any).__afrCallId = callId; // correlation
      inflight.set(toolSlug, { start: Date.now(), args: structuredClone(params.arguments) });
      recorder.emit({ runId, event: "tool.start", toolSlug, toolkitSlug,
                      arguments: params.arguments, ts: Date.now() });
      return params;
    },
    afterExecute: ({ toolSlug, toolkitSlug, result }: any) => {
      const started = inflight.get(toolSlug);
      recorder.emit({ runId, event: "tool.end", toolSlug, toolkitSlug,
                      successful: result.successful, error: result.error,
                      data: result.data, latencyMs: started ? Date.now() - started.start : null,
                      ts: Date.now() });
      return result;
    },
  };
}

// Live run:
const tools = await composio.tools.get(userId, { toolkits: ["github"] },
                                       recordingModifiers(recorder, runId));
```

### 11.2 Mocking tool execution during replay

Three escalating strategies:

1. **`afterExecute` replacement** — simplest, but the live call still hits the upstream API (bad: side effects + cost). Only useful for *redaction*, not replay.
2. **Short-circuit in `beforeExecute` + replace in `afterExecute`** — neuter args in before (e.g. rewrite to a no-op read) then substitute the recorded envelope in after. Fragile; not recommended.
3. **Don't call Composio at all during replay (recommended).** Replay deterministically by intercepting at the harness layer: when the (recorded) LLM step emits a tool call, look up `(tool_slug, canonical_json(arguments))` in the trace and return the recorded `{data, error, successful}` envelope without invoking `composio.tools.execute`. Because Composio's result envelope is a plain JSON object, replaying it into `handle_tool_calls`-style message construction or an agentic tool's `execute` is trivial:

```python
class ReplayExecutor:
    """Drop-in for composio.tools.execute during replay."""
    def __init__(self, trace_index):  # {(slug, args_hash): recorded_envelope}
        self.trace = trace_index

    def execute(self, slug, user_id, arguments, **kw):
        key = (slug, canonical_hash(arguments))
        if key in self.trace:
            return self.trace[key].pop_next()       # recorded {data,error,successful}
        raise ReplayDivergence(slug, arguments)      # agent diverged → diff event
```

For **agentic frameworks**, wrap each tool's `execute` (Vercel: map over the ToolSet; LangChain: wrap `StructuredTool.func`) with the same lookup. For full coverage, a **custom provider** (§8.5) that routes `execute` through record-or-replay logic covers every framework uniformly.

4. **MCP mode**: put the recorder proxy in front of `session.mcp.url` and replay `tools/call` responses from the trace.

### 11.3 Determinism & idempotency considerations

- **Pin toolkit versions** (`version=` on execute / init). `latest` is explicitly documented as schema-unstable; pin for replay and diff schema snapshots between runs.
- **Canonicalize arguments** before hashing (sort keys, normalize whitespace) — LLMs emit JSON with unstable key order.
- **Sequence-index duplicate calls**: the same `(slug, args)` may legitimately occur twice (e.g. polling a status). Index trace entries `(slug, args_hash, occurrence_n)`.
- **Side-effecting tools are not idempotent** (`GMAIL_SEND_EMAIL`, `GITHUB_CREATE_AN_ISSUE`): replay must *never* re-execute them live. Tag tools as read/write at record time (toolkit metadata + slug heuristics) and hard-fail replay if a write tool would go live.
- **Auth state is environment, not trace**: `connected_account_id` and statuses (`EXPIRED`, `REVOKED`) differ between record and replay environments — record them as metadata, don't require them to match.
- **Sessions are not deterministic**: `COMPOSIO_SEARCH_TOOLS` results, preloaded tool sets, and the catalog itself drift. Record the meta-tool calls too (they're tool calls like any other and flow through modifiers); for replay-grade runs prefer `SESSION_PRESET_DIRECT_TOOLS` or direct `tools.get` with explicit slugs.
- **Rate limits/429s** (per-IP since June 2026) are themselves nondeterminism — record `successful=False` envelopes and replay them faithfully rather than retrying.
- **Trigger events**: dedupe on `webhook-id`, persist raw payload + headers, re-inject verbatim on replay.
- **Redaction**: tool results can contain OAuth-adjacent data and PII. Redact in `afterExecute` *after* recording to an access-controlled store, or redact before persisting to ClickHouse per your threat model.

### 11.4 Suggested ClickHouse row shape

```sql
CREATE TABLE tool_calls (
    run_id          UUID,
    step_index      UInt32,
    call_id         UUID,
    ts_start        DateTime64(3),
    latency_ms      UInt32,
    user_id         String,
    session_id      String,
    tool_slug       LowCardinality(String),
    toolkit_slug    LowCardinality(String),
    toolkit_version String,
    connected_account_id String,
    arguments       JSON,          -- post-beforeExecute
    arguments_hash  FixedString(32),
    successful      Bool,
    error           Nullable(String),
    data            JSON,          -- post-afterExecute (or pre, if you redact after)
    schema_hash     FixedString(32),
    mode            Enum8('live' = 1, 'replay' = 2)
) ENGINE = MergeTree ORDER BY (run_id, step_index);
```

---

## 12. Links & sources

**Docs**
- Quickstart: https://docs.composio.dev/docs/quickstart
- Next-gen SDK migration guide: https://docs.composio.dev/docs/migration-guide/new-sdk
- Sessions: https://docs.composio.dev/docs/configuring-sessions · https://docs.composio.dev/docs/sessions-vs-direct-execution
- Executing tools (direct): https://docs.composio.dev/docs/tools-direct/executing-tools
- Modifiers: https://docs.composio.dev/docs/tools-direct/modify-tool-behavior/before-execution-modifiers · …/after-execution-modifiers · …/schema-modifiers
- Custom tools: https://docs.composio.dev/docs/custom-tools
- Authentication: https://docs.composio.dev/docs/authenticating-tools
- Providers: https://docs.composio.dev/docs/providers (openai, anthropic, vercel, langchain, google, crewai, llamaindex, mastra, custom-providers)
- Triggers: https://docs.composio.dev/docs/triggers · creating: https://docs.composio.dev/docs/setting-up-triggers/creating-triggers · subscribing: https://docs.composio.dev/docs/setting-up-triggers/subscribing-to-events
- Webhook verification: https://docs.composio.dev/docs/webhook-verification
- Meta tools / tool search: https://docs.composio.dev/reference/meta-tools/search_tools
- MCP: https://docs.composio.dev/docs/mcp/overview · https://docs.composio.dev/docs/native-tools-vs-mcp
- Changelog: https://docs.composio.dev/changelog · https://docs.composio.dev/reference/changelog
- SDK reference (Python): https://docs.composio.dev/reference/sdk-reference/python

**Blog / announcements**
- "Our new SDK is in beta" (Jul 1, 2025): https://composio.dev/blog/new-sdk-preview
- "Introducing Tool Router (Beta)" (Oct 1, 2025): https://composio.dev/blog/introducing-tool-router-(beta)
- Pricing: https://composio.dev/pricing

**Code & packages**
- GitHub: https://github.com/ComposioHQ/composio (releases: https://github.com/ComposioHQ/composio/releases)
- PyPI `composio` (0.13.1, May 14 2026): https://pypi.org/project/composio/
- npm `@composio/core` (0.10.0): https://www.npmjs.com/package/@composio/core
- Third-party release tracker: https://releasebot.io/updates/composio
