export default {
  id: "gemini-web",
  priority: 135,
  alias: "gemini-web",
  aliases: ["gmw", "gemini-web"],
  uiAlias: "gmw",
  display: {
    name: "Gemini Web",
    icon: "auto_awesome",
    color: "#4285F4",
    textIcon: "GW",
    website: "https://gemini.google.com",
    notice: { signupUrl: "https://gemini.google.com" },
  },
  category: "webCookie",
  authType: "cookie",
  authHint:
    "Paste your full Cookie header from gemini.google.com DevTools (must contain __Secure-1PSID and __Secure-1PSIDTS)",
  transport: {
    baseUrl: "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
    format: "gemini-web",
    authType: "cookie",
  },
  models: [
    { id: "gemini-3.0-pro", name: "Gemini 3.0 Pro" },
    { id: "gemini-3.0-flash", name: "Gemini 3.0 Flash" },
    { id: "gemini-3.0-flash-thinking", name: "Gemini 3.0 Flash Thinking" },
  ],
  thinkingConfig: {
    options: ["auto", "none"],
    defaultMode: "auto"
  },
};
