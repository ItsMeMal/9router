export default {
  id: "deepseek-web",
  priority: 130,
  alias: "deepseek-web",
  aliases: ["dsw", "deepseek-web"],
  uiAlias: "dsw",
  display: {
    name: "DeepSeek Web",
    icon: "stars",
    color: "#4B8BF5",
    textIcon: "DS",
    website: "https://chat.deepseek.com",
    notice: {
      signupUrl: "https://chat.deepseek.com",
    },
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Paste your userToken cookie or full Cookie header from chat.deepseek.com",
  transport: {
    baseUrl: "https://chat.deepseek.com/api/v0/chat/completion",
    format: "deepseek-web",
    authType: "cookie",
  },
  models: [
    { id: "deepseek-chat", name: "DeepSeek V3" },
    { id: "deepseek-reasoner", name: "DeepSeek R1" },
  ],
  passthroughModels: true,
  thinkingConfig: {
    options: ["auto", "none", "low", "medium", "high"],
    defaultMode: "auto"
  },
};
