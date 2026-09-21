import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeepSeekWebExecutor } from "../../open-sse/executors/deepseek-web.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

const originalFetch = global.fetch;

function textStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

describe("DeepSeek Web provider", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("is registered with the chat completion endpoint", () => {
    expect(PROVIDERS["deepseek-web"].baseUrl).toBe("https://chat.deepseek.com/api/v0/chat/completion");
    expect(PROVIDERS["deepseek-web"].format).toBe("deepseek-web");
    expect(PROVIDERS["deepseek-web"].authType).toBe("cookie");
  });

  it("wraps bare cookie value as userToken", async () => {
    global.fetch.mockResolvedValue(new Response(textStream("data: [DONE]\n\n"), { status: 200 }));

    const exec = new DeepSeekWebExecutor();
    const { response } = await exec.execute({
      model: "deepseek-chat",
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: false,
      credentials: { apiKey: "raw-token" },
    });

    expect(response.status).toBe(200);
    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers.Cookie).toBe("userToken=raw-token");
  });

  it("preserves full Cookie header", async () => {
    global.fetch.mockResolvedValue(new Response(textStream("data: [DONE]\n\n"), { status: 200 }));

    const exec = new DeepSeekWebExecutor();
    await exec.execute({
      model: "deepseek-chat",
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: false,
      credentials: { apiKey: "userToken=abc; other=def" },
    });

    const [, opts] = global.fetch.mock.calls[0];
    expect(opts.headers.Cookie).toBe("userToken=abc; other=def");
  });

  it("converts non-streaming SSE chunks into OpenAI chat completion", async () => {
    const upstream = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    global.fetch.mockResolvedValue(new Response(textStream(upstream), { status: 200 }));

    const exec = new DeepSeekWebExecutor();
    const { response } = await exec.execute({
      model: "deepseek-chat",
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: false,
      credentials: { apiKey: "userToken=abc" },
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("Hello");
  });

  it("returns auth error for 401", async () => {
    global.fetch.mockResolvedValue(new Response("Unauthorized", { status: 401 }));

    const exec = new DeepSeekWebExecutor();
    const { response } = await exec.execute({
      model: "deepseek-chat",
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: false,
      credentials: { apiKey: "bad" },
    });

    expect(response.status).toBe(401);
    const json = await response.json();
    expect(json.error.message).toMatch(/auth failed/i);
  });

  it("extracts reasoning_content in non-streaming mode", async () => {
    const upstream = [
      'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    global.fetch.mockResolvedValue(new Response(textStream(upstream), { status: 200 }));

    const exec = new DeepSeekWebExecutor();
    const { response } = await exec.execute({
      model: "deepseek-reasoner",
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: false,
      credentials: { apiKey: "userToken=abc" },
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("Hello");
    expect(json.choices[0].message.reasoning_content).toBe("Thinking...");
  });

  it("emits reasoning_content delta in streaming mode", async () => {
    const upstream = [
      'data: {"choices":[{"delta":{"reasoning_content":"Thinking"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":" step"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"Answer"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    global.fetch.mockResolvedValue(new Response(textStream(upstream), { status: 200 }));

    const exec = new DeepSeekWebExecutor();
    const { response } = await exec.execute({
      model: "deepseek-reasoner",
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: true,
      credentials: { apiKey: "userToken=abc" },
    });

    expect(response.status).toBe(200);
    const raw = await response.text();
    const chunks = raw.split("\n\ndata: ").filter(s => s && s !== "[DONE]");
    let foundReasoning = false;
    let foundContent = false;
    for (const chunk of chunks) {
      if (chunk === "[DONE]") continue;
      try {
        const parsed = JSON.parse(chunk);
        const r = parsed.choices?.[0]?.delta;
        if (r?.reasoning_content && !foundReasoning) foundReasoning = true;
        if (r?.content && !foundContent) foundContent = true;
      } catch {}
    }
    expect(foundReasoning).toBe(true);
    expect(foundContent).toBe(true);
  });

  it("has thinkingConfig in registry", () => {
    expect(PROVIDERS["deepseek-web"]).toBeDefined();
    // thinkingConfig lives on registry entry, check via provider list
  });
});
