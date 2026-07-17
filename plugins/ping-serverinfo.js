// ================= plugins/ping-serverinfo.js =================
// Fitur /ping (live ping animasi) dan /serverinfo (info resource server).
// Sengaja digabung karena aslinya bersebelahan & sama-sama butuh helper
// format uptime/memory yang sama.
//
// sendPing() & sendServerInfo() di-expose lewat ctx.actions karena dipanggil
// balik dari core (tombol menu utama + panel /tools).
module.exports = function pingServerinfoPlugin(ctx) {
  const { bot, os, callTelegramWithRetry } = ctx;

function formatUptime(totalSeconds) {
  const seconds = Math.floor(totalSeconds);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days} hari`);
  if (hours > 0) parts.push(`${hours} jam`);
  if (minutes > 0) parts.push(`${minutes} menit`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs} detik`);

  return parts.join(" ");
}

// ================= STATUS BOT (dipakai konsisten di semua panel) =================
// Baris status singkat "🟢 Online" biar user langsung tau bot masih hidup
// tanpa harus ketik /serverinfo. compact=true buat panel yang sudah
// nampilin detail uptime sendiri di body-nya (Server Info & Ping), biar
// tidak dobel nulis durasi yang sama dua kali di satu pesan.
function botStatusLine({ compact = false } = {}) {
  if (compact) return "🟢 Online";
  const uptimeText = formatUptime(process.uptime());
  return `🟢 Online · Aktif ${uptimeText}`;
}

// Baris "Memory: xx.xx MB" siap pakai buat kartu status menu (rss proses Node saat ini).
function botMemoryLine() {
  const mem = process.memoryUsage().rss / 1024 / 1024;
  return `Memory: ${mem.toFixed(2)} MB`;
}

// ================= LIVE PING (REALTIME) =================
// /ping sekarang tidak cuma ngukur sekali, tapi terus nge-update pesan yang
// sama tiap beberapa detik (kayak monitor ping realtime) selama durasi
// tertentu, sambil nyimpen histori buat nampilin min/rata-rata/max.
// Kenapa tidak edit lebih cepat dari 2 detik: Telegram membatasi jumlah edit
// per pesan/chat per waktu -- edit kelewat sering malah bisa kena rate limit
// (429) dan bikin proses ping-nya sendiri jadi lag/gagal edit.
const PING_LIVE_INTERVAL_MS = 2000;
const PING_LIVE_MAX_ROUNDS = 15; // 15 x 2 detik = ~30 detik lalu otomatis berhenti

// chatId -> { stop: fn } -- state sesi live-ping yang lagi jalan per chat,
// biar tidak ada 2 loop /ping nabrak dalam satu chat yang sama.
const activeLivePings = new Map();

function statusEmojiForLatency(ms) {
  if (ms > 1500) return "🔴";
  if (ms > 500) return "🟡";
  return "🟢";
}

