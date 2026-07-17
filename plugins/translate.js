// ================= plugins/translate.js =================
module.exports = function translatePlugin(ctx) {
  const { bot } = ctx;

const LANG_ALIASES = {
  indonesia: "id", indo: "id",
  inggris: "en", english: "en",
  jepang: "ja", japan: "ja",
  korea: "ko",
  arab: "ar",
  mandarin: "zh-CN", china: "zh-CN", cina: "zh-CN",
  spanyol: "es", spanish: "es",
  perancis: "fr", french: "fr", prancis: "fr",
  jerman: "de", german: "de",
  thailand: "th",
  vietnam: "vi",
  melayu: "ms", malaysia: "ms",
  belanda: "nl", dutch: "nl",
  rusia: "ru", russian: "ru",
  india: "hi", hindi: "hi",
  italia: "it", italian: "it",
  portugis: "pt", portuguese: "pt",
};

function resolveLangCode(input) {
  const lower = input.toLowerCase();
  return LANG_ALIASES[lower] || lower;
}

async function translateText(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(
    targetLang
  )}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  const translated = data[0].map((chunk) => chunk[0]).join("");
  const detectedLang = data[2] || "auto";
  return { translated, detectedLang };
}

bot.onText(/^\/translate(?:\s+(\S+))?(?:\s+([\s\S]+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const langInput = match[1];
  const inlineText = match[2] ? match[2].trim() : null;

  if (!langInput) {
    return bot.sendMessage(
      chatId,
      `ℹ️ Format: <code>/translate en Halo, apa kabar?</code>\n` +
        `Atau reply pesan teks lalu ketik <code>/translate en</code>\n\n` +
        `Kode bahasa umum: en (Inggris), id (Indonesia), ja (Jepang), ko (Korea), ar (Arab), zh-CN (Mandarin), es (Spanyol), fr (Perancis), de (Jerman)\n` +
        `Bisa juga pakai nama biasa: <code>/translate inggris</code>, <code>/translate jepang</code>, dll.`,
      { parse_mode: "HTML" }
    );
  }

  const targetLang = resolveLangCode(langInput);
  const text = inlineText || (msg.reply_to_message && msg.reply_to_message.text);

  if (!text) {
    return bot.sendMessage(
      chatId,
      "ℹ️ Teks yang mau diterjemahkan mana? Tulis setelah kode bahasa, atau reply pesan teks lalu ketik command ini."
    );
  }

  try {
    const { translated, detectedLang } = await translateText(text, targetLang);
    bot.sendMessage(
      chatId,
      `🌐 <b>Translate</b> (${detectedLang} ➜ ${targetLang})\n\n${translated}`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    console.error("⚠️ Gagal translate:", e.message);
    bot.sendMessage(chatId, "❌ Gagal menerjemahkan, coba lagi nanti.");
  }
});
};
