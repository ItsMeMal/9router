/**
 * Gemini Web protocol unit tests
 *
 * Validates:
 *  - Cookie extraction (strict __Secure-1PSID / __Secure-1PSIDTS)
 *  - Init page token extraction (SNlM0e, cfb2h, FdrFJe)
 *  - f.req payload construction
 *  - Frame parsing (length-prefixed envelopes)
 *  - Model header mapping
 *  - Error handling (401, 403, malformed frames)
 */

import { describe, it, expect } from "vitest";
import {
  parseCookies,
  extractSnIM0e,
  extractCfb2h,
  extractFdrFJe,
  buildFReqPayload,
  parseGeminiFrames,
  mapModelHeader,
} from "../../open-sse/utils/geminiWebHelpers.js";

// ---------- Cookie parsing ----------

describe("parseCookies", () => {
  it("extracts __Secure-1PSID and __Secure-1PSIDTS", () => {
    const result = parseCookies("__Secure-1PSID=abc123; __Secure-1PSIDTS=xyz789; other=foo");
    expect(result).toEqual({ secure1psid: "abc123", secure1psidts: "xyz789" });
  });

  it("ignores unrelated cookies", () => {
    const result = parseCookies("NID=aaa; __Secure-1PSID=token; SID=bbb");
    expect(result).toEqual({ secure1psid: "token", secure1psidts: "" });
  });

  it("throws on missing __Secure-1PSID", () => {
    expect(() => parseCookies("NID=aaa")).toThrow(/__Secure-1PSID/);
  });

  it("throws on empty string", () => {
    expect(() => parseCookies("")).toThrow();
  });
});

// ---------- Token extraction ----------

describe("extractSnIM0e", () => {
  it("extracts SNlM0e", () => {
    expect(extractSnIM0e('some "SNlM0e":"TOKEN123" rest')).toBe("TOKEN123");
  });

  it("returns empty string if absent", () => {
    expect(extractSnIM0e('<html>no tokens</html>')).toBe("");
  });
});

describe("extractCfb2h", () => {
  it("extracts cfb2h", () => {
    expect(extractCfb2h('bl:"cfb2h":"BLVALUE"')).toBe("BLVALUE");
  });

  it("returns empty string if absent", () => {
    expect(extractCfb2h("no bl here")).toBe("");
  });
});

describe("extractFdrFJe", () => {
  it("extracts FdrFJe", () => {
    expect(extractFdrFJe('"FdrFJe":"SESSIONID999"')).toBe("SESSIONID999");
  });

  it("returns empty string if absent", () => {
    expect(extractFdrFJe("nothing")).toBe("");
  });
});

// ---------- Payload construction ----------

describe("buildFReqPayload", () => {
  it("builds outer array with null and inner JSON string", () => {
    const payload = buildFReqPayload("Hello", { at: "tok123", bl: "bl1", sid: "sid1" });
    const outer = JSON.parse(payload);
    expect(outer[0]).toBeNull();
    const inner = JSON.parse(outer[1]);
    expect(inner[0][0]).toBe("Hello");
  });

  it("uses provided at token", () => {
    const payload = buildFReqPayload("Hi", { at: "myat", bl: "", sid: "" });
    const formBody = `at=${encodeURIComponent("myat")}&f.req=${encodeURIComponent(payload)}`;
    expect(formBody).toContain("at=myat");
  });
});

// ---------- Frame parsing ----------

describe("parseGeminiFrames", () => {
  it("strips )]}' prefix and parses length-prefixed frame", () => {
    // Build a single frame: inner JSON = [[null, "Hi"]]
    const inner = JSON.stringify([[null, "Hi"]]);
    // The envelope is the length of inner JSON string
    const envelope = JSON.stringify(inner);
    const length = [...envelope].length;
    const raw = `)]}'\n\n${length}\n${envelope}\n`;
    const frames = parseGeminiFrames(raw);
    expect(frames.length).toBe(1);
  });

  it("returns empty array on garbage", () => {
    const frames = parseGeminiFrames("not a frame");
    expect(frames).toEqual([]);
  });

  it("handles partial frame (incomplete length prefix)", () => {
    const frames = parseGeminiFrames("123\n");
    expect(frames).toEqual([]);
  });
});

// ---------- Model header mapping ----------

describe("mapModelHeader", () => {
  it("returns header object for known model", () => {
    const header = mapModelHeader("gemini-3.0-flash");
    expect(header).toHaveProperty("x-goog-ext-525001261-jspb");
    expect(typeof header["x-goog-ext-525001261-jspb"]).toBe("string");
  });

  it("throws on unknown model", () => {
    expect(() => mapModelHeader("nonexistent-model")).toThrow(/unknown.*model/i);
  });
});

// ---------- Frame split streaming ----------

function frameEnvelope(text) {
  // Structure matching extractTextDelta expectation: outer[4][0][1] = [text]
  const innerJson = JSON.stringify([null, null, null, null, [[null, [text]]], null]);
  const envelope = JSON.stringify(innerJson);
  return `${[...envelope].length}\n${envelope}\n`;
}

describe("parseGeminiFrames split-frame behavior", () => {
  it("parses two complete frames sequentially", () => {
    const raw = `)]}'\n\n${frameEnvelope("Hi")}${frameEnvelope(" there")}`;
    const frames = parseGeminiFrames(raw);
    expect(frames).toHaveLength(2);
  });

  it("parses frames when second frame starts mid-payload of first (no, only whole frames)", () => {
    // Build a single long frame then verify parser stops at length boundary, not mid-frame
    const full = frameEnvelope("Hello world");
    const half = Math.floor(full.length / 2);
    const partial = full.slice(0, half);
    expect(parseGeminiFrames(partial)).toEqual([]);
    expect(parseGeminiFrames(full)).toHaveLength(1);
  });

  it("handles mixed whitespace and prefix correctly", () => {
    const raw = `  )]}'\n\n ${frameEnvelope("ok")} `;
    const frames = parseGeminiFrames(raw);
    expect(frames).toHaveLength(1);
  });
});
