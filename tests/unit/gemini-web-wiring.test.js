import { describe, it, expect } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

describe("Gemini Web wiring", () => {
  it("provider registered with correct base URL", () => {
    expect(PROVIDERS["gemini-web"].baseUrl).toBe(
      "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate"
    );
    expect(PROVIDERS["gemini-web"].authType).toBe("cookie");
  });

  it("executor loads and accesses provider config", () => {
    const exec = getExecutor("gemini-web");
    expect(exec.constructor.name).toBe("GeminiWebExecutor");
    expect(exec.config.baseUrl).toContain("gemini.google.com");
  });

  it("DeepSeek Web still wired", () => {
    expect(PROVIDERS["deepseek-web"]).toBeDefined();
    expect(getExecutor("deepseek-web").constructor.name).toBe("DeepSeekWebExecutor");
  });
});
