// ================= plugins/jam.js =================
// Fitur /jam (jam digital real-time) dan /stopjam.
// startClock/stopClock di-expose lewat ctx.actions karena tombol menu utama
// (core, tombol "⏰ Jam Real-time") manggil balik fungsi ini langsung.
module.exports = function jamPlugin(ctx) {
  const { bot, moment, activeClocks } = ctx;

const CLOCK_TIMEZONE_LABEL = "WIB";

// Bikin tampilan pesan jam: judul, tanggal, jam gaya "digital" (monospace besar)
function buildClockText() {
  const now = moment();
  const tanggal = now.format("dddd, D MMMM YYYY"); // contoh: Jumat, 3 Juli 2026
  const jam = now.format("HH:mm:ss");

  return (
    `🕒 <b>JAM DIGITAL REALTIME</b>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `📅  ${tanggal}\n` +
    `⏰  <code>${jam}</code>  <i>${CLOCK_TIMEZONE_LABEL}</i>\n` +
    `━━━━━━━━━━━━━━━━━━━\n` +
    `<i>Update otomatis tiap detik</i>`
  );
}

const clockKeyboard = {
  inline_keyboard: [[{ text: "🛑 Stop Jam", callback_data: "run_stopjam" }]],
};

function startClock(chatId) {
  // Kalau sudah ada jam aktif di chat ini, hentikan dulu supaya tidak dobel
  if (activeClocks.has(chatId)) {
    clearInterval(activeClocks.get(chatId).interval);
    activeClocks.delete(chatId);
  }

  bot
    .sendMessage(chatId, buildClockText(), {
      parse_mode: "HTML",
      reply_markup: clockKeyboard,
    })
    .then((sentMsg) => {
      const interval = setInterval(async () => {
        try {
          await bot.editMessageText(buildClockText(), {
            chat_id: chatId,
            message_id: sentMsg.message_id,
            parse_mode: "HTML",
            reply_markup: clockKeyboard,
          });
        } catch (e) {
          // pesan mungkin sudah dihapus user, hentikan interval
          clearInterval(interval);
          activeClocks.delete(chatId);
        }
      }, 1000);

      activeClocks.set(chatId, { interval, messageId: sentMsg.message_id });
    });
}

function stopClock(chatId) {
  if (activeClocks.has(chatId)) {
    clearInterval(activeClocks.get(chatId).interval);
    activeClocks.delete(chatId);
    return true;
  }
  return false;
}

bot.onText(/^\/jam$/, (msg) => startClock(msg.chat.id));

bot.onText(/^\/stopjam$/, (msg) => {
  const stopped = stopClock(msg.chat.id);
  bot.sendMessage(msg.chat.id, stopped ? "🛑 Jam dihentikan." : "ℹ️ Tidak ada jam yang aktif.");
});

bot.on("callback_query", (query) => {
  if (query.data === "run_stopjam") {
    stopClock(query.message.chat.id);
    bot.answerCallbackQuery(query.id, { text: "Jam dihentikan" });
  }
});


  // actions bridge: dipanggil dari core saat tombol menu utama "run_jam" ditekan
  ctx.actions.startClock = startClock;
  ctx.actions.stopClock = stopClock;
};