function buildLivePingText({ latencies, round, totalRounds, running }) {
  const current = latencies[latencies.length - 1];
  const min = Math.min(...latencies);
  const max = Math.max(...latencies);
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);

  const mem = process.memoryUsage().rss / 1024 / 1024;
  const uptimeText = formatUptime(process.uptime());
  const statusEmoji = statusEmojiForLatency(current);
  const liveTag = running ? "🔴 LIVE" : "✅ SELESAI";
  const progress = buildProgressBar((round / totalRounds) * 100);

  return (
    `🏓 𝗣𝗢𝗡𝗚\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `${botStatusLine({ compact: true })}\n\n` +
    `${liveTag} · update ${round}/${totalRounds}\n` +
    `${progress}\n\n` +
    `${statusEmoji} Sekarang : <b>${current} ms</b>\n` +
    `📉 Min : <b>${min} ms</b>   📈 Max : <b>${max} ms</b>   📊 Rata-rata : <b>${avg} ms</b>\n\n` +
    `⏱️ Bot aktif : <b>${uptimeText}</b>\n` +
    `💾 Memori : <b>${mem.toFixed(1)} MB</b>` +
    (running ? `\n\n<i>Ketik /stopping buat berhenti lebih awal.</i>` : ``)
  );
}

async function sendPing(chatId) {
  if (activeLivePings.has(chatId)) {
    return bot.sendMessage(chatId, "⚠️ Live ping masih berjalan di chat ini. Ketik /stopping buat menghentikannya dulu.");
  }

  const measureStart = Date.now();
  const sentMsg = await bot.sendMessage(chatId, "🏓 Menghitung ping (live)...");
  const firstLatency = Date.now() - measureStart;

  const latencies = [firstLatency];
  let stopped = false;
  activeLivePings.set(chatId, { stop: () => (stopped = true) });

  try {
    await callTelegramWithRetry(
      () =>
        bot.editMessageText(
          buildLivePingText({ latencies, round: 1, totalRounds: PING_LIVE_MAX_ROUNDS, running: true }),
          { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: "HTML" }
        ),
      { label: "ping.live.update" }
    );

    for (let round = 2; round <= PING_LIVE_MAX_ROUNDS; round++) {
      if (stopped) break;
      await new Promise((r) => setTimeout(r, PING_LIVE_INTERVAL_MS));
      if (stopped) break;

      const roundStart = Date.now();
      try {
        await callTelegramWithRetry(
          () =>
            bot.editMessageText(
              buildLivePingText({ latencies, round, totalRounds: PING_LIVE_MAX_ROUNDS, running: true }),
              { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: "HTML" }
            ),
          { label: "ping.live.update" }
        );
      } catch (e) {
        // Kalau gagal edit (misal pesan dihapus user), hentikan loop alih-alih
        // terus nyoba tiap 2 detik sampai batas ronde habis.
        console.error("⚠️ Gagal edit pesan live-ping, menghentikan sesi:", e.message);
        break;
      }
      latencies.push(Date.now() - roundStart);
    }
  } finally {
    activeLivePings.delete(chatId);
    // Update terakhir buat nandain sesinya sudah selesai (bukan "LIVE" lagi)
    try {
      await bot.editMessageText(
        buildLivePingText({
          latencies,
          round: latencies.length,
          totalRounds: PING_LIVE_MAX_ROUNDS,
          running: false,
        }),
        { chat_id: chatId, message_id: sentMsg.message_id, parse_mode: "HTML" }
      );
    } catch (e) {
      // abaikan kalau gagal (pesan sudah dihapus dsb)
    }
  }
}

// /testnotif -- cuma bisa dipakai owner (chat pribadi = OWNER_CHAT_ID di .env),
// buat mastiin pipeline notifikasi dashboard-down/error beneran nyampe.
bot.onText(/^\/testnotif$/, async (msg) => {
  if (!OWNER_CHAT_ID) {
    return bot.sendMessage(
      msg.chat.id,
      "⚠️ OWNER_CHAT_ID belum diisi di .env, jadi fitur notif belum aktif."
    );
  }
  if (String(msg.chat.id) !== String(OWNER_CHAT_ID)) {
    return; // diam aja kalau dipanggil dari chat/grup lain, ini command khusus owner
  }
  await bot.sendMessage(
    msg.chat.id,
    "✅ <b>Tes notifikasi berhasil.</b>\nKalau kamu terima pesan ini, alert dashboard-down/error bakal nyampe ke chat ini juga.",
    { parse_mode: "HTML" }
  );
});

bot.onText(/^\/ping$/, (msg) => sendPing(msg.chat.id));
bot.onText(/^\/stopping$/, (msg) => {
  const session = activeLivePings.get(msg.chat.id);
  if (!session) {
    return bot.sendMessage(msg.chat.id, "ℹ️ Tidak ada live ping yang sedang berjalan di chat ini.");
  }
  session.stop();
});

// ================= INFO SERVER / DEVICE (BASIC) =================
// Nampilin info dasar server tempat bot ini jalan: OS, RAM, CPU,
// uptime, dan versi Node.js. Bisa diakses semua user (public).
// (IP publik server sengaja TIDAK ditampilkan demi keamanan/privasi.)
// Catatan: Telegram Bot API tidak kasih akses ke IP/device asli user yang
// chat (dijaga privasinya oleh Telegram) — jadi ini info server/host bot-nya,
// bukan device orang yang ngetik command.

function formatBytes(bytes) {
  const gb = bytes / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

async function sendServerInfo(chatId) {
  const sentMsg = await bot.sendMessage(chatId, "🔍 Mengambil info server...");

  const cpus = os.cpus();
  const cpuModel = cpus.length ? cpus[0].model.trim() : "Tidak diketahui";
  const cpuCores = cpus.length;

  const totalMem = formatBytes(os.totalmem());
  const freeMem = formatBytes(os.freemem());
  const usedMem = formatBytes(os.totalmem() - os.freemem());

  const platform = os.platform(); // linux, win32, darwin, dll
  const release = os.release();
  const arch = os.arch();
  const hostname = os.hostname();

  const osUptime = formatUptime(os.uptime()); // uptime server/OS
  const botUptime = formatUptime(process.uptime()); // uptime proses bot

  const text =
    `🖥️ 𝗜𝗡𝗙𝗢 𝗦𝗘𝗥𝗩𝗘𝗥\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `${botStatusLine({ compact: true })}\n\n` +
    `<b>🌐 Sistem</b>\n` +
    `▸ Hostname : <b>${hostname}</b>\n` +
    `▸ OS : <b>${platform} ${release}</b> (${arch})\n` +
    `▸ Node.js : <b>${process.version}</b>\n\n` +
    `<b>⚙️ Resource</b>\n` +
    `▸ CPU : <b>${cpuModel}</b>\n` +
    `▸ Core : <b>${cpuCores}</b>\n` +
    `▸ RAM : <b>${usedMem}</b> terpakai dari <b>${totalMem}</b> <i>(bebas ${freeMem})</i>\n\n` +
    `<b>⏱️ Uptime</b>\n` +
    `▸ Server : <b>${osUptime}</b>\n` +
    `▸ Bot : <b>${botUptime}</b>`;

  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: sentMsg.message_id,
      parse_mode: "HTML",
    });
  } catch (e) {
    console.error("⚠️ Gagal edit pesan server info:", e.message);
  }
}

bot.onText(/^\/serverinfo$/, (msg) => sendServerInfo(msg.chat.id));

  // actions bridge: dipanggil dari core (tombol menu utama & panel /tools)
  ctx.actions.sendPing = sendPing;
  ctx.actions.sendServerInfo = sendServerInfo;
};
