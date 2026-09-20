import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";

const CHATGPT_API = PROVIDERS["chatgpt-web"].baseUrl;
const CHATGPT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

const MODEL_MAP = {
  "gpt-5": { modelSlug: "gpt-5" },
  "gpt-5-thinking": { modelSlug: "gpt-5", reasoning: true },
  "gpt-5-mini": { modelSlug: "gpt-5-mini" },
  "gpt-5-mini-thinking": { modelSlug: "gpt-5-mini", reasoning: true },
  "gpt-4o": { modelSlug: "gpt-4o" },
  "gpt-4o-mini": { modelSlug: "gpt-4o-mini" },
  "o1": { modelSlug: "o1" },
  "o1-mini": { modelSlug: "o1-mini" },
  "o1-pro": { modelSlug: "o1-pro" },
};

function randomHex(bytes) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

function parseOpenAIMessages(messages) {
  const extracted = [];
  for (const msg of messages) {
    let role = String(msg.role || "user");
    if (role === "developer") role = "system";
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.filter((c) => c.type === "text").map((c) => String(c.text || "")).join(" ");
    }
    if (!content.trim()) continue;
    extracted.push({ role, text: content });
  }

  let lastUserIdx = -1;
  for (let i = extracted.length - 1; i >= 0; i--) {
    if (extracted[i].role === "user") { lastUserIdx = i; break; }
  }

  const parts = [];
  for (let i = 0; i < extracted.length; i++) {
    const { role, text } = extracted[i];
    parts.push(i === lastUserIdx ? text : `${role}: ${text}`);
  }
  return parts.join("\n\n");
}

async function* readChatGPTEvents(body, signal) {
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
  let messageId = "";
  let conversationId = "";

  for await (const event of readChatGPTEvents(eventStream, signal)) {
    if (event.error) {
      yield { error: event.error.message || `ChatGPT error: ${event.error.code}`, done: true };
      return;
    }

    if (event.message?.id) messageId = event.message.id;
    if (event.conversation_id) conversationId = event.conversation_id;

    const msg = event.message;
    if (!msg) continue;

    const content = msg.content;
    if (!content) continue;

    const parts = content.parts;
    if (!Array.isArray(parts)) continue;

    for (const part of parts) {
      if (typeof part === "string") {
        yield { delta: part, messageId, conversationId };
      }
    }
  }
  yield { done: true, messageId, conversationId };
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

  for await (const chunk of extractContent(eventStream, signal)) {
    if (chunk.error) {
      return new Response(JSON.stringify({
        error: { message: chunk.error, type: "upstream_error", code: "CHATGPT_ERROR" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
    }
    if (chunk.done) break;
    if (chunk.delta) fullContent += chunk.delta;
  }

  const msg = { role: "assistant", content: fullContent };

  const promptTokens = Math.ceil(fullContent.length / 4);
  const completionTokens = Math.ceil(fullContent.length / 4);

  return new Response(JSON.stringify({
    id: cid, object: "chat.completion", created, model, system_fingerprint: null,
    choices: [{ index: 0, message: msg, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

export class ChatGPTWebExecutor extends BaseExecutor {
  constructor() {
    super("chatgpt-web", PROVIDERS["chatgpt-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Missing or empty messages array", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHATGPT_API, headers: {}, transformedBody: body };
    }

    const modelInfo = MODEL_MAP[model];
    if (!modelInfo) log?.info?.("CHATGPT-WEB", `Unmapped model ${model}, defaulting to gpt-4o`);
    const { modelSlug, reasoning } = modelInfo || MODEL_MAP["gpt-4o"];

    const prompt = parseOpenAIMessages(messages);
    if (!prompt.trim()) {
      const errResp = new Response(JSON.stringify({
        error: { message: "Empty query after processing", type: "invalid_request" },
      }), { status: 400, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHATGPT_API, headers: {}, transformedBody: body };
    }

    const messageId = crypto.randomUUID();
    const parentMessageId = crypto.randomUUID();

    const chatgptPayload = {
      action: "next",
      messages: [{
        id: messageId,
        author: { role: "user" },
        content: { content_type: "text", parts: [prompt] },
        metadata: {},
      }],
      model: modelSlug,
      parent_message_id: parentMessageId,
    };

    const headers = {
      Accept: "text/event-stream",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
      Origin: "https://chatgpt.com",
      Pragma: "no-cache",
      Referer: "https://chatgpt.com/",
      "Sec-Ch-Ua": '"Google Chrome";v="136", "Chromium";v="136", "Not(A:Brand";v="24"',
      "Sec-Ch-Ua-Mobile": "?0",
      "Sec-Ch-Ua-Platform": '"macOS"',
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": CHATGPT_USER_AGENT,
    };

    // Handle cookie from credentials
    if (credentials.apiKey) {
      let token = credentials.apiKey;
      if (token.startsWith("__Secure-next-auth.session-token=")) {
        token = token.slice("__Secure-next-auth.session-token=".length);
      }
      headers["Cookie"] = `__Secure-next-auth.session-token=${token}`;
    }

    log?.info?.("CHATGPT-WEB", `Query to ${model} (slug=${modelSlug}), len=${prompt.length}`);

    let response;
    try {
      response = await fetch(CHATGPT_API, {
        method: "POST", headers, body: JSON.stringify(chatgptPayload), signal,
      });
    } catch (err) {
      log?.error?.("CHATGPT-WEB", `Fetch failed: ${err.message || String(err)}`);
      const errResp = new Response(JSON.stringify({
        error: { message: `ChatGPT connection failed: ${err.message || String(err)}`, type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHATGPT_API, headers, transformedBody: chatgptPayload };
    }

    if (!response.ok) {
      const status = response.status;
      let errMsg = `ChatGPT returned HTTP ${status}`;
      if (status === 401 || status === 403) errMsg = "ChatGPT auth failed — session cookie may be expired. Re-paste your __Secure-next-auth.session-token from chatgpt.com DevTools.";
      else if (status === 429) errMsg = "ChatGPT rate limited. Wait a moment and retry.";
      log?.warn?.("CHATGPT-WEB", errMsg);
      const errResp = new Response(JSON.stringify({
        error: { message: errMsg, type: "upstream_error", code: `HTTP_${status}` },
      }), { status, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHATGPT_API, headers, transformedBody: chatgptPayload };
    }

    if (!response.body) {
      const errResp = new Response(JSON.stringify({
        error: { message: "ChatGPT returned empty response body", type: "upstream_error" },
      }), { status: 502, headers: { "Content-Type": "application/json" } });
      return { response: errResp, url: CHATGPT_API, headers, transformedBody: chatgptPayload };
    }

    const cid = `chatcmpl-cgw-${crypto.randomUUID().slice(0, 12)}`;
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
    return { response: finalResponse, url: CHATGPT_API, headers, transformedBody: chatgptPayload };
  }
}

export default ChatGPTWebExecutor;