# OpenUI — The Open Standard for Generative UI (for Agent Flight Recorder)

> Research notes compiled 2026-06-12 against the live repo (`github.com/thesysdev/openui`, default branch `main`, last pushed 2026-06-12), the official docs at **openui.com**, the example app source, and the npm registry. All version numbers and code below were verified on that date. This doc stands on its own and also covers the hosted C1 API path where relevant.

---

## 0. Disambiguation — which "OpenUI"?

Three unrelated things share the name. **For this project (sponsor: OpenUI, plan says "Thesys/OpenUI"), (a) is the right one.**

| Name | What it is | Status |
|---|---|---|
| **(a) `thesysdev/openui`** — **this doc's subject** | The **Open Standard for Generative UI** from Thesys: OpenUI Lang (a compact streaming DSL that LLMs emit instead of JSON/markdown), open-source runtimes (React/Vue/Svelte), component libraries, prebuilt chat UIs, CLI. MIT-licensed, ~6,959 stars, very active (multiple releases May–June 2026). Docs: https://www.openui.com | ✅ Use this |
| (b) `wandb/openui` | An older Weights & Biases prototype: "describe UI using your imagination, see it rendered live" — an LLM tool that generates raw HTML and converts it to React/Svelte/Web Components. A demo app, not a standard or SDK. | ❌ Not it |
| (c) W3C **Open UI** Community Group (`openui/open-ui`, open-ui.org) | A web-platform **standards body** working on stylable/extensible built-in HTML controls (select, popover, etc.). Nothing to do with AI. | ❌ Not it |

Also note: the OpenUI README explicitly warns that **OpenUI has no official cryptocurrency or token** — anything claiming otherwise is unaffiliated.

---

## 1. Overview

**OpenUI** is a full-stack Generative UI framework whose centerpiece is **OpenUI Lang**: a compact, *streaming-first*, line-oriented language for model-generated UI. Instead of treating LLM output as text/markdown, you:

1. **Define a component library** (Zod schemas + React renderers via `defineComponent`) — this is the contract that constrains what the model can generate.
2. **Auto-generate a system prompt** from that library (`library.prompt()` / `openui generate` CLI / `generatePrompt`).
3. **Send the prompt to any LLM** (OpenAI, OpenRouter, Azure, Anthropic-via-proxy — anything OpenAI-compatible; no vendor lock-in).
4. **Stream the OpenUI Lang output** back to the client.
5. **Render progressively** with `<Renderer />` as tokens arrive — each line of the program renders as soon as it parses.

```
Component Library → System Prompt → LLM → OpenUI Lang Stream → Parser → Renderer → Live UI
```

**Why it exists**: JSON-based generative-UI formats (Vercel json-render, the old "Thesys C1 JSON", Google A2UI, CopilotKit OpenGenUI) are token-hungry and awkward to stream. OpenUI Lang is **up to 67% more token-efficient than JSON** and renders line-by-line. Repo benchmarks (tiktoken, GPT-5 encoder, 7 scenarios): 4,800 tokens total vs 10,180 (Vercel json-render, −52.8%) and 9,948 (C1 JSON, −51.7%). The README's comparison table claims 1× tokens / ~4.9 s at 60 tok/s vs 3× / 14.2 s for json-render and A2UI.

**Relationship to Thesys C1**: OpenUI is created and maintained by Thesys (the C1 company) as the open, MIT-licensed spec + runtime. Since C1 API version `v-20260331`, the hosted C1 service *emits OpenUI* under the hood, and `@thesysai/genui-sdk` is built on `@openuidev/react-lang` / `@openuidev/react-ui`. So there are **two ways to get OpenUI on screen**:

- **Pure OpenUI (this doc)**: bring your own LLM key, generate the system prompt from your library, render with `@openuidev/*`. Free, open-source, full control. ← what an "OpenUI prize" judge wants to see.
- **Hosted C1**: Thesys's API does the prompt/model-routing/fallback work for you and you render with `@thesysai/genui-sdk` (docs at https://docs.thesys.dev).

