/**
 * Gemini Web thinking extraction tests
 *
 * Validates extractThinkingDelta:
 * - extracts thinking content from candidate[2]
 * - returns null when no thinking block present
 */
import { describe, it, expect } from "vitest";
import { extractThinkingDelta } from "../../open-sse/utils/geminiWebHelpers.js";

function makeFrameWithThinking(text) {
  // frame[2] = inner JSON: [[null, null, null, null, [candidates], null]]
  // inner[4] = candidates array containing one candidate
  // candidate[0] = null (index placeholder)
  // candidate[1] = text blocks array ["user prompt"]
  // candidate[2] = thinking blocks array [thinking chunk]
  const inner = [null, null, null, null, [[null, [text], [text]]], null];
  const frame = [null, null, JSON.stringify(inner)];
  return JSON.stringify(frame);
}

function makeFrameTextOnly(text) {
  // candidate has text only, no candidate[2]
  const inner = [null, null, null, null, [[null, [text]]], null];
  const frame = [null, null, JSON.stringify(inner)];
  return JSON.stringify(frame);
}

describe("extractThinkingDelta", () => {
  it("extracts thinking from candidate[2] array", () => {
    const frame = JSON.parse(makeFrameWithThinking("Analyzing the problem..."));
    const result = extractThinkingDelta(frame);
    expect(result).toBe("Analyzing the problem...");
  });

  it("returns null when candidate[2] does not exist (text-only frame)", () => {
    const frame = JSON.parse(makeFrameTextOnly("Just a text response"));
    expect(extractThinkingDelta(frame)).toBeNull();
  });

  it("returns null when candidate[2] is empty array", () => {
    const inner = [null, null, null, null, [[null, ["text"], []]], null];
    const frame = [null, null, JSON.stringify(inner)];
    expect(extractThinkingDelta(frame)).toBeNull();
  });

  it("returns null when frame has no candidate[2]", () => {
    const inner = [null, null, null, null, [[null, ["text"]]], null];
    const frame = [null, null, JSON.stringify(inner)];
    expect(extractThinkingDelta(frame)).toBeNull();
  });

  it("returns null for invalid frame (non-array)", () => {
    expect(extractThinkingDelta(null)).toBeNull();
    expect(extractThinkingDelta({})).toBeNull();
    expect(extractThinkingDelta("string")).toBeNull();
  });

  it("returns null when JSON parse fails in frame[2]", () => {
    const frame = [null, null, "not valid json"];
    expect(extractThinkingDelta(frame)).toBeNull();
  });

  it("extracts thinking even with multiple text chunks present", () => {
    const frame = JSON.parse(makeFrameWithThinking("Thinking about option A, then option B"));
    const result = extractThinkingDelta(frame);
    expect(result).toBe("Thinking about option A, then option B");
  });
});