# AFR — 3-Minute Demo Script

> The killer loop: **fail → replay → pinpoint → fix → fork → green.**
> Rehearse ×3 before recording. Reset state between rehearsals
> (see demo/README.md). Target 2:45 with 15s slack.

## Setup (before recording)

- `docker compose up -d clickhouse`, ingest running, dashboard on :3000
- Terminal font large; dashboard at the run list; `demo/agent.ts` open in editor
- A previous green run already in ClickHouse (so the list isn't empty)
- Backup: a pre-recorded broken run already in CH in case the live one misbehaves

## Script

| t | Beat | What to say / do |
| --- | --- | --- |
| 0:00–0:20 | **The pain** | "Agents fail in prod and nobody can reproduce the run. Watch." Run `npm run demo:break` in the terminal — the agent fails live on screen. |
| 0:20–0:50 | **Open the recording** | Switch to the dashboard. The failed run is at the top of the list, red. Click it. The OpenUI timeline streams in, composing itself from the trace. "Every step the agent took — model calls, tool calls, latency, cost — recorded as it ran." |
| 0:50–1:30 | **Pinpoint** | Scrub to the red step. Open the payload inspector: "Here's the exact bad tool call — the model hallucinated this argument. Here's the context it saw when it decided that. Here's the error that came back." (Optional FTS beat: search the bad value across all runs — "it failed the same way 3 times this week.") |
| 1:30–2:00 | **Fix** | Jump to the editor. One visible, real fix (the tool schema/prompt line that allowed the malformed argument). "The bug is in our agent, not the recording." |
| 2:00–2:30 | **Fork-replay** | `npm run replay -- --run <id> --fork-at <seq>`. "Everything before the failure is served from the recording — instant, deterministic, free. The fix runs live from the failing step." Run goes green. Auto-eval badge flips to pass in the run list. |
| 2:30–3:00 | **Diff + close** | Open the diff view: old vs new, identical steps grey, the fixed step highlighted — "divergence at exactly the step we fixed, proven by input hashes, not vibes." Close: "Record once, replay forever. ClickHouse stores it, Composio acts it, OpenUI draws it, TrueFoundry serves it." |

## Failure-mode contingencies

- **Live break doesn't fire** → use the pre-recorded broken run already in CH;
  narrate identically ("here's one from this morning").
- **Timeline LLM is slow** → the conventional timeline at the same URL renders
  instantly; flip to it and call it "fallback mode — same trace, same answer."
- **Fork hits a rate limit** → the deterministic self-replay
  (`POST /api/runs/[id]/replay`) still proves replay; narrate the fork from the
  rehearsal recording.

## Judge Q&A crib

- *Why deterministic?* Response substitution keyed by `(run_id, seq)` + input-hash
  verification. No re-calls, no seeds, no flakiness.
- *What if the agent takes a different path on replay?* That's a divergence —
  caught at the exact step by hash mismatch, rendered in the diff view.
- *Streaming?* Recorded as full accumulation + TTFT; replay serves non-streamed (v1).
- *Scale?* ClickHouse async inserts; the rollup MV keeps the run list O(runs),
  not O(events).
