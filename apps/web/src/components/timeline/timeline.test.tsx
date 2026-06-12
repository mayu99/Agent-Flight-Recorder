import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Renderer } from "@openuidev/react-lang";
import { timelineLibrary, timelinePrompt } from "./library";

// A program in the exact shape the LLM emits — exercises parser → library → React.
const SAMPLE_PROGRAM = `
root = Stack([header, timeline])
header = RunSummaryHeader("3f1c2a9e-0000-4000-8000-demo0000run1", "error", "record", 5, 8421, 0.0123, 4210)
timeline = Timeline([s1, s2, d1, s3])
s1 = StepCard(1, "openai-main/gpt-4o", "model_call", "ok", 1240, "Planned the research task", "", [lb1])
lb1 = LatencyBar(1240, 3300)
s2 = StepCard(2, "GITHUB_SEARCH_REPOS", "tool_call", "error", 3300, "Tool rejected malformed query argument", "ValidationError: 'q' must be a string, got object", [pi2, lb2])
pi2 = PayloadInspector("input — tool args", "{\\"q\\": {\\"bad\\": \\"shape\\"}}", "3f1c2a9e-0000-4000-8000-demo0000run1", 2, true)
lb2 = LatencyBar(3300, 3300)
d1 = DivergenceMarker(3, "input_hash_mismatch", "Replay input differed at step 3 after the fix")
s3 = StepCard(4, "run_end", "run_end", "ok", 2, "Run terminated after tool failure", "")
`.trim();

function renderProgram(program: string): string {
  return renderToStaticMarkup(
    <Renderer response={program} library={timelineLibrary} isStreaming={false} />,
  );
}

describe("timeline primitives via OpenUI Renderer", () => {
  it("renders a full timeline from an OpenUI Lang program", () => {
    const html = renderProgram(SAMPLE_PROGRAM);
    expect(html).toContain('data-afr="run-summary"');
    expect(html).toContain('data-afr="timeline"');
    // all four timeline entries present
    expect(html.match(/data-afr="step-card"/g)?.length).toBe(3);
    expect(html).toContain('data-afr="divergence"');
  });

  it("makes the failed step visually identifiable", () => {
    const html = renderProgram(SAMPLE_PROGRAM);
    expect(html).toContain('data-seq="2"');
    expect(html).toContain('data-status="error"');
    expect(html).toContain('data-afr="step-error"');
    expect(html).toContain("ValidationError");
    // failed step's payload inspector is expanded (details open) and quotes the recorded input
    expect(html).toContain("open");
    expect(html).toContain("&quot;bad&quot;");
  });

  it("renders latency bars scaled to the slowest step", () => {
    const html = renderProgram(SAMPLE_PROGRAM);
    const bars = html.match(/data-afr="latency-bar"/g);
    expect(bars?.length).toBe(2);
    expect(html).toContain("width:100%"); // the 3300/3300 bar
  });

  it("renders divergence markers with kind and seq", () => {
    const html = renderProgram(SAMPLE_PROGRAM);
    expect(html).toContain("input_hash_mismatch");
    expect(html).toContain("divergence @ #3");
  });

  it("renders progressively from a truncated (mid-stream) program", () => {
    const partial = SAMPLE_PROGRAM.split("\n").slice(0, 4).join("\n");
    const html = renderToStaticMarkup(
      <Renderer response={partial} library={timelineLibrary} isStreaming={true} />,
    );
    // header defined so far renders; undefined forward references must not crash
    expect(html).toContain('data-afr="run-summary"');
  });

  it("generates a system prompt constrained to our registered components", () => {
    const prompt = timelinePrompt();
    for (const name of [
      "RunSummaryHeader",
      "Timeline",
      "StepCard",
      "LatencyBar",
      "PayloadInspector",
      "DivergenceMarker",
    ]) {
      expect(prompt).toContain(name);
    }
    expect(prompt).toContain("never invent");
  });
});
