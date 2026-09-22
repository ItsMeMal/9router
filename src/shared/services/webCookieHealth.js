// Web cookie health check scheduler — probes webCookie category providers
// periodically and marks accounts unavailable when cookies expire.
// Fail-open: tick errors never kill the interval; individual failures log only.

import * as log from "@/sse/utils/logger.js";
import { updateProviderConnection } from "@/lib/db/repos/connectionsRepo.js";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INITIAL_DELAY_MS = 30 * 1000; // 30 seconds
const WEB_COOKIE_PROVIDERS = new Set(["deepseek-web", "gemini-web", "chatgpt-web", "grok-web", "perplexity-web"]);

let started = false;
let intervalHandle = null;
let initialTimeoutHandle = null;
let tickRunning = false;

function isTruthyEnv(value) {
  if (value == null || value === "") return false;
  const v = String(value).trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function isNonServerRuntime() {
  if (typeof window !== "undefined") return true;
  const phase = process.env.NEXT_PHASE || "";
  if (
    phase === "phase-production-build" ||
    phase === "phase-export" ||
    phase === "phase-static"
  ) {
    return true;
  }
  if (process.env.NEXT_RUNTIME === "edge") return true;
  return false;
}

/** Get active webCookie connections from the DB */
async function loadWebCookieConnections() {
  const { getProviderConnections } = await import("../../lib/db/repos/connectionsRepo.js");
  const all = await getProviderConnections({ isActive: true });
  return all.filter(c => c.provider && WEB_COOKIE_PROVIDERS.has(c.provider));
}

/**
 * Probe a web provider's health endpoint.
 * Returns { healthy: boolean, markUnavailable: boolean, reason?: string }
 */
async function probeWebProviderHealth(provider, apiKey) {
  // Parse cookie header
  let cookieHeader = apiKey;
  let healthParams = {};

  if (provider === "deepseek-web") {
    if (!apiKey.includes("=")) cookieHeader = `userToken=${apiKey}`;
    const res = await fetch("https://chat.deepseek.com/api/v0/chat/completion", {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Origin: "https://chat.deepseek.com",
        Referer: "https://chat.deepseek.com/",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "ping" }],
        stream: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { healthy: false, markUnavailable: true, reason: `HTTP ${res.status}` };
    }
    return { healthy: true, markUnavailable: false };
  }

  if (provider === "gemini-web") {
    if (!apiKey.includes("__Secure-1PSID")) {
      return { healthy: false, markUnavailable: true, reason: "Missing __Secure-1PSID cookie" };
    }
    const res = await fetch("https://gemini.google.com/app", {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        Cookie: cookieHeader,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 302 || res.status === 401 || res.status === 403) {
      return { healthy: false, markUnavailable: true, reason: `HTTP ${res.status}` };
    }
    const html = await res.text();
    if (html.includes("SNlM0e") || html.includes("cfb2h") || html.includes("FdrFJe")) {
      return { healthy: true, markUnavailable: false };
    }
    return { healthy: true, markUnavailable: false, reason: "Init tokens not detected (may be restricted)" };
  }

  if (provider === "chatgpt-web") {
    if (!apiKey.includes("=")) cookieHeader = `__Secure-next-auth.session-token=${apiKey}`;
    else if (!apiKey.startsWith("__Secure-next-auth.session-token=")) {
      // Full cookie string assumed valid
    }
    const res = await fetch("https://chatgpt.com/backend-api/conversation", {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        Cookie: cookieHeader,
      },
      body: JSON.stringify({
        action: "next",
        messages: [{ id: crypto.randomUUID(), author: { role: "user" }, content: { content_type: "text", parts: ["ping"] } }],
        model: "gpt-4o",
        parent_message_id: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(8000),
    });
    // ChatGPT may block server-side probes
    if (res.status === 401 || res.status === 403) {
      return { healthy: false, markUnavailable: true, reason: `HTTP ${res.status}` };
    }
    return { healthy: true, markUnavailable: false };
  }

  if (provider === "grok-web") {
    const token = apiKey.startsWith("sso=") ? apiKey.slice(4) : apiKey;
    const res = await fetch("https://grok.com/rest/app-chat/conversations/new", {
      method: "POST",
      headers: {
        Accept: "*/*", "Content-Type": "application/json",
        Origin: "https://grok.com", Referer: "https://grok.com/",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        Cookie: `sso=${token}`,
      },
      body: JSON.stringify({
        temporary: true, modelName: "grok-4", modelMode: "MODEL_MODE_GROK_4",
        message: "ping", fileAttachments: [], imageAttachments: [],
        disableSearch: false, enableImageGeneration: false, returnImageBytes: false,
        returnRawGrokInXaiRequest: false, enableImageStreaming: false, imageGenerationCount: 0,
        forceConcise: false, toolOverrides: {}, enableSideBySide: true, sendFinalMetadata: true,
        isReasoning: false, disableTextFollowUps: true, disableMemory: true,
        forceSideBySide: false, isAsyncChat: false, disableSelfHarmShortCircuit: false,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { healthy: false, markUnavailable: true, reason: `HTTP ${res.status}` };
    }
    return { healthy: true, markUnavailable: false };
  }

  if (provider === "perplexity-web") {
    const sessionToken = apiKey.startsWith("__Secure-next-auth.session-token=")
      ? apiKey.slice("__Secure-next-auth.session-token=".length)
      : apiKey;
    const res = await fetch("https://www.perplexity.ai/rest/sse/perplexity_ask", {
      method: "POST",
      headers: {
        "Content-Type": "application/json", Accept: "text/event-stream",
        Origin: "https://www.perplexity.ai", Referer: "https://www.perplexity.ai/",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        Cookie: `__Secure-next-auth.session-token=${sessionToken}`,
      },
      body: JSON.stringify({
        query_str: "ping",
        params: { query_str: "ping", search_focus: "internet", mode: "concise", model_preference: "pplx_pro",
          sources: [], frontend_uuid: crypto.randomUUID(), frontend_context_uuid: crypto.randomUUID(),
          version: "2.18", language: "en-US", timezone: "UTC", search_recency_filter: null,
          is_incognito: true, use_schematized_api: true, last_backend_uuid: null,
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 401 || res.status === 403) {
      return { healthy: false, markUnavailable: true, reason: `HTTP ${res.status}` };
    }
    return { healthy: true, markUnavailable: false };
  }

  return { healthy: true, markUnavailable: false };
}

/** Mark connection as unavailable with a 24h cooldown */
async function markConnectionUnavailable(conn, reason) {
  const cooldownMs = 24 * 60 * 60 * 1000; // 24 hours
  const cooldownUntil = new Date(Date.now() + cooldownMs).toISOString();

  await updateProviderConnection(conn.id, {
    testStatus: "unavailable",
    lastError: reason,
    errorCode: 401,
    lastErrorAt: new Date().toISOString(),
    unavailableUntil: cooldownUntil,
    [`modelLock___all`]: cooldownUntil,
  });
}

/** One scheduler tick */
export async function runWebCookieHealthTick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const connections = await loadWebCookieConnections();
    const offlineBefore = Date.now() - (24 * 60 * 60 * 1000); // 24h ago

    for (const conn of connections) {
      // Skip if just marked unavailable recently
      if (conn.lastErrorAt && new Date(conn.lastErrorAt).getTime() > offlineBefore) {
        continue;
      }

      try {
        const result = await probeWebProviderHealth(conn.provider, conn.apiKey || conn.accessToken);
        if (!result.healthy && result.markUnavailable) {
          log.warn("WebCookieHealth", `Cookie expired for ${conn.provider}:${conn.id?.slice(0,8)} - ${result.reason}`);
          await markConnectionUnavailable(conn, result.reason || "Cookie expired");
        } else if (result.healthy === false) {
          log.warn("WebCookieHealth", `Health check failed for ${conn.provider}:${conn.id?.slice(0,8)} - ${result.reason}`);
        } else if (conn.testStatus === "unavailable" && conn.unavailableUntil) {
          // Cookie worked again - clear unavailable status
          await updateProviderConnection(conn.id, {
            testStatus: "active",
            lastError: null,
            errorCode: null,
            lastErrorAt: null,
            unavailableUntil: null,
          });
          log.info("WebCookieHealth", `Cookie restored for ${conn.provider}:${conn.id?.slice(0,8)}`);
        }
      } catch (err) {
        log.warn("WebCookieHealth", `Probe error for ${conn.provider}:${conn.id?.slice(0,8)}`, { error: err.message });
      }
    }
  } finally {
    tickRunning = false;
  }
}

/** Start the interval */
export function startWebCookieHealth({ intervalMs } = {}) {
  if (started) return false;
  if (isTruthyEnv(process.env.DISABLE_WEB_COOKIE_HEALTH)) return false;
  if (isNonServerRuntime()) return false;

  started = true;
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;

  const safeTick = () => {
    runWebCookieHealthTick().catch((err) => {
      log.warn("WebCookieHealth", "Unhandled tick rejection", { error: err?.message });
    });
  };

  initialTimeoutHandle = setTimeout(safeTick, INITIAL_DELAY_MS);
  if (initialTimeoutHandle.unref) initialTimeoutHandle.unref();

  intervalHandle = setInterval(safeTick, period);
  if (intervalHandle.unref) intervalHandle.unref();

  return true;
}

export function stopWebCookieHealth() {
  if (initialTimeoutHandle) {
    clearTimeout(initialTimeoutHandle);
    initialTimeoutHandle = null;
  }
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}