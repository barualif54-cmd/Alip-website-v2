// ================= core/context.js =================
const { createUtils, escapeHtml } = require("./utils");

function createContext(deps) {
  const {
    bot, fs, path, os, https, http, moment, ytSearch, Jimp, spawn,
    notifyOwner, isBotAdmin, isOwner, OWNER_CHAT_ID, ADMIN_IDS,
    geminiApiKey, tempDir, cookiesPath, MAX_DURATION_SECONDS,
    GIPHY_API_KEY, WALLHAVEN_API_KEY,
  } = deps;

  const utils = createUtils(bot);

  const ctx = {
    bot, fs, path, os, https, http, moment, ytSearch, Jimp, spawn,
    notifyOwner, isBotAdmin, isOwner, OWNER_CHAT_ID, ADMIN_IDS,
    geminiApiKey, tempDir, cookiesPath, MAX_DURATION_SECONDS,
    GIPHY_API_KEY, WALLHAVEN_API_KEY,
    activeClocks: new Map(),
    activeGames: new Map(),
    activeSuitGames: new Map(),
    ...utils,
    escapeHtml,
    actions: {},
    config: {},
  };

  return ctx;
}

module.exports = { createContext };
