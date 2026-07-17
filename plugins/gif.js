// ================= plugins/gif.js =================
// Fitur /gif (cari GIF lewat Giphy).
module.exports = function gifPlugin(ctx) {
  const { bot, createProgressUpdater, simulateProgress } = ctx;

const GIPHY_API_KEY = process.env.GIPHY_API_KEY || "JJggxak1xTyHJ2LuXCMP4XQlkH0Uqhu1";

if (!process.env.GIPHY_API_KEY) {
  console.warn(
    "⚠️ GIPHY_API_KEY tidak ditemukan di .env — fitur /gif memakai public beta key Giphy " +
      "yang gampang kena rate-limit/error. Daftar API key gratis sendiri di " +
      "https://developers.giphy.com lalu taruh di .env sebagai GIPHY_API_KEY=xxxx"
  );
}

async function searchGifs(query) {
  const url =
    `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(GIPHY_API_KEY)}` +
    `&q=${encodeURIComponent(query)}&limit=10&rating=g`;
  const res = await fetch(url);

  if (!res.ok) {
    // Ambil body error asli dari Giphy (kalau ada) biar kelihatan di log alasan
    // sebenarnya: 401/403 = key invalid/ditolak, 429 = kena rate limit, dll.
    let detail = "";
    try {
      const errJson = await res.json();
      detail = errJson?.message ? ` - ${errJson.message}` : "";
    } catch (e) {
      // body bukan JSON, abaikan
    }
    const err = new Error(`Giphy error: status ${res.status}${detail}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return (data.data || [])
    .map((g) => ({
      // Urutan fallback kualitas: original -> downsized -> fixed_height,
      // biar tetap ada yang kepakai kalau salah satu field kosong.
      url:
        g.images?.original?.url ||
        g.images?.downsized?.url ||
        g.images?.fixed_height?.url,
      title: g.title,
    }))
    .filter((g) => g.url);
}

bot.onText(/^\/gif (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  await bot.sendChatAction(chatId, "upload_video");

  const progress = createProgressUpdater(chatId, `Mencari gif untuk "${query}"...`);
  await progress.start(0);
  const stopSim = simulateProgress(progress, { max: 85, stepMs: 350 });

  try {
    const results = await searchGifs(query);
    stopSim();

    if (!results.length) {
      await progress.remove();
      return bot.sendMessage(chatId, "❌ Gif tidak ditemukan untuk: " + query);
    }
    await progress.update(90, "Mengirim gif...");

    // Coba beberapa hasil teratas, karena kadang satu URL gif sudah mati
    let sent = false;
    let lastError;
    for (const item of results.slice(0, 5)) {
      try {
        await bot.sendAnimation(chatId, item.url, {
          caption: `🎞️ <b>Hasil pencarian gif:</b> ${query}${
            item.title ? `\n<i>${item.title}</i>` : ""
          }`,
          parse_mode: "HTML",
        });
        sent = true;
        break;
      } catch (err) {
        lastError = err;
        continue;
      }
    }

    if (!sent) {
      throw lastError || new Error("Semua hasil gagal dikirim");
    }
    await progress.remove();
  } catch (e) {
    console.error("Gagal /gif:", e.message);
    stopSim();
    await progress.remove();

    let userMsg = "❌ Terjadi error saat mencari gif. Coba kata kunci lain.";
    if (e.status === 429) {
      userMsg =
        "❌ Kuota pencarian gif sedang habis (kena rate-limit). " +
        "Coba lagi sebentar, atau minta admin bot daftar GIPHY_API_KEY sendiri biar tidak gampang habis.";
    } else if (e.status === 401 || e.status === 403) {
      userMsg = "❌ API key Giphy ditolak/tidak valid. Cek GIPHY_API_KEY di .env.";
    }
    bot.sendMessage(chatId, userMsg);
  }
});


  bot.onText(/^\/gif$/, (msg) =>
    bot.sendMessage(msg.chat.id, "⚠️ Format: <code>/gif kucing lucu</code>", { parse_mode: "HTML" })
  );
};
