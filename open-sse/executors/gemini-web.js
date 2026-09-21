import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";
import { SSE_DONE, SSE_HEADERS_NO_BUFFER } from "../utils/sseConstants.js";
import { sseChunk } from "../utils/sse.js";
import {
  parseCookies,
  extractSnIM0e,
  extractCfb2h,
  extractFdrFJe,
  buildFReqPayload,
  parseGeminiFrames,
  mapModelHeader,
  parseOpenAIMessages,
  extractThinkingDelta,
} from "../utils/geminiWebHelpers.js";

const GEMINI_INIT_URL = "https://gemini.google.com/app";
const GEMINI_STREAM_URL =
  "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const GEMINI_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

/** Extract the streaming text delta from a Gemini Web frame envelope */
function extractTextDelta(frame) {
  try {
    // frame structure: [2] = inner JSON string; [4] = candidates
    if (!Array.isArray(frame) || frame[2] === undefined) return null;
    const inner = JSON.parse(frame[2]);
    const candidates = inner?.[4];
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    // candidate[1][0][1][0] is the latest text slice in some versions
    // candidate[1] is the content array
    const candidate = candidates[0];
    if (!Array.isArray(candidate)) return null;
    const contentArr = candidate[1]; // this holds the text chunks array
    if (!Array.isArray(contentArr) || contentArr.length === 0) return null;

    // The last element is the accumulated full text
    const textChunk = contentArr.find((c) => typeof c === "string" && c.length > 0);
    return textChunk || null;
  } catch {
    return null;
  }
}

/** GeminiWebExecutor — text-only Gemini Web browser-cookie provider */
export class GeminiWebExecutor extends BaseExecutor {
  constructor() {
    super("gemini-web", PROVIDERS["gemini-web"]);
  }