**Governance/license**: MIT (`LICENSE`), maintained by Thesys (`thesysdev` org) with open contribution (`CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, "help-wanted"/"looking-for-contributors" repo topics), public `ADOPTERS.md`, an OpenUI Creator Program repo, and a Discord (`discord.com/invite/Pbv5PsqUSv`). Docs site + playground: https://www.openui.com (playground at `/playground`). A Claude Code/Cursor **agent skill** ships in-repo (`npx skills add thesysdev/openui --skill openui`).

---

## 2. The OpenUI Lang spec

Spec versions: **v0.1** (static UI) and **v0.5 (Latest)** — adds reactive state, data fetching (Query/Mutation), and `@`-builtins. Docs: `openui.com/docs/openui-lang/specification-v05`.

### 2.1 Core syntax

The language is **assignment statements, one per line**:

```text
identifier = Expression
```

Three statement kinds (v0.5):

| Statement | Syntax | Example |
|---|---|---|
| Component | `name = Component(args...)` | `header = CardHeader("Title")` |
| State declaration | `$name = defaultValue` | `$days = "7"` |
| Data statement | `name = Query(...)` / `name = Mutation(...)` | `data = Query("tool", {}, {rows: []})` |

Expression types:

| Type | Syntax | Example |
|---|---|---|
| Component call | `Type(arg1, arg2)` | `CardHeader("Title", "Subtitle")` |
| Built-in call | `@Name(args)` | `@Count(data.rows)` |
| String / Number / Bool / Null | `"text"`, `42`, `true`, `null` | |
| Array / Object | `[a, b, c]`, `{key: val}` | `{variant: "info"}` |
| Reference | `identifier` | `nameField` |
| State ref | `$identifier` | `$days` |
| Member access (+ array pluck) | `a.b.c` | `data.rows.title` plucks `title` from every row |
| Ternary | `cond ? a : b` | `$show ? form : null` |
| Binary ops | `+ - * / %`, `== != > < >= <=`, `&& \|\|`, unary `! -` | `"" + $days + " days"` |

**Core rules** (these are what the generated system prompt drills into the LLM):

1. One statement per line.
2. **`root` is the entry point** — the program must define `root = <RootComponent>(...)` (root component name comes from your library; built-in `openuiLibrary` uses `Stack`, `openuiChatLibrary` uses `Card`). No root → nothing renders.
3. **Top-down generation** — Layout → Components → Data, so the UI shell streams in first.
4. **Arguments are positional**, mapped to props by **Zod schema key order**. Named/colon syntax (`Stack([c], direction: "row")`) is **not supported**.
5. Optional args can be omitted from the end.
6. **Forward references (hoisting) are allowed** — `root = Stack([chart])` can appear before `chart = ...`; the renderer resolves references as definitions stream in. Unreferenced variables are silently dropped.

### 2.2 Real examples (verbatim from the repo's `benchmarks/samples/*.oui`)

A table (148 tokens vs 357 for the same UI as C1 JSON):

```text
root = Stack([title, tbl])
title = TextContent("Employees (Sample)", "large-heavy")
tbl = Table(cols, rows)
cols = [Col("Name", "string"), Col("Department", "string"), Col("Salary", "number"), Col("YoY change (%)", "number")]
rows = [["Ava Patel", "Engineering", 132000, 6.5], ["Marcus Lee", "Sales", 98000, 4.2], ["Sofia Ramirez", "Marketing", 105000, 3.1], ["Ethan Brooks", "Finance", 118500, 5.0], ["Nina Chen", "HR", 89000, 2.4]]
```

A KPI + chart dashboard:

```text
root = Stack([header, layout], "column", "l")
header = TextContent("Revenue Dashboard", "large-heavy")
layout = Stack([metricCard, chartCard], "row", "l", "stretch", "start", true)
metricCard = Card([metricHeader, metricValue, metricDelta], "card")
metricHeader = CardHeader("Total Revenue", "Last 6 months")
metricValue = TextContent("$1,284,000", "large-heavy")
metricDelta = TextCallout("success", "Up 8.4%", "Compared to the previous 6 months")
chartCard = Card([chartHeader, revenueChart], "card")
chartHeader = CardHeader("Monthly Revenue", "Last 6 months")
revenueChart = BarChart(monthLabels, [revenueSeries], "grouped", "Month", "Revenue (USD)")
monthLabels = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar"]
revenueSeries = Series("Revenue", [198000, 205000, 214000, 210000, 223000, 234000])
```

A validated form with action buttons:

```text
root = Stack([title, form], "column", "l")
title = TextContent("Contact Us", "large-heavy")
form = Form("contact", [nameField, emailField, messageField], formButtons)
nameField = FormControl("Name", Input("name", "Your full name", "text", ["required", "minLength:2"]))
emailField = FormControl("Email", Input("email", "you@example.com", "email", ["required", "email"]))
messageField = FormControl("Message", TextArea("message", "How can we help?", 6, ["required", "minLength:10"]))
formButtons = Buttons([submitBtn, cancelBtn], "row")
submitBtn = Button("Submit", "submit:contact", "primary")
cancelBtn = Button("Cancel", "action:cancel_contact", "secondary")
```

### 2.3 v0.5: reactive state, data, builtins

**Reactive state** — `$variables` with two-way binding:

```text
$days = "7"
filter = Select("days", dayItems, "Range", null, $days)   // binds $days to the select
data = Query("get_latency", {window: $days}, {rows: []})  // user changes select → query re-fetches
```

**Query / Mutation** — built-in data fetching (this is OpenUI's standout feature vs every competitor):

```text
data = Query("tool_name", {arg: value}, {rows: []}, 30)
//            tool name    args (may use $vars)  defaults  optional refresh-interval (s)
result = Mutation("tool_name", {title: $title})   // does NOT run on load; trigger via @Run
```

Queries execute on load and **auto re-fetch when referenced `$variables` change**; the 4th arg polls on an interval (live dashboards!). The frontend resolves tool names via the `Renderer`'s `toolProvider` (function map **or an MCP client** — §6.3).

**Built-in functions** (`@`-prefixed; bare names not supported):

- Aggregation: `@Count`, `@Sum`, `@Avg`, `@Min`, `@Max`, `@First`, `@Last`
- Filtering/sorting: `@Filter(array, field, op, value)` (ops `== != > < >= <= contains`), `@Sort(array, field, "asc"|"desc")`
- Math: `@Round(n, decimals?)`, `@Abs`, `@Floor`, `@Ceil`
- Iteration: `@Each(array, "loopVar", Template(loopVar.field))`
- Action steps (inside `Action([...])`): `@Run(ref)` (execute Mutation / re-fetch Query), `@Set($var, value)`, `@Reset($var...)`, `@ToAssistant("msg")`, `@OpenUrl("url")`

Composition is the KPI-card idiom:

```text
errCount = @Count(@Filter(data.rows, "status", "==", "error"))
kpi = Card([TextContent("Errors", "small"), TextContent("" + errCount, "large-heavy")])
submitBtn = Button("Create", Action([@Run(createResult), @Run(tickets), @Reset($title)]))
```

**Prompt feature flags** (control which language features the generated system prompt teaches the model):

| Flag | Enables | Default |
|---|---|---|
| `toolCalls` | `Query()`, `Mutation()`, `@Run`, tool workflow rules | `true` if `tools` provided |
| `bindings` | `$variables`, `@Set`, `@Reset`, reactive filters | `true` if `toolCalls` |
| `editMode` | **Incremental editing** — LLM outputs only changed statements (patches) instead of regenerating | `false` |
| `inlineMode` | LLM may answer with plain text, or UI in triple-backtick fences (parser extracts fences automatically) | `false` |

### 2.4 How a renderer consumes it

- The parser re-runs on every streamed chunk; it's line-oriented so partial programs parse cleanly.
- Forward references resolve as their statements arrive; unresolved refs/invalid components are dropped from arrays (no null holes).
- `meta.orphaned` lists defined-but-unreachable statements per chunk (debugging aid).
- Positional args map to props via Zod key order; parser validates required/optional and emits **structured, LLM-friendly errors** (see §6.4 — you can pipe these back to the model for self-correction).
- A Rust/WASM parser exists (see the repo's `rust-wasm-parser` blog post) for high-performance parsing.

---

## 3. Latest releases & ecosystem (June 2026)

### 3.1 Packages (npm registry, verified 2026-06-12)

| Package | Version | Published | Purpose |
|---|---|---|---|
| `@openuidev/lang-core` | **0.2.5** | 2026-05-20 | Framework-agnostic parser, **`generatePrompt`**, runtime evaluation, types. No React dep — use in any Node/Edge backend. |
| `@openuidev/react-lang` | **0.2.6** | 2026-05-20 | Core React runtime: `defineComponent`, `createLibrary`, `<Renderer />`, hooks. **Every OpenUI React project needs this.** |
| `@openuidev/react-headless` | **0.8.2** | 2026-05-20 | Headless chat: `ChatProvider`, hooks, streaming adapters (`openAIAdapter`, `openAIReadableStreamAdapter`, `openAIResponsesAdapter`, AG-UI), message format converters. |
| `@openuidev/react-ui` | **0.11.8** | 2026-05-20 | Prebuilt chat layouts (**FullScreen, Copilot, BottomTray**), UI primitives, and the two built-in libraries `openuiLibrary` (root `Stack`) and `openuiChatLibrary` (root `Card`), plus `createTheme`, `themePresets`-style tokens, `components.css`. |
| `@openuidev/react-email` | 0.2.4 | 2026-05-20 | React Email component defs for model-generated emails (HTML export). |
| `@openuidev/vue-lang` | 0.1.2 | 2026-05-20 | Vue 3 bindings. |
| `@openuidev/svelte-lang` | 0.1.2 | 2026-05-20 | Svelte 5 bindings. |
| `@openuidev/browser-bundle` | 0.1.1 | **2026-06-09** | Script-tag bundle (renderer + UI + React + styles) for CDN/iframe/no-build embeds. |
| `@openuidev/cli` | 0.0.7 | 2026-05-20 | `openui create` (scaffold) and `openui generate` (system prompt / JSON schema from a library file). |

### 3.2 Model & framework support

- **Any LLM**: the scaffold defaults to OpenAI (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` env vars) but works with any OpenAI-compatible provider (OpenRouter, Azure OpenAI, Anthropic via proxy, local models). The docs' backend examples use `gpt-5.4-mini` / `gpt-5.5`-class models.
- **Hosted option**: Thesys C1 `v-20260331` emits OpenUI natively (managed prompts, fallbacks, console).
- **Framework integrations** documented: Vercel AI SDK, LangChain, CrewAI, OpenAI Agents SDK, Anthropic Agents SDK, Google ADK — "any framework that produces a text stream." Examples in docs: dashboard, shadcn chat, Vercel AI chat, **React Native**, React Email.
- **MCP**: `Renderer`'s `toolProvider` accepts an MCP client directly (`@modelcontextprotocol/sdk`); there's a dedicated MCP docs section.
- **Non-Thesys surfaces**: `thesysdev/openwebui-plugin` renders OpenUI Lang inside Open WebUI; `@openuidev/openclaw-os-plugin` serves OpenUI-powered OpenClaw workspaces; `ADOPTERS.md` tracks third-party orgs.
- **Chat persistence**: a documented REST **API contract** for threads/messages (`/api/threads/get|create|update/:id|delete/:id|get/:id`) plus pluggable `messageFormat` converters — so chat history can live in *your* store (ClickHouse, Postgres, anything).

### 3.3 How OpenUI compares (from the README)

| Feature | OpenUI | json-render (Vercel) | A2UI (Google) | CopilotKit OpenGenUI |
|---|---|---|---|---|
| Tokens | 1× | 3× | 3× | 4× |
| Latency (60 tok/s) | 4.9 s | 14.2 s | 14.2 s | ~20 s |
| Streaming | Yes | Yes | Yes | Partial |
| Components | Library + custom | Library + custom | Custom only | None |
| **Built-in data fetching** | **Yes** | No | No | No |
| Chat UI included | Yes | No | No | Yes |
| Multi-platform | Web, mobile, email | Web, mobile, PDF, email, video | Web, iOS, Android | Web |

---

## 4. Getting started

### 4.1 Scaffold (fastest)

```bash
npx @openuidev/cli@latest create --name genui-chat-app
cd genui-chat-app
echo "OPENAI_API_KEY=sk-your-key-here" > .env   # or .env.local
npm run dev    # http://localhost:3000
```

Generated layout (Next.js 16 / React 19 / zod 4 / openai v6 in the reference example):

```
src/
  app/page.tsx           # FullScreen chat layout + openuiChatLibrary + openAIAdapter()
  app/api/chat/route.ts  # OpenAI streaming route with example tools (runTools)
  library.ts             # export { openuiChatLibrary as library, openuiChatPromptOptions as promptOptions } from "@openuidev/react-ui/genui-lib"
  generated/system-prompt.txt   # built by `openui generate` (prebuild step in dev/build scripts)
```

The `dev` script regenerates the prompt automatically:

```json
"generate:prompt": "openui generate src/library.ts --out src/generated/system-prompt.txt",
"dev": "pnpm generate:prompt && next dev"
```

The system prompt **stays on the server** — it's never shipped to the browser.

### 4.2 Manual install into an existing app

```bash
npm install @openuidev/react-lang @openuidev/react-ui @openuidev/react-headless openai zod
# backend-only prompt generation (no React):
npm install @openuidev/lang-core
```

### 4.3 End-to-end example A — pure OpenUI with your own LLM key

**`src/library.ts`** (start from the built-in chat library; extend later):

```ts
export {
  openuiChatLibrary as library,
  openuiChatPromptOptions as promptOptions,
} from "@openuidev/react-ui/genui-lib";
```

Generate the prompt once (or as a prebuild step):

```bash
npx @openuidev/cli@latest generate src/library.ts --out src/generated/system-prompt.txt
```

**`app/api/chat/route.ts`** — minimal streaming backend (full tool-calling version in §8.5; this mirrors the official scaffold):

```ts
import { readFileSync } from "fs";
import { join } from "path";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";

const systemPrompt = readFileSync(
  join(process.cwd(), "src/generated/system-prompt.txt"),
  "utf-8"
);

export async function POST(req: Request) {
  const { messages } = await req.json();

  const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined, // OpenRouter/Azure/local all work
  });

  const completion = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-5.5",
    stream: true,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages,
    ] as ChatCompletionMessageParam[],
  });

  return new Response(completion.toReadableStream(), {
    headers: { "Content-Type": "text/event-stream" },
  });
}
```

**`app/page.tsx`** — prebuilt full-page chat:

```tsx
"use client";
import "@openuidev/react-ui/components.css";

import { openAIReadableStreamAdapter, openAIMessageFormat } from "@openuidev/react-headless";
import { FullScreen } from "@openuidev/react-ui";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";

export default function Page() {
  return (
    <FullScreen
      processMessage={async ({ messages, abortController }) =>
        fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: openAIMessageFormat.toApi(messages) }),
          signal: abortController.signal,
        })
      }
      streamProtocol={openAIReadableStreamAdapter()} // matches .toReadableStream() backend
      componentLibrary={openuiChatLibrary}
      agentName="Flight Recorder"
      theme={{ mode: "dark" }}
    />
  );
}
```

> Adapter matrix: backend returns raw OpenAI SSE → `openAIAdapter()`; `completion.toReadableStream()` / NDJSON → `openAIReadableStreamAdapter()`; OpenAI Responses API → `openAIResponsesAdapter()`; OpenUI's own protocol → no adapter.

### 4.4 End-to-end example B — render a single OpenUI view (no chat) with `<Renderer />`

```tsx
"use client";
import "@openuidev/react-ui/components.css";
import { useState } from "react";
import { Renderer } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";

export default function RunView({ runId }: { runId: string }) {
  const [code, setCode] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);

  async function generate() {
    setIsStreaming(true);
    setCode("");
    const res = await fetch(`/api/views/timeline?runId=${runId}`, { method: "POST" });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
      setCode(acc); // parser re-runs per chunk → progressive render
    }
    setIsStreaming(false);
  }

  return (
    <>
      <button onClick={generate}>Render timeline</button>
      <Renderer library={openuiLibrary} response={code} isStreaming={isStreaming} />
    </>
  );
}
```

(For this path your backend route should stream **plain OpenUI Lang text**, e.g. accumulate `chunk.choices[0].delta.content` and write it to the response.)

### 4.5 Generating OpenUI via the hosted Thesys C1 API instead

If you'd rather not manage prompts/models, point an OpenAI client at `https://api.thesys.dev/v1/embed` with model `c1/<provider>/<model>/v-20260331` and render with `@thesysai/genui-sdk` (which wraps the OpenUI runtime). Details, pricing, and code at https://docs.thesys.dev (free tier: 3k calls/mo). The pure-OpenUI path above is free apart from your LLM tokens and shows deeper engagement with the standard.

---

## 5. Component catalog (built-in `openuiChatLibrary` / `openuiLibrary`)

Signatures below are taken **verbatim from the prompt the CLI generates** (`examples/openui-chat/src/generated/system-prompt.txt`) — that file is the ground truth (`?` = optional, positional order matters, `$binding<T>` props accept `$variables`).

**Content**
```
CardHeader(title?, subtitle?)
TextContent(text, size?: "small"|"default"|"large"|"small-heavy"|"large-heavy")   // markdown supported
MarkDownRenderer(textMarkdown, variant?: "clear"|"card"|"sunk")
Callout(variant: "info"|"warning"|"error"|"success"|"neutral", title, description, visible?: $binding<boolean>)
TextCallout(variant?: "neutral"|"info"|"warning"|"success"|"danger", title?, description?)
Image(alt, src?)        ImageBlock(src, alt?)        ImageGallery(images: {src, alt?, details?}[])
CodeBlock(language, codeString)                       // syntax-highlighted — request/response payloads
Separator(orientation?, decorative?)
```

**Tables**
```
Table(columns: Col[])                                  // column-oriented!
Col(label, data, type?: "string"|"number"|"action")    // each Col holds its own data array
```

**Charts**
```
BarChart(labels, series, variant?: "grouped"|"stacked", xLabel?, yLabel?)
HorizontalBarChart(labels, series, variant?, xLabel?, yLabel?)   // prefer for long labels / rankings
LineChart(labels, series, variant?: "linear"|"natural"|"step", xLabel?, yLabel?)
AreaChart(labels, series, variant?, xLabel?, yLabel?)
RadarChart(labels, series)
Series(category, values: number[])
PieChart(labels, values, variant?: "pie"|"donut")
RadialChart(labels, values)
SingleStackedBarChart(labels, values)
ScatterChart(datasets: ScatterSeries[], xLabel?, yLabel?)
ScatterSeries(name, points: Point[])      Point(x, y, z?)
```

**Forms** (renderer shows validation errors automatically; never nest Form in Form; Form requires explicit buttons)
```
Form(name, buttons: Buttons, fields?: FormControl[])
FormControl(label, input, hint?)
Input(name, placeholder?, type?: "text"|"email"|"password"|"number"|"url", rules?, value?: $binding<string>)
TextArea(name, placeholder?, rows?, rules?, value?: $binding<string>)
Select(name, items: SelectItem[], placeholder?, rules?, value?: $binding<string>, size?)
SelectItem(value, label)
DatePicker(name, mode?: "single"|"range", rules?, value?: $binding<any>)
Slider(name, variant: "continuous"|"discrete", min, max, step?, defaultValue?, label?, rules?, value?: $binding<number[]>)
CheckBoxGroup(name, items: CheckBoxItem[], rules?, value?: $binding<Record<string,boolean>>)
CheckBoxItem(label, description, name, defaultChecked?)
RadioGroup(name, items: RadioItem[], defaultValue?, rules?, value?: $binding<string>)
RadioItem(label, description, value)
SwitchGroup(name, items: SwitchItem[], variant?, value?: $binding<Record<string,boolean>>)
SwitchItem(label?, description?, name, defaultChecked?)
// rules object: { required, email, url, numeric, min, max, minLength, maxLength, pattern }
```

**Buttons & triggers**
```
Button(label, action?: ActionExpression, variant?: "primary"|"secondary"|"tertiary",
       type?: "normal"|"destructive", size?: "extra-small"|"small"|"medium"|"large")
Buttons(buttons: Button[], direction?: "row"|"column")
// Buttons without an explicit Action send their label to the assistant: Action([@ToAssistant(label)])
```

**Lists & follow-ups** (clicking sends the item text to the LLM)
```
ListBlock(items: ListItem[], variant?: "number"|"image")
ListItem(title, subtitle?, image?, actionLabel?, action?)
FollowUpBlock(items: FollowUpItem[])     FollowUpItem(text)
```

**Sections & layout**
```
SectionBlock(sections: SectionItem[], isFoldable?)   // accordion that auto-opens sections as they stream
SectionItem(value, trigger, content[])
Tabs(items: TabItem[])         TabItem(value, trigger, content[])
Accordion(items)               AccordionItem(value, trigger, content[])
Steps(items: StepsItem[])      StepsItem(title, details)       // numbered linear flow — run timelines!
Carousel(slides: content[][], variant?)   // every slide must have identical structure
Card(children[])               // chat root container
Stack(children, direction?, gap?, align?, justify?, wrap?)     // openuiLibrary root
```

**Data display**
```
TagBlock(tags: string[])
Tag(text, icon?, size?: "sm"|"md"|"lg", variant?: "neutral"|"info"|"success"|"warning"|"danger")
```

### Constraining/steering

- The library itself is the hard constraint — the model can only call registered components (`unknown-component` parse errors otherwise).
- `createLibrary({ root, components, componentGroups })` + group `notes` put usage rules straight into the prompt ("Use BarChart for comparisons, LineChart for trends").
- `PromptOptions`: `preamble`, `additionalRules`, `examples` (one or two concrete examples dramatically improve quality).
- Keep libraries **small** — every component costs prompt tokens and adds confusion; include only what the use case needs.

---

## 6. Actions & interactivity

### 6.1 `onAction` and `ActionEvent`

User interactions surface through the `Renderer`'s `onAction`:

```tsx
<Renderer
  library={myLibrary}
  response={content}
  onAction={(event) => {
    if (event.type === "continue_conversation") {
      // event.humanFriendlyMessage — button label / follow-up text
      // event.formState           — raw field values at click time
      // event.formName            — scoping form, if any
      sendToLLM(event.humanFriendlyMessage, event.formState);
    }
  }}
/>
```

`ActionEvent`: `{ type, params, humanFriendlyMessage, formState?, formName? }`. Built-in types: `continue_conversation` (from `@ToAssistant` / default button behavior / follow-up clicks) and `open_url` (from `@OpenUrl`). `@Run`, `@Set`, `@Reset` are handled **internally** by the runtime and never reach `onAction`.

### 6.2 Forms & state

- The Renderer manages form field state automatically; persist with `onStateUpdate={(state) => save(state)}` (fires per field change, opaque `Record<string, any>`) and rehydrate via `initialState={loaded}`.
- Validation: built-in validators `required, minLength, maxLength, min, max, pattern, email`; `useFormValidation()` context for custom components.
- Component authors: `useStateField(name, value?)` is the unified form-state + `$variable` two-way binding hook; mark a prop as binding-capable with `reactive(z.string().optional())`. Other hooks: `useTriggerAction()`, `useRenderNode()`, `useIsStreaming()`, `useIsQueryLoading()`, `useFormName()`, `useGetFieldValue()`, `useSetFieldValue()`.

### 6.3 `toolProvider` — Query/Mutation execution (frontend data fetching)

```tsx
// Function map — tools are just async functions
<Renderer
  library={library}
  response={code}
  toolProvider={{
    list_runs:  async (args) => fetch("/api/tools/list_runs",  { method: "POST", body: JSON.stringify(args) }).then(r => r.json()),
    get_run:    async (args) => fetch("/api/tools/get_run",    { method: "POST", body: JSON.stringify(args) }).then(r => r.json()),
  }}
  queryLoader={<MySpinner />}   // optional custom loading UI while queries fetch
/>

// Or pass an MCP client directly
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const mcp = new Client({ name: "afr", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL("/api/mcp")));
<Renderer toolProvider={mcp} library={library} response={code} />;
```

### 6.4 Errors → LLM self-correction loop

`onError` receives structured, LLM-friendly errors (`unknown-component`, `missing-required`, `null-required`, `excess-args`, `inline-reserved`, `parse-failed`, `parse-exception`, `tool-not-found`, `runtime-error`, `render-error`), called with `[]` when resolved:

```tsx
<Renderer
  library={library} response={code} toolProvider={tools}
  onError={(errors) => {
    if (!errors.length) return;
    const msg = errors.map(e =>
      `[${e.source}] ${e.statementId ? `"${e.statementId}": ` : ""}${e.message}${e.hint ? `\nHint: ${e.hint}` : ""}`
    ).join("\n\n");
    sendToLLM(`Fix these errors:\n\n${msg}`); // automated correction loop
  }}
/>
```

### 6.5 Full Renderer props reference

| Prop | Type | Description |
|---|---|---|
| `response` | `string \| null` | Raw OpenUI Lang text (possibly partial) |
| `library` | `Library` | From `createLibrary(...)` |
| `isStreaming` | `boolean` | Stream in progress |
| `onAction` | `(event: ActionEvent) => void` | Structured action events |
| `onStateUpdate` | `(state: Record<string, any>) => void` | Field-state persistence |
| `initialState` | `Record<string, any>` | Hydrate form state |
| `onParseResult` | `(result: ParseResult \| null) => void` | Debug/inspect parses |
| `toolProvider` | function map \| MCP client \| null | Executes `Query()`/`Mutation()` |
| `queryLoader` | `React.ReactNode` | Custom query-loading indicator |
| `onError` | `(errors: OpenUIError[]) => void` | Structured parser/runtime errors |

---

## 7. Theming & styling

Chat layouts (`FullScreen`, `Copilot`, `BottomTray`) mount their own ThemeProvider; control it via the `theme` prop:

```tsx
import { FullScreen, createTheme } from "@openuidev/react-ui";

// just dark mode:
<FullScreen apiUrl="/api/chat" theme={{ mode: "dark" }} agentName="Flight Recorder" />

// token-level overrides:
<FullScreen
  apiUrl="/api/chat"
  theme={{
    mode: "dark",
    lightTheme: createTheme({ interactiveAccentDefault: "oklch(0.62 0.22 260)" }),
    darkTheme:  createTheme({ interactiveAccentDefault: "oklch(0.72 0.18 260)" }),
  }}
/>

// app already has a ThemeProvider:
<FullScreen apiUrl="/api/chat" disableThemeProvider />
```

If only `lightTheme` is passed, it's also the dark-mode fallback.

**OpenUI CSS** ships as `@openuidev/react-ui/components.css` with all rules inside **`@layer openui`** — any *unlayered* consumer CSS overrides it without `!important` or specificity games:

```css
.openui-button-base-primary { background: hotpink; }
```

Tailwind v4: declare the layer order ahead of the import — `@layer theme, base, openui, components, utilities;` then `@import "tailwindcss";`. CSS Modules / CSS-in-JS / Tailwind v3 emit unlayered CSS and override automatically. (Cascade layers are baseline since March 2022: Chrome/Edge 99+, Firefox 97+, Safari 15.4+.)

---

## 8. Patterns for Agent Flight Recorder

The killer fit: OpenUI v0.5's **`Query()` + `$variables` + refresh intervals** means the generated UI itself can pull from ClickHouse (via your tool endpoints) and stay live — the LLM generates the *dashboard program once*, and data flows reactively afterwards. That's something none of the JSON-based competitors do.

**Architecture**:

1. `/api/tools/*` routes (or one MCP server) exposing ClickHouse-backed tools: `list_runs`, `get_run`, `get_run_steps`, `get_step`, `diff_runs`, `get_eval_results`. Each returns small, view-ready JSON (`{rows: [...]}` shape works best with builtins and column pluck).
2. A custom library = `openuiChatLibrary` + 1–2 bespoke components (waterfall!), prompt generated with `tools` + `toolExamples`.
3. `/api/chat` streaming route (LLM of your choice) + `FullScreen` chat *and/or* per-view `<Renderer />` panels.

### 8.1 Custom library with a LatencyWaterfall component

```tsx
// src/afr-library.tsx
import { defineComponent, createLibrary } from "@openuidev/react-lang";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";
import { z } from "zod/v4";

const SpanSchema = z.object({
  name: z.string().describe("step name, e.g. 'tool:web_search' or 'llm:claude-sonnet-4.6'"),
  startMs: z.number().describe("offset from run start in ms"),
  durationMs: z.number(),
  status: z.enum(["ok", "error"]),
});

export const LatencyWaterfall = defineComponent({
  name: "LatencyWaterfall",
  description:
    "Waterfall chart of agent-run spans (model calls and tool calls) over time. Use for run timelines.",
  props: z.object({ spans: z.array(SpanSchema), totalMs: z.number() }),
  component: ({ props }) => (
    <div style={{ display: "grid", gap: 4 }}>
      {props.spans.map((s) => (
        <div key={s.name + s.startMs} style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 180, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
          <div style={{ flex: 1, position: "relative", height: 14 }}>
            <div
              style={{
                position: "absolute",
                left: `${(s.startMs / props.totalMs) * 100}%`,
                width: `${Math.max((s.durationMs / props.totalMs) * 100, 0.5)}%`,
                height: "100%",
                borderRadius: 3,
                background: s.status === "error" ? "var(--afr-danger, #e5484d)" : "var(--afr-ok, #46a758)",
              }}
              title={`${s.name}: ${s.durationMs}ms`}
            />
          </div>
          <span style={{ width: 64, fontSize: 12, textAlign: "right" }}>{s.durationMs}ms</span>
        </div>
      ))}
    </div>
  ),
});

export const afrLibrary = createLibrary({
  root: openuiChatLibrary.root ?? "Card",
  componentGroups: [
    ...(openuiChatLibrary.componentGroups ?? []),
    {
      name: "Flight Recorder",
      components: ["LatencyWaterfall"],
      notes: [
        "- Use LatencyWaterfall for run timelines instead of BarChart when span start times matter.",
        "- Use Tag variants: success for ok runs, danger for errors, info for running.",
      ],
    },
  ],
  components: [...Object.values(openuiChatLibrary.components), LatencyWaterfall],
});
```

### 8.2 Prompt generation with ClickHouse tools (backend, no React)

```bash
npx @openuidev/cli generate src/afr-library.tsx --json-schema --out src/generated/component-spec.json
```

```ts
// src/server/prompt.ts
import { generatePrompt } from "@openuidev/lang-core";
import componentSpec from "../generated/component-spec.json";

export const systemPrompt = generatePrompt({
  ...componentSpec,
  tools: [
    { name: "list_runs", description: "List recent agent runs. Args: {limit?: number, agent?: string}. Returns {rows: [{id, agent, started_at, status, duration_ms, total_tokens, cost_usd}]}" },
    { name: "get_run_steps", description: "Steps for one run. Args: {runId: string}. Returns {rows: [{idx, type, name, start_ms, duration_ms, input_tokens, output_tokens, status, error}]}" },
    { name: "diff_runs", description: "Precomputed diff of two runs. Args: {runA: string, runB: string}. Returns {metrics: [...], stepDiffs: [...]}" },
    { name: "get_eval_results", description: "Eval batches. Args: {since?: string}. Returns {rows: [{batch, ts, pass_rate, failures, category}]}" },
  ],
  toolExamples: [
    `runs = Query("list_runs", {limit: 20}, {rows: []})
tbl = Table([Col("Run", runs.rows.id), Col("Status", runs.rows.status), Col("Duration (ms)", runs.rows.duration_ms, "number")])`,
  ],
  toolCalls: true,
  bindings: true,
  editMode: true,    // judges love "tweak the dashboard" follow-ups → patches, not regeneration
  inlineMode: true,  // let the model answer plain questions without forcing UI
  preamble: "You are the UI generator for Agent Flight Recorder, an AI-agent observability tool. Build debugging dashboards using openui-lang.",
  additionalRules: [
    "Use Steps or LatencyWaterfall for run timelines, never Carousel.",
    "Tag run statuses: success=success, error=danger, running=info.",
    "Put long request/response payloads inside Accordion > CodeBlock.",
    "End run views with a FollowUpBlock suggesting diff and inspection actions.",
  ],
});
```

### 8.3 What the model should emit — target programs per view

**Run-timeline view** (live: re-polls every 5 s while a run is in flight):

```text
$runId = "run_8f3"
run = Query("get_run_steps", {runId: $runId}, {rows: []}, 5)
root = Card([hdr, tags, wf, errBox, fu])
hdr = CardHeader("Run " + $runId, "support-bot · started 10:02:11")
tags = TagBlock(["success", "14.2s", "18,233 tokens"])
wf = LatencyWaterfall(spans, 14230)
spans = run.rows
errCount = @Count(@Filter(run.rows, "status", "==", "error"))
errBox = Callout("error", "" + errCount + " failing steps", "Inspect the failing steps below", $hasErr)
$hasErr = false
fu = FollowUpBlock([f1, f2, f3])
f1 = FollowUpItem("Inspect the slowest step")
f2 = FollowUpItem("Diff this run with the previous one")
f3 = FollowUpItem("Show token usage per step")
```

**Step-detail inspector**:

```text
root = Card([hdr, tags, tabs])
hdr = CardHeader("Step 3 — llm:claude-sonnet-4.6", "run_8f3")
tags = TagBlock(["ok", "6400ms", "4100 in / 1900 out"])
tabs = Tabs([reqTab, resTab, metaTab])
reqTab = TabItem("req", "Request", [reqParams, reqCode])
reqParams = Table([Col("Param", ["model", "temperature", "max_tokens"]), Col("Value", ["claude-sonnet-4.6", "0.2", "4096"])])
reqCode = CodeBlock("json", "{\n  \"messages\": [...truncated...]\n}")
resTab = TabItem("res", "Response", [resCode])
resCode = CodeBlock("json", "{\n  \"content\": \"...\"\n}")
metaTab = TabItem("meta", "Metadata", [metaTbl])
metaTbl = Table([Col("Metric", ["latency_ms", "input_tokens", "output_tokens", "cost_usd"]), Col("Value", [6400, 4100, 1900, 0.041], "number")])
```

**Run diff** (compute the diff in ClickHouse/your backend; the LLM only *presents* it):

```text
diff = Query("diff_runs", {runA: "run_8f2", runB: "run_8f3"}, {metrics: [], stepDiffs: []})
root = Card([hdr, metricsTbl, chart, changes, verdict])
hdr = CardHeader("Run comparison", "run_8f2 (baseline) vs run_8f3")
metricsTbl = Table([Col("Metric", diff.metrics.name), Col("Run A", diff.metrics.a, "number"), Col("Run B", diff.metrics.b, "number"), Col("Δ", diff.metrics.delta)])
chart = BarChart(diff.metrics.name, [sa, sb], "grouped", "Metric", "Value")
sa = Series("Run A", diff.metrics.a)
sb = Series("Run B", diff.metrics.b)
changes = SectionBlock([sAdded, sChanged])
sAdded = SectionItem("added", "Added steps", [addedList])
addedList = ListBlock(@Each(@Filter(diff.stepDiffs, "change", "==", "added"), "d", ListItem(d.stepName, d.detail)))
sChanged = SectionItem("chg", "Changed model calls", [chgCode])
chgCode = CodeBlock("diff", "- old prompt line\n+ new prompt line")
verdict = TextCallout("success", "No regressions", "Run B is 12% faster with identical outputs")
```

**Eval dashboard** (auto-refreshing, filterable via `$variables`):

```text
$since = "7"
evals = Query("get_eval_results", {since: $since}, {rows: []}, 30)
root = Card([hdr, filter, kpis, trend, byCat, fu])
hdr = CardHeader("Eval results", "Last " + $since + " days")
filter = Form("flt", Buttons([]), [FormControl("Window", Select("since", [SelectItem("1", "24h"), SelectItem("7", "7 days"), SelectItem("30", "30 days")], "Range", null, $since))])
kpis = Stack([kpi1, kpi2], "row", "l")
kpi1 = Card([TextContent("Pass rate", "small"), TextContent("" + @Round(@Avg(evals.rows.pass_rate), 1) + "%", "large-heavy")])
kpi2 = Card([TextContent("Batches", "small"), TextContent("" + @Count(evals.rows), "large-heavy")])
trend = LineChart(evals.rows.batch, [Series("Pass rate", evals.rows.pass_rate)], "natural", "Batch", "Pass %")
byCat = HorizontalBarChart(evals.rows.category, [Series("Failures", evals.rows.failures)], "grouped")
fu = FollowUpBlock([FollowUpItem("Show only regressions"), FollowUpItem("Group failures by tool")])
```

Changing the Select re-runs the Query automatically (two-way `$since` binding) — **zero extra code**.

### 8.4 Tool endpoints (ClickHouse → Query)

```ts
// app/api/tools/[tool]/route.ts
import { NextRequest } from "next/server";
import { clickhouse } from "@/server/clickhouse";

const TOOLS: Record<string, (args: any) => Promise<unknown>> = {
  list_runs: async ({ limit = 20 }) => ({
    rows: await clickhouse.query(
      `SELECT id, agent, started_at, status, duration_ms, total_tokens, cost_usd
       FROM runs ORDER BY started_at DESC LIMIT {limit:UInt32}`, { limit }),
  }),
  get_run_steps: async ({ runId }) => ({
    rows: await clickhouse.query(
      `SELECT idx, type, name, start_ms, duration_ms, input_tokens, output_tokens, status, error
       FROM steps WHERE run_id = {runId:String} ORDER BY idx`, { runId }),
  }),
  // diff_runs, get_eval_results, get_step ...
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ tool: string }> }) {
  const { tool } = await params;
  const fn = TOOLS[tool];
  if (!fn) return Response.json({ error: "tool-not-found" }, { status: 404 });
  return Response.json(await fn(await req.json().catch(() => ({}))));
}
```

Frontend wiring (works for both `<Renderer toolProvider={...}>` and the chat layouts, which accept the same renderer config through their GenUI props):

```ts
const toolProvider = Object.fromEntries(
  ["list_runs", "get_run_steps", "diff_runs", "get_eval_results", "get_step"].map((t) => [
    t,
    (args: Record<string, unknown>) =>
      fetch(`/api/tools/${t}`, { method: "POST", body: JSON.stringify(args) }).then((r) => r.json()),
  ])
);
```

### 8.5 Server-side tool calling (LLM-side tools) — when the model needs data *before* generating

For "why was run B slower?"-style questions the **LLM** (not the UI) needs the data. The reference app (`examples/openui-chat/src/app/api/chat/route.ts`) shows the production pattern: `client.chat.completions.runTools({ model, messages, tools, stream: true })`, then re-emit `functionToolCall` / `functionToolCallResult` / content chunks as OpenAI-shaped SSE (`data: {...}\n\n`, ending with `data: [DONE]\n\n`), consumed on the frontend with `streamProtocol={openAIAdapter()}`. Reuse the same `TOOLS` map from §8.4 as the tool implementations. (Full ~350-line reference: the example route in the repo.)

### 8.6 Demo-day checklist (OpenUI prize)

- Use the **pure OpenUI stack** (`@openuidev/*`, your own LLM key) for at least the headline views — it demonstrates the standard, not just a hosted API.
- Show **`Query()` with a refresh interval** on a live run ("the dashboard the model wrote keeps updating itself").
- Show **`$variable` filters** re-fetching ClickHouse data with zero glue code.
- Ship the **custom `LatencyWaterfall`** component (custom libraries are the core extensibility story).
- Enable **`editMode`** and demo "make the chart horizontal" → the model streams a 2-line patch.
- Wire **`onError` → self-correction** and mention it ("the renderer's structured errors feed back to the model").
- Cite the token math: OpenUI Lang ≈ half the output tokens of JSON formats → ~2× faster perceived rendering.
- Optional: add your project to the conversation around `ADOPTERS.md` / Creator Program.

---

## 9. Links

**Official**
- Repo: https://github.com/thesysdev/openui (MIT, ~7k stars)
- Docs: https://www.openui.com · Playground: https://www.openui.com/playground
- LLM-ready docs: https://www.openui.com/llms.txt · https://www.openui.com/llms-full.txt
- Intro: https://www.openui.com/docs/openui-lang · Quickstart: https://www.openui.com/docs/openui-lang/quickstart
- Spec v0.5: https://www.openui.com/docs/openui-lang/specification-v05 · v0.1: https://www.openui.com/docs/openui-lang/specification-v01 · Syntax: https://www.openui.com/docs/openui-lang/syntax
- Defining components: https://www.openui.com/docs/openui-lang/defining-components · System prompts: https://www.openui.com/docs/openui-lang/system-prompts · Renderer: https://www.openui.com/docs/openui-lang/renderer
- Interactivity: https://www.openui.com/docs/openui-lang/interactivity · Reactive state: https://www.openui.com/docs/openui-lang/reactive-state · Queries & mutations: https://www.openui.com/docs/openui-lang/queries-mutations · Built-ins: https://www.openui.com/docs/openui-lang/builtins · Incremental editing: https://www.openui.com/docs/openui-lang/incremental-editing
- Standard library: https://www.openui.com/docs/openui-lang/standard-library · Benchmarks: https://www.openui.com/docs/openui-lang/benchmarks · Comparison: https://www.openui.com/docs/openui-lang/comparison
- Chat: quick start https://www.openui.com/docs/chat/quick-start · GenUI https://www.openui.com/docs/chat/genui · API contract https://www.openui.com/docs/chat/api-contract · Theming https://www.openui.com/docs/chat/theming · Persistence https://www.openui.com/docs/chat/persistence · Headless https://www.openui.com/docs/chat/headless-intro
- MCP: https://www.openui.com/docs/mcp

**In-repo ground truth**
- Reference app: https://github.com/thesysdev/openui/tree/main/examples/openui-chat (esp. `src/app/api/chat/route.ts`, `src/app/page.tsx`)
- Generated prompt (full component signatures): https://github.com/thesysdev/openui/blob/main/examples/openui-chat/src/generated/system-prompt.txt
- Benchmarks + `.oui` samples: https://github.com/thesysdev/openui/tree/main/benchmarks
- Agent skill: https://github.com/thesysdev/openui/blob/main/skills/openui/SKILL.md (`npx skills add thesysdev/openui --skill openui`)
- Adopters: https://github.com/thesysdev/openui/blob/main/ADOPTERS.md

**npm** — `@openuidev/`: [react-lang](https://www.npmjs.com/package/@openuidev/react-lang) 0.2.6 · [react-ui](https://www.npmjs.com/package/@openuidev/react-ui) 0.11.8 · [react-headless](https://www.npmjs.com/package/@openuidev/react-headless) 0.8.2 · [lang-core](https://www.npmjs.com/package/@openuidev/lang-core) 0.2.5 · [cli](https://www.npmjs.com/package/@openuidev/cli) 0.0.7 · [browser-bundle](https://www.npmjs.com/package/@openuidev/browser-bundle) 0.1.1 · [vue-lang](https://www.npmjs.com/package/@openuidev/vue-lang) 0.1.2 · [svelte-lang](https://www.npmjs.com/package/@openuidev/svelte-lang) 0.1.2 · [react-email](https://www.npmjs.com/package/@openuidev/react-email) 0.2.4

**Ecosystem**
- Open WebUI plugin: https://github.com/thesysdev/openwebui-plugin
- Creator program: https://github.com/thesysdev/openui-creator-program
- Thesys blog announcement: https://www.thesys.dev/blogs/openui
- Discord: https://discord.com/invite/Pbv5PsqUSv

**Disambiguation (NOT this OpenUI)**
- wandb/openui (W&B HTML-generation demo): https://github.com/wandb/openui
- W3C Open UI Community Group (web-platform controls standard): https://open-ui.org · https://github.com/openui/open-ui · https://www.w3.org/community/open-ui/
