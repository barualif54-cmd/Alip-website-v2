// ================= plugins/ttt.js =================
// Fitur /ttt (Tic Tac Toe 2 pemain lewat tombol inline).
module.exports = function tttPlugin(ctx) {
  const { bot, activeGames } = ctx;

function emptyBoard() {
  return Array(9).fill(null);
}

// Ubah board jadi susunan tombol inline 3x3
function boardKeyboardRows(board) {
  const symbol = (v) => (v === "X" ? "❌" : v === "O" ? "⭕" : "▫️");
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = [];
    for (let c = 0; c < 3; c++) {
      const idx = r * 3 + c;
      row.push({ text: symbol(board[idx]), callback_data: `ttt_move_${idx}` });
    }
    rows.push(row);
  }
  return rows;
}

// Cek apakah ada pemenang / seri. Return "X", "O", "DRAW", atau null (belum selesai)
function checkWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8], // baris
    [0, 3, 6], [1, 4, 7], [2, 5, 8], // kolom
    [0, 4, 8], [2, 4, 6],            // diagonal
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  if (board.every((cell) => cell !== null)) return "DRAW";
  return null;
}

function gameStatusText(game) {
  const namaX = game.players.X.name;

  if (!game.players.O) {
    return `🎮 <b>TIC TAC TOE</b>\n\n❌ ${namaX}  vs  ⭕ <i>menunggu pemain kedua...</i>\n\nKlik "➕ Gabung Main" untuk jadi lawan!`;
  }

  const namaO = game.players.O.name;
  const giliran = game.turn === "X" ? `❌ ${namaX}` : `⭕ ${namaO}`;
  return `🎮 <b>TIC TAC TOE</b>\n\n❌ ${namaX}  vs  ⭕ ${namaO}\n\nGiliran: <b>${giliran}</b>`;
}

function gameKeyboard(game) {
  const rows = boardKeyboardRows(game.board);
  if (!game.players.O) {
    rows.push([{ text: "➕ Gabung Main", callback_data: "ttt_join" }]);
  }
  rows.push([{ text: "🛑 Batalkan Game", callback_data: "ttt_cancel" }]);
  return { inline_keyboard: rows };
}

async function updateGameMessage(chatId, game) {
  try {
    await bot.editMessageText(gameStatusText(game), {
      chat_id: chatId,
      message_id: game.messageId,
      parse_mode: "HTML",
      reply_markup: gameKeyboard(game),
    });
  } catch (e) {
    // pesan mungkin tidak berubah / sudah dihapus, aman untuk diabaikan
  }
}

bot.onText(/^\/ttt$/, async (msg) => {
  const chatId = msg.chat.id;

  if (activeGames.has(chatId)) {
    return bot.sendMessage(
      chatId,
      "⚠️ Sudah ada game yang sedang berjalan di chat ini. Ketik /stopttt untuk membatalkannya dulu."
    );
  }

  const starter = {
    id: msg.from.id,
    name: msg.from.first_name || msg.from.username || "Pemain 1",
  };

  const game = {
    board: emptyBoard(),
    players: { X: starter, O: null },
    turn: "X",
    messageId: null,
  };

  const sentMsg = await bot.sendMessage(chatId, gameStatusText(game), {
    parse_mode: "HTML",
    reply_markup: gameKeyboard(game),
  });

  game.messageId = sentMsg.message_id;
  activeGames.set(chatId, game);
});

bot.onText(/^\/stopttt$/, (msg) => {
  const chatId = msg.chat.id;
  if (activeGames.has(chatId)) {
    activeGames.delete(chatId);
    bot.sendMessage(chatId, "🛑 Game Tic Tac Toe dibatalkan.");
  } else {
    bot.sendMessage(chatId, "ℹ️ Tidak ada game Tic Tac Toe yang aktif di chat ini.");
  }
});

// Handler khusus untuk semua callback game (join, gerakan, batal)
bot.on("callback_query", async (query) => {
  const data = query.data;
  if (!data || !data.startsWith("ttt_")) return;

  const chatId = query.message.chat.id;
  const game = activeGames.get(chatId);

  if (!game) {
    return bot.answerCallbackQuery(query.id, { text: "Game sudah tidak aktif.", show_alert: true });
  }

  const user = {
    id: query.from.id,
    name: query.from.first_name || query.from.username || "Pemain",
  };

  // ----- Gabung sebagai pemain O -----
  if (data === "ttt_join") {
    if (game.players.O) {
      return bot.answerCallbackQuery(query.id, { text: "Slot pemain sudah penuh." });
    }
    if (user.id === game.players.X.id) {
      return bot.answerCallbackQuery(query.id, {
        text: "Kamu tidak bisa main melawan diri sendiri 😅",
        show_alert: true,
      });
    }
    game.players.O = user;
    await bot.answerCallbackQuery(query.id, { text: "Kamu bergabung sebagai ⭕" });
    return updateGameMessage(chatId, game);
  }

  // ----- Batalkan game -----
  if (data === "ttt_cancel") {
    const isPlayer =
      user.id === game.players.X.id || (game.players.O && user.id === game.players.O.id);
    if (!isPlayer) {
      return bot.answerCallbackQuery(query.id, { text: "Hanya pemain di game ini yang bisa membatalkan." });
    }
    activeGames.delete(chatId);
    await bot.answerCallbackQuery(query.id, { text: "Game dibatalkan" });
    return bot.editMessageText("🛑 Game Tic Tac Toe dibatalkan.", {
      chat_id: chatId,
      message_id: game.messageId,
    });
  }

  // ----- Gerakan di papan -----
  if (data.startsWith("ttt_move_")) {
    if (!game.players.O) {
      return bot.answerCallbackQuery(query.id, { text: "Tunggu pemain kedua bergabung dulu." });
    }

    const currentPlayer = game.players[game.turn];
    if (user.id !== currentPlayer.id) {
      return bot.answerCallbackQuery(query.id, { text: "Bukan giliran kamu!", show_alert: true });
    }

    const idx = parseInt(data.replace("ttt_move_", ""), 10);
    if (Number.isNaN(idx) || idx < 0 || idx > 8 || game.board[idx]) {
      return bot.answerCallbackQuery(query.id, { text: "Kotak sudah terisi!" });
    }

    game.board[idx] = game.turn;
    const result = checkWinner(game.board);

    if (result === "DRAW") {
      activeGames.delete(chatId);
      await bot.answerCallbackQuery(query.id, { text: "Hasil: Seri!" });
      return bot.editMessageText(`🎮 <b>TIC TAC TOE</b>\n\n🤝 Hasil: <b>SERI!</b>`, {
        chat_id: chatId,
        message_id: game.messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: boardKeyboardRows(game.board) },
      });
    }

    if (result === "X" || result === "O") {
      const winner = game.players[result];
      const symbol = result === "X" ? "❌" : "⭕";
      activeGames.delete(chatId);
      await bot.answerCallbackQuery(query.id, { text: "🎉 Kamu menang!" });
      return bot.editMessageText(
        `🎮 <b>TIC TAC TOE</b>\n\n🏆 <b>${winner.name}</b> (${symbol}) MENANG!`,
        {
          chat_id: chatId,
          message_id: game.messageId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: boardKeyboardRows(game.board) },
        }
      );
    }

    // Belum ada pemenang, lanjut ke giliran berikutnya
    game.turn = game.turn === "X" ? "O" : "X";
    await bot.answerCallbackQuery(query.id);
    return updateGameMessage(chatId, game);
  }
});

};
