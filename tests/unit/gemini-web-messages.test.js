/**
 * Gemini Web executor message handling tests
 *
 * Validates parseOpenAIMessages behavior:
 * - system: prepended to prompt
 * - developer: treated as user
 * - text content extraction (string + array)
 */
import { describe, it, expect } from "vitest";
import { parseOpenAIMessages } from "../../open-sse/utils/geminiWebHelpers.js";

describe("parseOpenAIMessages", () => {
  it("prepends system message to prompt", () => {
    const messages = [{ role: "system", content: "You are helpful." }, { role: "user", content: "Hi" }];
    const prompt = parseOpenAIMessages(messages);
    expect(prompt).toContain("You are helpful.");
    expect(prompt.indexOf("You are helpful.")).toBeLessThan(prompt.indexOf("Hi"));
  });

  it("converts developer role to user", () => {
    const messages = [{ role: "developer", content: "instructions" }, { role: "user", content: "query" }];
    const prompt = parseOpenAIMessages(messages);
    expect(prompt).toContain("user: instructions");
    expect(prompt).not.toContain("developer: instructions");
  });

  it("handles string and array content", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
    const prompt = parseOpenAIMessages(messages);
    expect(prompt).toContain("hello");
  });

  it("produces non-empty prompt for user with system context", () => {
    const messages = [{ role: "system", content: "be brief" }, { role: "user", content: "hello" }];
    expect(parseOpenAIMessages(messages).trim().length).toBeGreaterThan(0);
  });

  it("returns empty string for empty messages array", () => {
    expect(parseOpenAIMessages([])).toBe("");
  });
});