  async execute({ model, body, stream, credentials, signal, log }) {
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return {
        response: new Response(
          JSON.stringify({ error: { message: "Missing or empty messages array", type: "invalid_request" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
        url: GEMINI_INIT_URL,
        headers: {},
        transformedBody: body,
        responseFormat: "openai",
      };
    }

    const prompt = parseOpenAIMessages(messages);
    if (!prompt.trim()) {
      return {
        response: new Response(
          JSON.stringify({ error: { message: "Empty query after processing", type: "invalid_request" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
        url: GEMINI_INIT_URL,
        headers: {},
        transformedBody: body,
        responseFormat: "openai",
      };
    }

    // 1. Validate cookies
    let cookieHeader = "";
    try {
      parseCookies(credentials.apiKey || "");
      cookieHeader = credentials.apiKey;
    } catch (e) {
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: e.message,
              type: "invalid_credentials",
              code: "INVALID_COOKIE",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
        url: GEMINI_INIT_URL,
        headers: {},
        transformedBody: body,
        responseFormat: "openai",
      };
    }

    // 2. Validate model header mapping
    let modelHeader;
    try {
      modelHeader = mapModelHeader(model);
    } catch (e) {
      return {
        response: new Response(
          JSON.stringify({ error: { message: e.message, type: "invalid_request", code: "INVALID_MODEL" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
        url: GEMINI_INIT_URL,
        headers: {},
        transformedBody: body,
        responseFormat: "openai",
      };
    }

    log?.info?.("GEMINI-WEB", `Query model=${model}, len=${prompt.length}`);

    // 3. Init page — extract tokens
    const commonHeaders = {
      "User-Agent": GEMINI_USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate, br, zstd",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      "Cache-Control": "max-age=0",
      "Cookie": cookieHeader,
    };

    let initResp, initHtml;
    try {
      initResp = await fetch(GEMINI_INIT_URL, { method: "GET", headers: commonHeaders, signal });
      initHtml = await initResp.text();
    } catch (err) {
      return {
        response: new Response(
          JSON.stringify({ error: { message: `Gemini Web connection failed: ${err.message}`, type: "upstream_error" } }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
        url: GEMINI_INIT_URL,
        headers: { ...commonHeaders },
        transformedBody: body,
        responseFormat: "openai",
      };
    }

    // Check auth status — redirects to login mean expired cookie
    if (
      initResp.status === 302 ||
      initResp.status === 401 ||
      initResp.status === 403 ||
      initResp.url.includes("accounts.google.com") ||
      initResp.url.includes("/login")
    ) {
      return {
        response: new Response(
          JSON.stringify({
            error: {
              message: "Gemini Web auth failed — session cookie expired. Re-paste cookies from gemini.google.com DevTools.",
              type: "upstream_error",
              code: "AUTH_EXPIRED",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
        url: GEMINI_INIT_URL,
        headers: { ...commonHeaders },
        transformedBody: body,
        responseFormat: "openai",
      };
    }

    const snlm0e = extractSnIM0e(initHtml);
    const bl = extractCfb2h(initHtml);
    const sid = extractFdrFJe(initHtml);

    // 4. Build f.req payload
    const fReq = buildFReqPayload(prompt, { at: snlm0e || "", bl, sid });
    const formFields = new URLSearchParams();
    formFields.append("at", snlm0e || "");
    formFields.append("f.req", fReq);

    const streamUrl = new URL(GEMINI_STREAM_URL);
    streamUrl.searchParams.append("_reqid", `${Math.floor(Math.random() * 1_000_000_000)}`);
    if (bl) streamUrl.searchParams.append("bl", bl);
    if (sid) streamUrl.searchParams.append("f.sid", sid);

    const streamHeaders = {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      "User-Agent": GEMINI_USER_AGENT,
      Origin: "https://gemini.google.com",
      Referer: "https://gemini.google.com/",
      "X-Same-Domain": "1",
      ...modelHeader,
      "Cookie": cookieHeader,
    };

    // 5. Fetch
    let response;
    try {
      response = await fetch(streamUrl.toString(), {
        method: "POST",
        headers: streamHeaders,
        body: formFields.toString(),
        signal,
      });
    } catch (err) {
      log?.error?.("GEMINI-WEB", `Fetch failed: ${err.message}`);
      return {
        response: new Response(
          JSON.stringify({ error: { message: `Gemini Web request failed: ${err.message}`, type: "upstream_error" } }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
        url: streamUrl.toString(),
        headers: streamHeaders,
        transformedBody: fReq,
        responseFormat: "openai",
      };
    }

    if (!response.ok) {
      const status = response.status;
      let errMsg = `Gemini Web returned HTTP ${status}`;
      if (status === 401 || status === 403) {
        errMsg = "Gemini Web auth failed — session cookie expired. Re-paste from gemini.google.com DevTools.";
      } else if (status === 429) {
        errMsg = "Gemini Web rate limited. Wait a moment and retry.";
      }
      log?.warn?.("GEMINI-WEB", errMsg);
      return {
        response: new Response(
          JSON.stringify({ error: { message: errMsg, type: "upstream_error", code: `HTTP_${status}` } }),
          { status: status > 400 ? status : 502, headers: { "Content-Type": "application/json" } },
        ),
        url: streamUrl.toString(),
        headers: streamHeaders,
        transformedBody: fReq,
        responseFormat: "openai",
      };
    }

    if (!response.body) {
      return {
        response: new Response(
          JSON.stringify({ error: { message: "Gemini Web returned empty response body", type: "upstream_error" } }),
          { status: 502, headers: { "Content-Type": "application/json" } },
        ),
        url: streamUrl.toString(),
        headers: streamHeaders,
        transformedBody: fReq,
        responseFormat: "openai",
      };
    }

    const cid = `chatcmpl-gw-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    let finalResponse;
    if (stream) {
      finalResponse = new Response(this.buildStreamingResponse(response.body, model, cid, created, signal), {
        status: 200,
        headers: { ...SSE_HEADERS_NO_BUFFER },
      });
    } else {
      finalResponse = await this.buildNonStreamingResponse(response.body, model, cid, created, signal);
    }

    return { response: finalResponse, url: streamUrl.toString(), headers: streamHeaders, transformedBody: fReq, responseFormat: "openai" };
  }

  async readRawText(body, signal) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    try {
      while (true) {
        if (signal?.aborted) break;
        const { value, done } = await reader.read();
        if (done) break;
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
    } finally {
      reader.releaseLock();
    }
    return raw;
  }

  async buildNonStreamingResponse(body, model, cid, created, signal) {
    const raw = await this.readRawText(body, signal);
    const frames = parseGeminiFrames(raw);
    let fullContent = "";
    const thinkingParts = [];

    for (const frame of frames) {
      const text = extractTextDelta(frame);
      if (text && typeof text === "string") {
        fullContent = text; // full accumulated text
      }
      const thinking = extractThinkingDelta(frame);
      if (thinking && typeof thinking === "string") {
        thinkingParts.push(thinking);
      }
    }

    const msg = { role: "assistant", content: fullContent };
    if (thinkingParts.length > 0) msg.reasoning_content = thinkingParts.join("");
    const tokenEstimate = Math.max(1, Math.round(fullContent.length / 4));

    return new Response(
      JSON.stringify({
        id: cid,
        object: "chat.completion",
        created,
        model,
        system_fingerprint: null,
        choices: [{ index: 0, message: msg, finish_reason: "stop", logprobs: null }],
        usage: { prompt_tokens: tokenEstimate, completion_tokens: tokenEstimate, total_tokens: tokenEstimate * 2 },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  buildStreamingResponse(body, model, cid, created, signal) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(
            encoder.encode(
              sseChunk({
                id: cid,
                object: "chat.completion.chunk",
                created,
                model,
                system_fingerprint: null,
                choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null, logprobs: null }],
              }),
            ),
          );

          let fullText = "";
          const thinkingParts = [];

          for await (const frame of readStream(body, signal)) {
            // Check for thinking block first
            const thinking = extractThinkingDelta(frame);
            if (thinking && typeof thinking === "string") {
              thinkingParts.push(thinking);
            }

            const text = extractTextDelta(frame);
            if (!text || typeof text !== "string") continue;

            // Only emit new text, not the full accumulated copy
            if (text.length > fullText.length && text.startsWith(fullText)) {
              const delta = text.slice(fullText.length);
              fullText = text;
              if (delta) {
                controller.enqueue(
                  encoder.encode(
                    sseChunk({
                      id: cid,
                      object: "chat.completion.chunk",
                      created,
                      model,
                      system_fingerprint: null,
                      choices: [{ index: 0, delta: { content: delta }, finish_reason: null, logprobs: null }],
                    }),
                  ),
                );
              }
            }
          }

          // Emit collected thinking as reasoning_content
          if (thinkingParts.length > 0) {
            controller.enqueue(
              encoder.encode(
                sseChunk({
                  id: cid,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  system_fingerprint: null,
                  choices: [{ index: 0, delta: { reasoning_content: thinkingParts.join("") }, finish_reason: null, logprobs: null }],
                }),
              ),
            );
          }

          controller.enqueue(
            encoder.encode(
              sseChunk({
                id: cid,
                object: "chat.completion.chunk",
                created,
                model,
                system_fingerprint: null,
                choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }],
              }),
            ),
          );
          controller.enqueue(encoder.encode(SSE_DONE));
        } catch (err) {
          log?.error?.("GEMINI-WEB", `Stream error: ${err.message}`);
          controller.enqueue(
            encoder.encode(
              sseChunk({
                id: cid,
                object: "chat.completion.chunk",
                created,
                model,
                system_fingerprint: null,
                choices: [
                  {
                    index: 0,
                    delta: { content: `[Error: ${err.message || String(err)}]` },
                    finish_reason: "stop",
                    logprobs: null,
                  },
                ],
              }),
            ),
          );
          controller.enqueue(encoder.encode(SSE_DONE));
        } finally {
          controller.close();
        }
      },
    });
  }
}

async function* readStream(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Parse complete frames from buffer, keep partial remainder
      const frames = parseGeminiFrames(buffer);
      if (frames.length > 0) {
        for (const frame of frames) {
          yield frame;
        }
        // Calculate consumed characters and trim buffer
        // Re-parse to find where we left off (last complete frame end)
        let pos = 0;
        while (pos < buffer.length) {
          const newlineIdx = buffer.indexOf("\n", pos);
          if (newlineIdx === -1) break;
          const lenStr = buffer.slice(pos, newlineIdx).trim();
          const charCount = parseInt(lenStr, 10);
          if (isNaN(charCount) || charCount <= 0) {
            pos = newlineIdx + 1;
            continue;
          }
          const payloadStart = newlineIdx + 1;
          const payloadEnd = payloadStart + charCount;
          if (payloadEnd > buffer.length) break;
          pos = payloadEnd;
        }
        buffer = buffer.slice(pos);
      }
    }
    buffer += decoder.decode();
    // Final parse of remaining buffer
    const frames = parseGeminiFrames(buffer);
    for (const frame of frames) {
      yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

export default GeminiWebExecutor;
