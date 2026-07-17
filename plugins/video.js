// ================= plugins/video.js =================
// Fitur /video (cari video YouTube, kirim info + link -- tidak download file).
module.exports = function videoPlugin(ctx) {
  const { bot, ytSearch, createProgressUpdater, simulateProgress } = ctx;

bot.onText(/^\/video (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  await bot.sendChatAction(chatId, "typing");

  const progress = createProgressUpdater(chatId, `Mencari video untuk "${query}"...`);
  await progress.start(0);
  const stopSim = simulateProgress(progress, { max: 85, stepMs: 300 });

  try {
    const r = await ytSearch(query);
    stopSim();

    if (!r.videos.length) {
      await progress.remove();
      return bot.sendMessage(chatId, "❌ Video tidak ditemukan untuk: " + query);
    }

    const v = r.videos[0];
    await progress.remove();

    await bot.sendMessage(
      chatId,
      `🎬 <b>VIDEO DITEMUKAN</b>

<b>Judul:</b> ${v.title}
<b>Durasi:</b> ${v.timestamp}
<b>Channel:</b> ${v.author?.name || "-"}
<b>Views:</b> ${v.views?.toLocaleString?.() || "-"}
<b>Link:</b> ${v.url}`,
      { parse_mode: "HTML", disable_web_page_preview: false }
    );
  } catch (e) {
    console.error(e);
    stopSim();
    await progress.remove();
    bot.sendMessage(chatId, "❌ Terjadi error saat mencari video.");
  }
});

  bot.onText(/^\/video$/, (msg) =>
    bot.sendMessage(msg.chat.id, "⚠️ Format: <code>/video tutorial nodejs</code>", { parse_mode: "HTML" })
  );
};
