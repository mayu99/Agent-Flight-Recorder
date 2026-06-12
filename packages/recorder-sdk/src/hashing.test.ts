import { describe, expect, it } from "vitest";
import { canonicalJson, hashInput } from "./hashing";

describe("canonical hashing", () => {
  it("is invariant to object key order at every depth", () => {
    const a = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], temp: 0.2 };
    const b = { temp: 0.2, messages: [{ content: "hi", role: "user" }], model: "gpt-4o" };
    expect(hashInput(a)).toBe(hashInput(b));
  });

  it("normalizes insignificant whitespace in strings", () => {
    expect(hashInput({ prompt: "find  the\n  answer " })).toBe(
      hashInput({ prompt: "find the answer" }),
    );
  });

  it("can preserve whitespace when asked", () => {
    expect(hashInput({ p: "a  b" }, { normalizeStrings: false })).not.toBe(
      hashInput({ p: "a b" }, { normalizeStrings: false }),
    );
  });

  it("normalizes -0 to 0 and non-finite numbers to null", () => {
    expect(hashInput({ x: -0 })).toBe(hashInput({ x: 0 }));
    expect(canonicalJson({ x: NaN })).toBe('{"x":null}');
    expect(canonicalJson({ x: Infinity })).toBe('{"x":null}');
  });

  it("drops undefined properties like JSON.stringify does", () => {
    expect(hashInput({ a: 1, b: undefined })).toBe(hashInput({ a: 1 }));
  });

  it("treats array order as significant", () => {
    expect(hashInput({ msgs: [1, 2] })).not.toBe(hashInput({ msgs: [2, 1] }));
  });

  it("excludes volatile keys at any depth", () => {
    const opts = { excludeKeys: ["ts", "request_id"] };
    const a = { q: "x", meta: { ts: 111, request_id: "r1" } };
    const b = { q: "x", meta: { ts: 999, request_id: "r2" } };
    expect(hashInput(a, opts)).toBe(hashInput(b, opts));
    expect(hashInput(a)).not.toBe(hashInput(b)); // without exclusion they differ
  });

  it("produces 64-char lowercase hex", () => {
    expect(hashInput({ any: "thing" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("distinguishes different logical inputs", () => {
    expect(hashInput({ tool: "sheets", range: "A1:B2" })).not.toBe(
      hashInput({ tool: "sheets", range: "A1:B3" }),
    );
  });
});
