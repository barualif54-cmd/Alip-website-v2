// ================= plugins/suit.js =================
// Fitur /suit (Batu Gunting Kertas 2 pemain lewat tombol inline).
module.exports = function suitPlugin(ctx) {
  const { bot, activeSuitGames } = ctx;

// KEDUANYA sudah memilih, baru hasilnya diungkap ke chat.

const SUIT_CHOICES = {
  batu: { label: "✊ Batu", beats: "gunting" },
  gunting: { label: "✌️ Gunting", beats: "kertas" },
  kertas: { label: "✋ Kertas", beats: "batu" },
};

function suitStatusText(game) {
  const namaA = game.players.A.name;

  if (!game.players.B) {
    return `✊✋✌️ <b>SUIT — BATU GUNTING KERTAS</b>\n\n${namaA} vs <i>menunggu pemain kedua...</i>\n\nKlik "➕ Gabung Main" untuk jadi lawan!`;
  }

  const namaB = game.players.B.name;
  const sudahA = game.picks.A ? "✅" : "⏳";
  const sudahB = game.picks.B ? "✅" : "⏳";
  return (
    `✊✋✌️ <b>SUIT — BATU GUNTING KERTAS</b>\n\n` +
    `${namaA} ${sudahA}  vs  ${sudahB} ${namaB}\n\n` +
    `Pilih rahasia lewat tombol di bawah. Hasil baru muncul kalau <b>kedua pemain</b> sudah memilih.`
  );
}

function suitKeyboard(game) {
  const rows = [];
  if (!game.players.B) {
    rows.push([{ text: "➕ Gabung Main", callback_data: "suit_join" }]);
  } else {
    rows.push([
      { text: SUIT_CHOICES.batu.label, callback_data: "suit_pick_batu" },
      { text: SUIT_CHOICES.gunting.label, callback_data: "suit_pick_gunting" },
      { text: SUIT_CHOICES.kertas.label, callback_data: "suit_pick_kertas" },
    ]);
  }
  rows.push([{ text: "🛑 Batalkan Game", callback_data: "suit_cancel" }]);
  return { inline_keyboard: rows };
}

async function updateSuitMessage(chatId, game) {
  try {
    await bot.editMessageText(suitStatusText(game), {
      chat_id: chatId,
      message_id: game.messageId,
      parse_mode: "HTML",
      reply_markup: suitKeyboard(game),
    });
  } catch (e) {
    // pesan mungkin tidak berubah / sudah dihapus, aman untuk diabaikan
  }
}

bot.onText(/^\/suit$/, async (msg) => {
  const chatId = msg.chat.id;

  if (activeSuitGames.has(chatId)) {
    return bot.sendMessage(
      chatId,
      "⚠️ Sudah ada game Suit yang sedang berjalan di chat ini. Ketik /stopsuit untuk membatalkannya dulu."
    );
  }

  const starter = {
    id: msg.from.id,
    name: msg.from.first_name || msg.from.username || "Pemain 1",
  };

  const game = {
    players: { A: starter, B: null },
    picks: {},
    messageId: null,
  };

  const sentMsg = await bot.sendMessage(chatId, suitStatusText(game), {
    parse_mode: "HTML",
    reply_markup: suitKeyboard(game),
  });

  game.messageId = sentMsg.message_id;
  activeSuitGames.set(chatId, game);
});

bot.onText(/^\/stopsuit$/, (msg) => {
  const chatId = msg.chat.id;
  if (activeSuitGames.has(chatId)) {
    activeSuitGames.delete(chatId);
    bot.sendMessage(chatId, "🛑 Game Suit dibatalkan.");
  } else {
    bot.sendMessage(chatId, "ℹ️ Tidak ada game Suit yang aktif di chat ini.");
  }
});

// Handler khusus untuk semua callback game Suit (join, pilih, batal)
bot.on("callback_query", async (query) => {
  const data = query.data;
  if (!data || !data.startsWith("suit_")) return;

  try {
    await handleSuitCallback(query, data);
  } catch (e) {
    // Jangan biarkan error di sini (misal callback query kadaluarsa,
    // "message is not modified", dll) menjadi unhandled rejection yang
    // bisa mematikan seluruh proses bot.
    console.error("⚠️ Error di handler suit:", e.message);
    bot.answerCallbackQuery(query.id, { text: "Terjadi error, coba lagi." }).catch(() => {});
  }
});

async function handleSuitCallback(query, data) {
  const chatId = query.message.chat.id;
  const user = {
    id: query.from.id,
    name: query.from.first_name || query.from.username || "Pemain",
  };

  const game = activeSuitGames.get(chatId);
  if (!game) {
    return bot.answerCallbackQuery(query.id, { text: "Game sudah berakhir / tidak ditemukan." });
  }

  // ----- Gabung sebagai pemain B -----
  if (data === "suit_join") {
    if (game.players.B) {
      return bot.answerCallbackQuery(query.id, { text: "Slot pemain sudah penuh." });
    }
    if (user.id === game.players.A.id) {
      return bot.answerCallbackQuery(query.id, {
        text: "Kamu tidak bisa main melawan diri sendiri 😅",
        show_alert: true,
      });
    }
    game.players.B = user;
    await bot.answerCallbackQuery(query.id, { text: "Kamu bergabung! Silakan pilih." });
    return updateSuitMessage(chatId, game);
  }

  // ----- Batalkan game -----
  if (data === "suit_cancel") {
    const isPlayer =
      user.id === game.players.A.id || (game.players.B && user.id === game.players.B.id);
    if (!isPlayer) {
      return bot.answerCallbackQuery(query.id, { text: "Hanya pemain di game ini yang bisa membatalkan." });
    }
    activeSuitGames.delete(chatId);
    await bot.answerCallbackQuery(query.id, { text: "Game dibatalkan" });
    return bot.editMessageText("🛑 Game Suit dibatalkan.", {
      chat_id: chatId,
      message_id: game.messageId,
    });
  }

  // ----- Pilih Batu/Gunting/Kertas -----
  if (data.startsWith("suit_pick_")) {
    if (!game.players.B) {
      return bot.answerCallbackQuery(query.id, { text: "Tunggu pemain kedua bergabung dulu." });
    }

    let slot;
    if (user.id === game.players.A.id) slot = "A";
    else if (user.id === game.players.B.id) slot = "B";
    else {
      return bot.answerCallbackQuery(query.id, {
        text: "Kamu bukan pemain di game ini.",
        show_alert: true,
      });
    }

    if (game.picks[slot]) {
      return bot.answerCallbackQuery(query.id, { text: "Kamu sudah memilih, tunggu lawan." });
    }

    const choice = data.replace("suit_pick_", "");
    if (!SUIT_CHOICES[choice]) {
      return bot.answerCallbackQuery(query.id, { text: "Pilihan tidak dikenali." });
    }

    game.picks[slot] = choice;
    await bot.answerCallbackQuery(query.id, {
      text: `Pilihan kamu: ${SUIT_CHOICES[choice].label} (dirahasiakan sampai lawan memilih)`,
      show_alert: true,
    });

    // Kalau salah satu pemain belum memilih, cukup update status (tanpa bocorkan pilihan)
    if (!game.picks.A || !game.picks.B) {
      return updateSuitMessage(chatId, game);
    }

    // Kedua pemain sudah memilih -> tentukan hasil
    const pickA = game.picks.A;
    const pickB = game.picks.B;
    const namaA = game.players.A.name;
    const namaB = game.players.B.name;

    let resultText;
    if (pickA === pickB) {
      resultText = `🤝 <b>SERI!</b> Sama-sama pilih ${SUIT_CHOICES[pickA].label}.`;
    } else if (SUIT_CHOICES[pickA].beats === pickB) {
      resultText = `🏆 <b>${namaA} MENANG!</b>`;
    } else {
      resultText = `🏆 <b>${namaB} MENANG!</b>`;
    }

    activeSuitGames.delete(chatId);

    return bot.editMessageText(
      `✊✋✌️ <b>SUIT — BATU GUNTING KERTAS</b>\n\n` +
        `${namaA}: ${SUIT_CHOICES[pickA].label}\n` +
        `${namaB}: ${SUIT_CHOICES[pickB].label}\n\n` +
        resultText,
      {
        chat_id: chatId,
        message_id: game.messageId,
        parse_mode: "HTML",
      }
    );
  }
}
};
