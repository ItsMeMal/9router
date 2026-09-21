/**
 * Gemini Web protocol helpers
 *
 * Pure functions for:
 *  - Cookie parsing (__Secure-1PSID / __Secure-1PSIDTS)
 *  - Init page token extraction (SNlM0e, cfb2h, FdrFJe)
 *  - f.req payload construction
 *  - Length-prefixed frame parsing
 *  - Model header mapping
 */

// ---------- Cookie parsing ----------

/**
 * Parse a raw Cookie header string, extracting the required Gemini Web cookies.
 * @param {string} rawCookieHeader - full Cookie header value
 * @returns {{ secure1psid: string, secure1psidts: string }}
 * @throws if __Secure-1PSID is missing
 */
export function parseCookies(rawCookieHeader) {
  if (!rawCookieHeader || typeof rawCookieHeader !== "string") {
    throw new Error("Cookie header is empty or invalid — paste your full Cookie header from gemini.google.com");
  }

  let secure1psid = "";
  let secure1psidts = "";

  const pairs = rawCookieHeader.split(";");
  for (const pair of pairs) {
    const trimmed = pair.trim();
    if (trimmed.startsWith("__Secure-1PSID=")) {
      secure1psid = trimmed.slice("__Secure-1PSID=".length).trim();
    } else if (trimmed.startsWith("__Secure-1PSIDTS=")) {
      secure1psidts = trimmed.slice("__Secure-1PSIDTS=".length).trim();
    }
  }

  if (!secure1psid) {
    throw new Error("__Secure-1PSID cookie not found — paste your full Cookie header from gemini.google.com DevTools");
  }

  return { secure1psid, secure1psidts };
}

// ---------- Token extraction ----------

/**
 * Extract SNlM0e access token from init page HTML.
 * @param {string} html
 * @returns {string} token value or empty string
 */
export function extractSnIM0e(html) {
  if (!html || typeof html !== "string") return "";
  const match = html.match(/"SNlM0e":"([^"]+)"/);
  return match ? match[1] : "";
}

/**
 * Extract cfb2h build label from init page HTML.
 * @param {string} html
 * @returns {string} bl value or empty string
 */
export function extractCfb2h(html) {
  if (!html || typeof html !== "string") return "";
  const match = html.match(/"cfb2h":"([^"]+)"/);
  return match ? match[1] : "";
}

/**
 * Extract FdrFJe session ID from init page HTML.
 * @param {string} html
 * @returns {string} session id or empty string
 */
export function extractFdrFJe(html) {
  if (!html || typeof html !== "string") return "";
  const match = html.match(/"FdrFJe":"([^"]+)"/);
  return match ? match[1] : "";
}

// ---------- Payload construction ----------

/**
 * Build the outer f.req array for a single-turn text prompt.
 * @param {string} text - user prompt
 * @param {{ at?: string, bl?: string, sid?: string }} meta - tokens from init page
 * @returns {string} JSON-encoded outer array [null, innerJsonString]
 */
export function buildFReqPayload(text, meta = {}) {
  const inner = Array(73).fill(null);
  inner[0] = [text, 0, null, null, null, null, 0];
  inner[2] = ["", "", meta.bl || "", null, null, null, null, null, null, meta.sid || ""];
  inner[7] = 1;

  return JSON.stringify([null, JSON.stringify(inner)]);
}

// ---------- Frame parsing ----------

/**
 * Parse length-prefixed frames from the StreamGenerate response body.
 * Protocol:
 *   Optional anti-XSSI prefix: )]}'
 *   Then repeated: <utf16-char-count>\n<json>\n
 *
 * @param {string} rawBody
 * @returns {any[]} parsed JSON objects (envelopes)
 */
export function parseGeminiFrames(rawBody) {
  if (!rawBody || typeof rawBody !== "string") return [];

  // Strip anti-XSSI prefix and leading whitespace
  let body = rawBody.replace(/^\)\]\}'\s*/, "").trim();
  if (!body) return [];

  const frames = [];
  let pos = 0;

  while (pos < body.length) {
    // Find the newline after the length number
    const newlineIdx = body.indexOf("\n", pos);
    if (newlineIdx === -1) break;

    const lenStr = body.slice(pos, newlineIdx).trim();
    const charCount = parseInt(lenStr, 10);
    if (isNaN(charCount) || charCount <= 0) {
      // Not a valid frame; skip to next newline
      pos = newlineIdx + 1;
      continue;
    }

    // The JSON payload starts after this newline
    const payloadStart = newlineIdx + 1;
    // We need to read exactly `charCount` characters from payloadStart
    const payloadEnd = payloadStart + charCount;
    if (payloadEnd > body.length) {
      // Incomplete frame
      break;
    }

    const frameStr = body.slice(payloadStart, payloadEnd);
    try {
      const parsed = JSON.parse(frameStr);
      frames.push(parsed);
    } catch {
      // Malformed JSON in frame; skip
    }

    pos = payloadEnd;
  }

  return frames;
}

// ---------- Model header mapping ----------

// Each model requires an opaque x-goog-ext-525001261-jspb header.
// These values are volatile and will break when Google updates their frontend.
// Headed by the 3 models confirmed from xob0t/Gemini-API constants.py (as of Sep 2026).
const MODEL_HEADERS = {
  "gemini-3.0-pro": '[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4],null,null,1]',
  "gemini-3.0-flash": '[1,null,null,null,"fbb127bbb056c959",null,null,0,[4],null,null,1]',
  "gemini-3.0-flash-thinking": '[1,null,null,null,"5bf011840784117a",null,null,0,[4],null,null,1]',
};

/**
 * Get the model header object for a given model id.
 * @param {string} modelId
 * @returns {{ "x-goog-ext-525001261-jspb": string }}
 * @throws if model is unknown
 */
export function mapModelHeader(modelId) {
  const value = MODEL_HEADERS[modelId];
  if (!value) {
    throw new Error(`Unknown Gemini Web model "${modelId}" — supported: ${Object.keys(MODEL_HEADERS).join(", ")}`);
  }
  return { "x-goog-ext-525001261-jspb": value };
}

// ---------- Message parsing ----------

/**
 * Parse an OpenAI chat messages array into a single prompt string.
 * System/developer messages are prepended; developer becomes user role.
 * @param {Array<{role: string, content: string | Array}>} messages
 * @returns {string}
 */
export function parseOpenAIMessages(messages) {
  if (!messages || !Array.isArray(messages) || messages.length === 0) return "";

  const parts = [];
  let lastUserIdx = -1;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let role = msg.role || "user";
    if (role === "developer") role = "user";
    let content = "";

    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.filter((c) => c.type === "text").map((c) => String(c.text || "")).join(" ");
    }

    if (!content.trim()) continue;

    // System context goes first. Non-final messages keep their role labels;
    // the final user message is the actual Gemini prompt body.
    if (role === "system") {
      parts.push(content);
    } else if (i === lastUserIdx) {
      parts.push(content);
    } else {
      const label = role === "developer" ? "user" : role;
      parts.push(`${label}: ${content}`);
    }
  }

  return parts.join("\n\n") || "";
}
