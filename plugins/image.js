// ================= plugins/image.js =================
// Fitur /image (cari gambar umum lewat Openverse, gratis tanpa API key).
module.exports = function imagePlugin(ctx) {
  const { bot, createProgressUpdater, simulateProgress } = ctx;

async function searchImages(query) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(
    query
  )}&page_size=10`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Openverse error: status ${res.status}`);
  }
  const data = await res.json();
  return (data.results || []).filter((r) => r.url);
}

bot.onText(/^\/image (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  await bot.sendChatAction(chatId, "upload_photo");

  const progress = createProgressUpdater(chatId, `Mencari gambar untuk "${query}"...`);
  await progress.start(0);
  const stopSim = simulateProgress(progress, { max: 85, stepMs: 350 });

  try {
    const results = await searchImages(query);
    stopSim();

    if (!results.length) {
      await progress.remove();
      return bot.sendMessage(chatId, "❌ Gambar tidak ditemukan untuk: " + query);
    }
    await progress.update(90, "Mengirim gambar...");

    // Coba beberapa hasil teratas, karena kadang satu URL gambar sudah mati
    let sent = false;
    let lastError;
    for (const item of results.slice(0, 5)) {
      try {
        await bot.sendPhoto(chatId, item.url, {
          caption: `🖼️ <b>Hasil pencarian:</b> ${query}${
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
    console.error(e);
    stopSim();
    await progress.remove();
    bot.sendMessage(chatId, "❌ Terjadi error saat mencari gambar. Coba kata kunci lain.");
  }
});


  bot.onText(/^\/image$/, (msg) =>
    bot.sendMessage(msg.chat.id, "⚠️ Format: <code>/image kucing lucu</code>", { parse_mode: "HTML" })
  );
};
