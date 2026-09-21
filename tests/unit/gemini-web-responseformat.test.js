import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GeminiWebExecutor } from "../../open-sse/executors/gemini-web.js";
import { DeepSeekWebExecutor } from "../../open-sse/executors/deepseek-web.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

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

/** Build a minimal Gemini Web init-page HTML containing all three required tokens */
function makeInitHtml({ snlm0e = "INITTOKEN", bl = "BLBLB", sid = "SESSIONID99" } = {}) {
  return JSON.stringify({ SNlM0e: snlm0e, cfb2h: bl, FdrFJe: sid });
}

/** Build a minimal Gemini Web StreamGenerate response with one frame containing text */
function makeFrameEnvelope(text) {
  // Structure matching extractTextDelta expectation:
  // frame[2] = inner JSON string
  // inner[4] = candidates array
  // candidate = candidates[0] (array)
  // candidate[1] = contentArr (array of strings - accumulated text)
  const inner = [null, null, null, null, [[null, [text]]], null];
  const frame = [null, null, JSON.stringify(inner)];
  const frameStr = JSON.stringify(frame);
  return `${[...frameStr].length}\n${frameStr}\n`;
}

describe("GeminiWebExecutor responseFormat", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns responseFormat === 'openai' in non-streaming mode", async () => {
    const initHtml = makeInitHtml();
    const responseBody = makeFrameEnvelope("Hello world");

    global.fetch
      .mockResolvedValueOnce(new Response(initHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(textStream(responseBody), { status: 200 }));

    const exec = new GeminiWebExecutor();
    const { response, responseFormat } = await exec.execute({
      model: "gemini-3.0-flash",
      body: { messages: [{ role: "user", content: "Hi" }] },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=t; __Secure-1PSIDTS=t" },
    });

    expect(responseFormat).toBe(FORMATS.OPENAI);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("Hello world");
  });

  it("returns responseFormat === 'openai' in streaming mode", async () => {
    const initHtml = makeInitHtml();
    const responseBody = makeFrameEnvelope("Hi there");

    global.fetch
      .mockResolvedValueOnce(new Response(initHtml, { status: 200 }))
      .mockResolvedValueOnce(new Response(textStream(responseBody), { status: 200 }));

    const exec = new GeminiWebExecutor();
    const { response, responseFormat } = await exec.execute({
      model: "gemini-3.0-flash",
      body: { messages: [{ role: "user", content: "Hi" }] },
      stream: true,
      credentials: { apiKey: "__Secure-1PSID=t; __Secure-1PSIDTS=t" },
    });

    expect(responseFormat).toBe(FORMATS.OPENAI);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("returns responseFormat === 'openai' even on auth failure", async () => {
    global.fetch.mockResolvedValueOnce(new Response("", { status: 401 }));

    const exec = new GeminiWebExecutor();
    const { response, responseFormat } = await exec.execute({
      model: "gemini-3.0-flash",
      body: { messages: [{ role: "user", content: "Hi" }] },
      stream: false,
      credentials: { apiKey: "__Secure-1PSID=expired" },
    });

    expect(responseFormat).toBe(FORMATS.OPENAI);
    expect(response.status).toBe(401);
  });
});

describe("DeepSeekWebExecutor responseFormat", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns responseFormat === 'openai' in non-streaming mode", async () => {
    const upstream = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    global.fetch.mockResolvedValueOnce(new Response(textStream(upstream), { status: 200 }));

    const exec = new DeepSeekWebExecutor();
    const { response, responseFormat } = await exec.execute({
      model: "deepseek-chat",
      body: { messages: [{ role: "user", content: "ping" }] },
      stream: false,
      credentials: { apiKey: "userToken=abc" },
    });

    expect(responseFormat).toBe(FORMATS.OPENAI);
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.choices[0].message.content).toBe("Hello");
  });

  it("returns responseFormat === 'openai' in streaming mode", async () => {
    const upstream = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n';
    global.fetch.mockResolvedValueOnce(new Response(textStream(upstream), { status: 200 }));

    const exec = new DeepSeekWebExecutor();
    const { response, responseFormat } = await exec.execute({
      model: "deepseek-chat",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: true,
      credentials: { apiKey: "userToken=abc" },
    });

    expect(responseFormat).toBe(FORMATS.OPENAI);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("returns responseFormat === 'openai' on 401 auth error", async () => {
    global.fetch.mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

    const exec = new DeepSeekWebExecutor();
    const { response, responseFormat } = await exec.execute({
      model: "deepseek-chat",
      body: { messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: { apiKey: "bad-token" },
    });

    expect(responseFormat).toBe(FORMATS.OPENAI);
    expect(response.status).toBe(401);
  });
});
