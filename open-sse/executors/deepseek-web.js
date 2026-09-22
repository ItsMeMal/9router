import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";

const DSW_API = PROVIDERS["deepseek-web"].baseUrl;
const DSW_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

async function* readDSWSseEvents(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith("data:")) {
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          try { yield JSON.parse(data); } catch { /* skip */ }
        }
      }
    }
    buffer += decoder.decode();
    const remaining = buffer.trim();
    if (remaining && remaining.startsWith("data:")) {
      const data = remaining.slice(5).trim();
      if (data !== "[DONE]") {
        try { yield JSON.parse(data); } catch { /* skip */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* extractContent(eventStream, signal) {
  for await (const event of readDSWSseEvents(eventStream, signal)) {
    if (event.error) {
      yield { error: event.error.message || `DeepSeek Web error: ${event.error.code}`, done: true };
      return;
    }

    const choices = event.choices;
    if (!Array.isArray(choices)) continue;
    for (const choice of choices) {
      const delta = choice.delta;
      if (!delta) continue;
      // Reasoning/thinking content comes as reasoning_content in DeepSeek R1 API
      if (typeof delta.reasoning_content === "string") {
        yield { thinking: delta.reasoning_content };
      }
      if (typeof delta.content === "string") {
        yield { delta: delta.content };
      }
      if (choice.finish_reason) {
        yield { finishReason: choice.finish_reason };
      }
    }
  }
  yield { done: true };
}

function buildStreamingResponse(eventStream, model, cid, created, signal) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
        })));

        for await (const chunk of extractContent(eventStream, signal)) {
          if (chunk.error) {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
              choices: [{ index: 0, delta: { content: `[Error: ${chunk.error}]` }, finish_reason: null, logprobs: null }],
            })));
            break;
          }
          if (chunk.done) break;
          if (chunk.thinking) {
            // Emit reasoning/thinking content as OpenAI-compatible delta
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
              choices: [{ index: 0, delta: { reasoning_content: chunk.thinking }, finish_reason: null, logprobs: null }],
            })));
          }
          if (chunk.finishReason) {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
              choices: [{ index: 0, delta: {}, finish_reason: chunk.finishReason, logprobs: null }],
            })));
          }
          if (chunk.delta) {
            controller.enqueue(encoder.encode(sseChunk({
              id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
              choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null, logprobs: null }],
            })));
          }
        }

        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
        })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } catch (err) {
        controller.enqueue(encoder.encode(sseChunk({
          id: cid, object: "chat.completion.chunk", created, model, system_fingerprint: null,
          choices: [{ index: 0, delta: { content: `[Stream error: ${err.message || String(err)}]` }, finish_reason: "stop", logprobs: null }],
        })));
        controller.enqueue(encoder.encode(SSE_DONE));
      } finally {
        controller.close();
      }
    },
  });
}

async function buildNonStreamingResponse(eventStream, model, cid, created, signal) {
  let fullContent = "";
  const thinkingParts = [];
  let receivedDelta = false;

  for await (const chunk of extractContent(eventStream, signal)) {
    if (chunk.error) {
      return new Response(JSON.stringify({
        error: { message: chunk.error, type: "upstream_error", code: "DEEPSEEK_WEB_ERROR" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
    if (chunk.thinking) thinkingParts.push(chunk.thinking);
    if (chunk.done) break;
    if (chunk.delta) {
      fullContent += chunk.delta;
      receivedDelta = true;
    }
  }

  const msg = { role: "assistant", content: fullContent };
  if (thinkingParts.length > 0) msg.reasoning_content = thinkingParts.join("");

  // Token estimation as fallback (DeepSeek Web may not return usage in response)
  const promptTokens = Math.ceil((fullContent.length + 100) / 4); // buffer for prompt
  const completionTokens = receivedDelta ? Math.ceil(fullContent.length / 4) : Math.ceil((fullContent.length + 100) / 4);

  return new Response(JSON.stringify({
    id: cid, object: "chat.completion", created, model, system_fingerprint: null,
    choices: [{ index: 0, message: msg, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export class DeepSeekWebExecutor extends BaseExecutor {
  constructor() {
    super("deepseek-web", PROVIDERS["deepseek-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Missing or empty messages array", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: DSW_API, headers: {}, transformedBody: body, responseFormat: "openai" };
    }

    log?.info?.("DEEPSEEK-WEB", `Query model=${model}, msgs=${messages.length}`);

    const headers = {
      Accept: "text/event-stream",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      Origin: "https://chat.deepseek.com",
      Pragma: "no-cache",
      Referer: "https://chat.deepseek.com/",
      "Sec-Ch-Ua": '"Google Chrome";v="136", "Chromium";v="136", "Not(A:Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"Linux"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": DSW_USER_AGENT,
    };

    // Handle cookie from credentials — support full cookie string or bare token
    if (credentials.apiKey) {
      let cookieHeader = credentials.apiKey;
      if (!credentials.apiKey.includes("=")) {
        // Bare value (no key=) — wrap in userToken
        cookieHeader = `userToken=${credentials.apiKey}`;
      }
      // else: full cookie string with multiple key=value pairs — use as-is
      headers["Cookie"] = cookieHeader;
    }

    // Build payload — DeepSeek Web uses OpenAI-compatible body shape
    const payload = {
      model,
      messages,
      stream: !!stream,
    };

    let response;
    try {
      response = await fetch(DSW_API, {
        method: "POST", headers, body: JSON.stringify(payload), signal,
      });
    } catch (err) {
      log?.error?.("DEEPSEEK-WEB", `Fetch failed: ${err.message || String(err)}`);
      const errResp = new Response(JSON.stringify({
        error: { message: `DeepSeek Web connection failed: ${err.message || String(err)}`, type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: DSW_API, headers, transformedBody: payload, responseFormat: "openai" };
    }

    if (!response.ok) {
      const status = response.status;
      let errMsg = `DeepSeek Web returned HTTP ${status}`;
      if (status === 401 || status === 403) errMsg = "DeepSeek Web auth failed — session cookie may be expired. Re-paste from chat.deepseek.com DevTools.";
      else if (status === 429) errMsg = "DeepSeek Web rate limited. Wait a moment and retry.";
      log?.warn?.("DEEPSEEK-WEB", errMsg);
      const errResp = new Response(JSON.stringify({
        error: { message: errMsg, type: "upstream_error", code: `HTTP_${status}` },
      }), { status, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: DSW_API, headers, transformedBody: payload, responseFormat: "openai" };
    }

    if (!response.body) {
      const errResp = new Response(JSON.stringify({
        error: { message: "DeepSeek Web returned empty response body", type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: DSW_API, headers, transformedBody: payload, responseFormat: "openai" };
    }

    const cid = `chatcmpl-dsw-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    let finalResponse;
    if (stream) {
      const sseStream = buildStreamingResponse(response.body, model, cid, created, signal);
      finalResponse = new Response(sseStream, {
        status: 200,
        headers: { ...SSE_HEADERS_NO_BUFFER },
      });
    } else {
      finalResponse = await buildNonStreamingResponse(response.body, model, cid, created, signal);
    }
    return { response: finalResponse, url: DSW_API, headers, transformedBody: payload, responseFormat: "openai" };
  }
}

export default DeepSeekWebExecutor;
