require("dotenv").config();
const { attachDashboard } = require("./dashboard");
const { escapeHtml, botStatusLine, botMemoryLine, formatUptime, formatBytes } = require("./core/utils");

// Diisi ulang setelah attachDashboard() dipanggil di bawah (lihat akhir file).
// Dideklarasikan di sini (var, bukan const) supaya fungsi2 yang didefinisikan
// lebih awal di file ini tetap bisa memanggil pushEvent(...) lewat closure,
// walau nilai aslinya baru terpasang belakangan saat dashboard nyala.
let pushEvent = () => {};

const dashboardStartedAt = Date.now();
const TelegramBot = require("node-telegram-bot-api");
const ytSearch = require("yt-search");
const moment = require("moment");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const dns = require("dns");
const https = require("https");
const http = require("http");
let Jimp = null;
try {
  const jimpModule = require("jimp");
  Jimp = jimpModule.Jimp || jimpModule; // v1.x uses named export { Jimp }, v0.x uses default export
} catch (e) {
  console.error("⚠️ Modul 'jimp' belum terinstall. Jalankan: npm install jimp (thumbnail cover akan dilewati kalau tidak ada).");
}

// ================= FIX: LATENSI TINGGI KE TELEGRAM API =================
// Kalau ping/RTT jaringan mentah (ping ke IP Telegram) jauh lebih rendah
// dibanding waktu respon bot (misal: ping 184ms tapi sendMessage 874ms),
// biasanya BUKAN soal kecepatan internet, tapi overhead di level Node:
//
// 1) DNS/IPv6: Node kadang coba resolve/connect via IPv6 dulu, gagal/lambat,
//    baru fallback ke IPv4 -- ini nambah ratusan ms di SETIAP request.
//    Paksa Node pakai urutan IPv4 dulu supaya tidak ada percobaan IPv6 yang sia-sia.
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (e) {
  // Node versi lama (<17) belum punya API ini -- aman diabaikan, cuma
  // berarti optimasi ini tidak aktif di versi Node yang dipakai.
}

// Catatan: node-telegram-bot-api pakai library 'request' di baliknya, yang
// cukup diberi `agentOptions` (bukan instance https.Agent siap pakai) untuk
// mengaktifkan keep-alive -- lihat opsi `request` di new TelegramBot(...) di bawah.

// ================= TOKEN =================
// JANGAN hardcode token di sini. Simpan di file .env:
// BOT_TOKEN=isi_token_kamu_disini
const token = process.env.BOT_TOKEN || "8973038322:AAHOPLu4QcPVNTOMAuM9Wz38D49xq-62zVo";

if (!token) {
  console.error("❌ BOT_TOKEN tidak ditemukan. Buat file .env berisi: BOT_TOKEN=xxxx");
  process.exit(1);
}

// ================= NOTIFIKASI OWNER (dashboard down / bot error) =================
// Isi di .env:
//   OWNER_CHAT_ID=123456789   (chat ID pribadi kamu di Telegram, BUKAN grup)
// Cara dapetin chat ID: chat bot @userinfobot, atau lihat log pas kamu /start bot ini.
// Kalau tidak diisi, notif error/down cuma tercatat di console (fitur alert nonaktif).
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || null; // TODO: isi chat ID Telegram kamu sendiri di sini kalau mau, formatnya OWNER_CHAT_ID || "123456789"
if (!OWNER_CHAT_ID) {
  console.warn(
    "⚠️ OWNER_CHAT_ID belum diisi di .env — notifikasi Telegram untuk dashboard down/error TIDAK aktif (cuma log ke console)."
  );
}

// ================= DAFTAR ADMIN BOT (untuk panel /panel) =================
// Isi di .env (pisahkan koma kalau lebih dari satu admin):
//   ADMIN_IDS=123456789,987654321
// ID di OWNER_CHAT_ID otomatis ikut dianggap admin, jadi kalau cuma 1 orang
// tidak perlu diisi dobel di ADMIN_IDS. Panel /panel (dashboard lewat
// Telegram) HANYA bisa dipakai oleh user yang ID-nya ada di daftar ini.
const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (OWNER_CHAT_ID && !ADMIN_IDS.includes(String(OWNER_CHAT_ID))) {
  ADMIN_IDS.push(String(OWNER_CHAT_ID));
}
if (!ADMIN_IDS.length) {
  console.warn(
    "⚠️ ADMIN_IDS / OWNER_CHAT_ID belum diisi di .env — panel /panel akan menolak semua orang sampai ini diisi."
  );
}
function isBotAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

// Khusus buat fitur yang HARUS owner-only (misal /tools) — beda dari
// isBotAdmin() di atas yang mengizinkan semua ID di ADMIN_IDS. Ini cuma
// mengizinkan OWNER_CHAT_ID persis, siapapun/dimanapun (grup ataupun pribadi).
function isOwner(userId) {
  return !!OWNER_CHAT_ID && String(userId) === String(OWNER_CHAT_ID);
}

// Notif ke owner tiap ada yang coba pakai /tools padahal bukan admin (grup
// maupun bot). Dibatasi cooldown lewat notifyOwner() biar tidak spam kalau
// orangnya coba berkali-kali dalam waktu singkat.
async function notifyOwnerUnauthorizedTools(from, chat) {
  const name = (from && (from.first_name || from.username)) || "User";
  const username = from && from.username ? `@${from.username}` : "-";
  const chatLabel =
    chat.type === "private"
      ? "Chat pribadi"
      : `${chat.title || "Grup"} (${chat.type})`;
  await notifyOwner(
    `<b>⛔ PERCOBAAN AKSES /tools TANPA IZIN</b>\n\n` +
      `▸ Nama: ${escapeHtml(name)}\n` +
      `▸ Username: ${escapeHtml(username)}\n` +
      `▸ User ID: <code>${from ? from.id : "-"}</code>\n` +
      `▸ Chat: ${escapeHtml(chatLabel)}\n` +
      `▸ Chat ID: <code>${chat.id}</code>`,
    "unauthorized-tools"
  );
}

// Sama seperti notifyOwnerUnauthorizedTools() di atas, tapi khusus buat
// percobaan akses /panel (dashboard admin lewat Telegram) oleh yang BUKAN
// admin bot (ID-nya tidak ada di ADMIN_IDS/OWNER_CHAT_ID). Cooldown-nya
// dipisah ("unauthorized-panel") supaya tidak "termakan" cooldown /tools.
async function notifyOwnerUnauthorizedPanel(from, chat) {
  const name = (from && (from.first_name || from.username)) || "User";
  const username = from && from.username ? `@${from.username}` : "-";
  const chatLabel =
    chat.type === "private"
      ? "Chat pribadi"
      : `${chat.title || "Grup"} (${chat.type})`;
  await notifyOwner(
    `<b>⛔ PERCOBAAN AKSES /panel TANPA IZIN</b>\n\n` +
      `▸ Nama: ${escapeHtml(name)}\n` +
      `▸ Username: ${escapeHtml(username)}\n` +
      `▸ User ID: <code>${from ? from.id : "-"}</code>\n` +
      `▸ Chat: ${escapeHtml(chatLabel)}\n` +
      `▸ Chat ID: <code>${chat.id}</code>`,
    "unauthorized-panel"
  );
}

// ================= MODE: POLLING ATAU WEBHOOK =================
// Default: polling (paling gampang, jalan di HP/PC/VPS tanpa domain).
// Mau pakai webhook? Tambahin di .env:
//   BOT_MODE=webhook
//   WEBHOOK_URL=https://domainkamu.com   (WAJIB https, harus publik & valid,
//                                          bisa pakai ngrok/cloudflare tunnel
//                                          buat testing di lokal)
//   PORT=3000                             (opsional, default 3000)
// Kalau BOT_MODE tidak diisi / diisi selain "webhook", bot otomatis pakai polling.
const BOT_MODE = (process.env.BOT_MODE || "polling").toLowerCase();
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

let bot;

if (BOT_MODE === "webhook") {
  if (!WEBHOOK_URL) {
    console.error(
      "❌ BOT_MODE=webhook tapi WEBHOOK_URL belum diisi di .env.\n" +
        "   Contoh: WEBHOOK_URL=https://domainkamu.com"
    );
    process.exit(1);
  }

  // node-telegram-bot-api sudah bawa http server internal buat mode webhook,
  // jadi tidak perlu install express/dependency tambahan.
  bot = new TelegramBot(token, {
    webHook: { port: PORT },
    request: { agentOptions: { keepAlive: true, keepAliveMsecs: 10000 } },
  });

  const webhookPath = `/bot${token}`;
  const fullWebhookUrl = `${WEBHOOK_URL.replace(/\/$/, "")}${webhookPath}`;

  bot
    .setWebHook(fullWebhookUrl)
    .then(() => console.log(`✅ WEBHOOK aktif di ${fullWebhookUrl} (port ${PORT})`))
    .catch((err) => {
      console.error("❌ Gagal set webhook:", err.message);
      process.exit(1);
    });
} else {
  bot = new TelegramBot(token, {
    polling: true,
    request: { agentOptions: { keepAlive: true, keepAliveMsecs: 10000 } },
  });

  // Jaga-jaga kalau sebelumnya bot ini pernah dipasangin webhook (misal abis
  // ganti dari BOT_MODE=webhook ke polling), webhook lama HARUS dihapus dulu,
  // kalau tidak Telegram bakal nolak polling ("terusable while webhook is
  // active" error).
  bot.deleteWebHook().catch(() => {});
}

// ================= HELPER: KIRIM ALERT KE OWNER =================
// Dipakai buat notif dashboard down, bot crash, dsb. Ada rate-limit sederhana
// per "kategori" alert (misal "dashboard-down") supaya kalau error yang sama
// kejadian berkali-kali beruntun (misal tiap health-check gagal), owner tidak
// dibanjiri notif -- cukup 1x tiap jeda ALERT_COOLDOWN_MS per kategori.
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 menit
const lastAlertSentAt = {};

async function notifyOwner(text, category = "general") {
  const now = Date.now();
  if (lastAlertSentAt[category] && now - lastAlertSentAt[category] < ALERT_COOLDOWN_MS) {
    return; // masih dalam cooldown, skip biar tidak spam
  }
  lastAlertSentAt[category] = now;

  console.error(`🚨 [ALERT:${category}] ${text}`);

  if (!OWNER_CHAT_ID || !bot) return; // fitur nonaktif kalau OWNER_CHAT_ID belum diset

  try {
    await Promise.race([
      bot.sendMessage(OWNER_CHAT_ID, text, { parse_mode: "HTML" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 8000)),
    ]);
  } catch (e) {
    // Sengaja cuma di-log, JANGAN throw -- kalau kirim alert ke Telegram aja
    // gagal (misal Telegram API lagi down bareng masalahnya), jangan sampai
    // ini malah bikin proses ikut crash.
    console.error("⚠️ Gagal kirim notif alert ke owner:", e.message);
  }
}

// Simpan ID bot sendiri, dipakai buat deteksi kalau yang "join" ke grup adalah
// bot ini sendiri (bukan member biasa) — supaya tidak ikut kena welcome message.
let botId = null;
bot
  .getMe()
  .then((me) => {
    botId = me.id;
  })
  .catch((err) => console.error("⚠️ Gagal ambil info bot (getMe):", err.message));

// ================= GEMINI API KEY (untuk fitur /ai) =================
// Simpan juga di file .env:
// GEMINI_API_KEY=isi_api_key_kamu_disini
// Ambil API key GRATIS (tanpa kartu kredit) di https://aistudio.google.com/apikey
const geminiApiKey = process.env.GEMINI_API_KEY || "AQ.Ab8RN6L9F6BhMdvPHGUdTOB_G_rZaLu8Glw6ISaz9-b2iy481w";

if (!geminiApiKey) {
  console.warn(
    "⚠️ GEMINI_API_KEY tidak ditemukan di .env — fitur /ai tidak akan berfungsi sampai kamu menambahkannya."
  );
}

// Folder sementara buat nyimpen file mp3 sebelum dikirim
const tempDir = path.join(os.tmpdir(), "bot_mp3_cache");
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

// ================= PROGRESS BAR (NOTIF 1-100%) =================
// Dipakai di semua fitur yang butuh waktu (download, pencarian, panggil API AI, dll)
// biar user tahu proses sudah sampai mana, bukan cuma "tunggu ya..." tanpa kepastian.

// Gaya "card" ringkas ala UI aplikasi modern: judul + 1 baris bar, tanpa kotak
// warna-warni (▬ terisi, ▭ sisa) supaya tetap netral di HP dark/light mode
// manapun, plus info kecepatan & sisa waktu digabung di baris yang sama.
// Contoh:
//   ⚡ Download TikTok
//   ▬▬▬▬▬▬▬▬▬▬▭▭▭▭▭▭▭▭▭▭  50% · 1.4MB/s · sisa 0:09

// Ubah durasi (ms) jadi format menit:detik singkat (mis. "0:07", "1:32"),
// dipakai buat nampilin ETA & "sudah berjalan berapa lama".
function formatElapsed(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Estimasi sisa waktu (ETA) berdasarkan kecepatan rata-rata sejauh ini.
// Dibuat konservatif (return null kalau datanya belum cukup) supaya tidak
// menampilkan angka ngawur di awal proses.
function formatEta(elapsedMs, percent) {
  const p = Math.max(0, Math.min(100, percent));
  if (p <= 2 || p >= 100 || elapsedMs < 1500) return null;
  const totalEstimate = (elapsedMs / p) * 100;
  const remaining = Math.max(0, totalEstimate - elapsedMs);
  return formatElapsed(remaining);
}

// Ubah angka byte/detik jadi teks kecepatan singkat ("1.4MB/s" / "820KB/s").
function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return null;
  const mb = bytesPerSec / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)}MB/s`;
  const kb = bytesPerSec / 1024;
  return `${Math.max(1, Math.round(kb))}KB/s`;
}

// Helper kecil buat hitung kecepatan unduh real-time dari data byte-terkirim.
// Dipakai lewat closure per-proses (lihat trackDownloadSpeed()) supaya tiap
// download punya sample sendiri-sendiri, tidak saling tabrakan.
function trackDownloadSpeed() {
  const samples = [];
  return (receivedBytes) => {
    const now = Date.now();
    samples.push({ time: now, received: receivedBytes });
    // Hanya simpan sample dalam window ~4 detik terakhir, biar kecepatan yang
    // ditampilkan mencerminkan laju SAAT INI, bukan rata-rata dari awal proses.
    while (samples.length > 1 && now - samples[0].time > 4000) samples.shift();
    if (samples.length < 2) return null;
    const first = samples[0];
    const deltaBytes = receivedBytes - first.received;
    const deltaSec = (now - first.time) / 1000;
    if (deltaSec <= 0 || deltaBytes <= 0) return null;
    return formatSpeed(deltaBytes / deltaSec);
  };
}

// Bar dash minimalis: ▬ = terisi, ▭ = sisa. trackLength 20 biar tiap blok
// mewakili 5%, cukup presisi tapi tetap ringkas satu baris di layar HP.
function buildProgressBarOnly(percent) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  const trackLength = 20;
  const filled = Math.round((p / 100) * trackLength);
  return "▬".repeat(filled) + "▭".repeat(trackLength - filled);
}

// Versi lengkap (bar + persen digabung) -- dipakai di tempat yang cuma butuh
// satu baris ringkas tanpa info kecepatan/ETA tambahan (mis. live ping).
function buildProgressBar(percent) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return `${buildProgressBarOnly(p)}  ${p}%`;
}


// Bikin objek "progress updater": kirim 1 pesan awal, lalu di-edit terus tiap
// persentase naik (dengan throttle biar tidak kena rate limit edit Telegram).
// ================= RETRY OTOMATIS UNTUK RATE LIMIT TELEGRAM (429) =================
// Telegram membatasi jumlah pesan/edit per waktu. Kalau kelewat, API balas
// error 429 "Too Many Requests: retry after N" (N = detik yang wajib
// ditunggu). Tanpa penanganan khusus, error ini langsung bikin fitur gagal
// total meski sebenarnya cuma butuh nunggu sebentar. Helper ini membaca
// retry_after dari error tersebut dan otomatis coba ulang setelah menunggu.

function getTelegramRetryAfterSeconds(err) {
  const params = err && err.response && err.response.body && err.response.body.parameters;
  if (params && typeof params.retry_after === "number") return params.retry_after;
  const m = /retry after (\d+)/i.exec((err && err.message) || "");
  return m ? parseInt(m[1], 10) : null;
}

async function callTelegramWithRetry(fn, { maxRetries = 3, label = "" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryAfter = getTelegramRetryAfterSeconds(e);
      lastErr = e;
      if (retryAfter !== null && attempt < maxRetries) {
        console.warn(
          `⏳ Telegram rate limit (429)${label ? " [" + label + "]" : ""}, menunggu ${retryAfter}s sebelum retry (percobaan ${attempt + 1}/${maxRetries})...`
        );
        await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

function createProgressUpdater(chatId, label) {
  let messageId = null;
  let lastPercent = -1;
  let lastEditAt = 0;
  let startedAt = null;

  const buildText = (percent, note, speedText) => {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    const elapsedMs = startedAt ? Date.now() - startedAt : 0;
    const eta = startedAt ? formatEta(elapsedMs, p) : null;
    const headerIcon = p >= 100 ? "✅" : "⚡";

    const metaParts = [`${p}%`];
    if (speedText) metaParts.push(speedText);
    if (eta) metaParts.push(`sisa ${eta}`);

    return (
      `${headerIcon} <b>${label}</b>\n` +
      `${buildProgressBarOnly(p)}  ${metaParts.join(" · ")}` +
      (note ? `\n<i>${note}</i>` : "")
    );
  };

  return {
    async start(initialPercent = 0, note) {
      startedAt = Date.now();
      const sent = await callTelegramWithRetry(
        () => bot.sendMessage(chatId, buildText(initialPercent, note), { parse_mode: "HTML" }),
        { label: "progress.start" }
      );
      messageId = sent.message_id;
      lastPercent = initialPercent;
      lastEditAt = Date.now();
      return messageId;
    },
    get messageId() {
      return messageId;
    },
    // speedText (opsional): teks kecepatan siap-pakai, mis. "1.4MB/s" -- hitung
    // pakai trackDownloadSpeed() di sisi pemanggil kalau ada data byte/persen mentah.
    async update(percent, note, speedText) {
      if (messageId === null) return;
      const rounded = Math.max(0, Math.min(100, Math.round(percent)));
      const now = Date.now();
      // Throttle: edit hanya kalau persen naik cukup jauh ATAU sudah >1.2 detik,
      // biar tidak spam edit ke Telegram API (bisa kena rate limit).
      if (rounded === lastPercent && !speedText) return;
      if (rounded < 100 && rounded - lastPercent < 3 && now - lastEditAt < 1200) return;

      lastPercent = rounded;
      lastEditAt = now;
      try {
        await bot.editMessageText(buildText(rounded, note, speedText), {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
        });
      } catch (e) {
        // abaikan error "message not modified" / pesan sudah dihapus, dll
      }
    },
    // Edit pesan progress jadi pesan lain (misal hasil akhir atau error), tanpa hapus.
    async replaceWith(text, extraOptions = {}) {
      if (messageId === null) return;
      try {
        await callTelegramWithRetry(
          () =>
            bot.editMessageText(text, {
              chat_id: chatId,
              message_id: messageId,
              parse_mode: "HTML",
              ...extraOptions,
            }),
          { label: "progress.replaceWith", maxRetries: 2 }
        );
      } catch (e) {
        // ignore
      }
    },
    async remove() {
      if (messageId !== null) {
        await bot.deleteMessage(chatId, messageId).catch(() => {});
      }
    },
  };
}

// Buat proses yang tidak punya progress asli (misal: satu kali panggil API),
// simulasikan kenaikan persen bertahap sampai mentok `max`, biar user tetap
// lihat progress berjalan selama menunggu. Setelah proses selesai, panggil
// stop() lalu update manual ke persen akhir (95-100%).
function simulateProgress(progressUpdater, { max = 90, stepMs = 500 } = {}) {
  let percent = 0;
  const interval = setInterval(() => {
    // Naik acak & melambat mendekati `max`, biar terasa natural (bukan linear kaku)
    const remaining = max - percent;
    percent += Math.max(1, remaining * 0.15 + Math.random() * 3);
    if (percent >= max) percent = max;
    progressUpdater.update(percent).catch(() => {});
  }, stepMs);

  return () => clearInterval(interval);
}

// Batas durasi video yang boleh didownload (detik) - biar file tidak kegedean
const MAX_DURATION_SECONDS = 15 * 60; // 15 menit

// Kalau YouTube masih minta login, taruh file cookies.txt di folder bot ini
// (export dari browser pakai extension "Get cookies.txt LOCALLY")
const cookiesPath = path.join(__dirname, "cookies.txt");

// Simpan interval jam / game aktif dsb: sekarang state ini hidup di dalam
// `ctx` (lihat core/context.js) supaya bisa diakses plugins/jam.js,
// plugins/ttt.js, dan plugins/suit.js.

// ================= SISTEM PLUGIN =================
// Semua fitur "berdiri sendiri" (bukan bagian inti moderasi/dashboard/menu)
// sekarang hidup di folder /plugins, bukan di file ini lagi. Supaya gampang
// nambah/ubah fitur baru tanpa harus bongkar file besar ini -- lihat
// README_PLUGIN.md buat panduan lengkapnya.
const { createContext } = require("./core/context");
const { loadPlugins } = require("./core/pluginLoader");

const ctx = createContext({
  bot,
  fs,
  path,
  os,
  https,
  http,
  moment,
  ytSearch,
  Jimp,
  spawn,
  notifyOwner,
  isBotAdmin,
  isOwner,
  OWNER_CHAT_ID,
  ADMIN_IDS,
  geminiApiKey,
  tempDir,
  cookiesPath,
  MAX_DURATION_SECONDS,
});

loadPlugins(ctx);

// ================= ANTI-SPAM (WARNING) =================
// Deteksi user yang kirim pesan terlalu cepat/beruntun dianggap spam.
// Setelah mencapai batas warning, bot otomatis mute sementara (butuh bot jadi admin).

const SPAM_MSG_COUNT = 5;       // jumlah pesan
const SPAM_TIME_WINDOW = 6;     // dalam X detik dianggap spam
const MAX_WARNING = 5;          // batas warning sebelum mute
const MUTE_DURATION_MIN = 30;   // lama mute (menit) setelah kena batas warning

// Riwayat waktu pesan tiap user: "chatId_userId" -> [timestamp, ...]
const spamLog = new Map();
// Jumlah warning aktif tiap user: "chatId_userId" -> jumlah
const spamWarnings = new Map();

function spamKey(chatId, userId) {
  return `${chatId}_${userId}`;
}

// Cek apakah pesan ini bagian dari spam. Return true kalau baru saja melewati batas.
function isSpamming(chatId, userId) {
  const key = spamKey(chatId, userId);
  const now = Date.now();
  const cfg = getAntiSpamConfig(chatId); // maxMessages/perSeconds bisa diatur per-grup lewat dashboard

  let log = spamLog.get(key) || [];
  log.push(now);
  // Hanya simpan pesan dalam window waktu terakhir
  log = log.filter((t) => now - t <= cfg.perSeconds * 1000);
  spamLog.set(key, log);

  return log.length >= cfg.maxMessages;
}

async function handleSpamWarning(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const key = spamKey(chatId, userId);
  const name = msg.from.first_name || msg.from.username || "User";
  const mention = `<a href="tg://user?id=${userId}">${name}</a>`;

  const current = (spamWarnings.get(key) || 0) + 1;
  spamWarnings.set(key, current);
  const cfg = getAntiSpamConfig(chatId); // aksi (warn/mute/kick) bisa diatur per-grup lewat dashboard

  if (current >= MAX_WARNING) {
    spamWarnings.set(key, 0); // reset setelah kena tindakan
    spamLog.set(key, []); // reset log biar tidak langsung ke-trigger lagi

    if (cfg.action === "warn") {
      // Mode "hanya warning": tidak ada mute/kick meski batas warning tercapai
      await bot.sendMessage(
        chatId,
        `🚨 ${mention} sudah mencapai batas peringatan spam (${MAX_WARNING}/${MAX_WARNING}).`,
        { parse_mode: "HTML" }
      );
      pushEvent("warn-limit", { chatId: String(chatId), userId, userName: name });
      return;
    }

    if (cfg.action === "kick") {
      try {
        await bot.banChatMember(chatId, userId);
        await bot.unbanChatMember(chatId, userId, { only_if_banned: true }); // supaya bisa join lagi nanti, bukan ban permanen
        await bot.sendMessage(
          chatId,
          `👢 ${mention} dikeluarkan dari grup karena mencapai ${MAX_WARNING} peringatan spam.`,
          { parse_mode: "HTML" }
        );
        pushEvent("kick", { chatId: String(chatId), userId, userName: name, reason: "spam" });
      } catch (e) {
        await bot.sendMessage(
          chatId,
          `🚨 ${mention} sudah mencapai batas peringatan spam (${MAX_WARNING}/${MAX_WARNING}), tapi bot gagal kick (pastikan bot adalah admin dengan izin "Ban Users").`,
          { parse_mode: "HTML" }
        );
        console.error("Gagal kick user:", e.message);
      }
      return;
    }

    // default: mute
    try {
      const untilDate = Math.floor(Date.now() / 1000) + MUTE_DURATION_MIN * 60;
      await bot.restrictChatMember(chatId, userId, {
        permissions: { can_send_messages: false },
        until_date: untilDate,
      });
      await bot.sendMessage(
        chatId,
        `🔇 ${mention} di-mute selama ${MUTE_DURATION_MIN} menit karena mencapai ${MAX_WARNING} peringatan spam.`,
        { parse_mode: "HTML" }
      );
      pushEvent("mute", { chatId: String(chatId), userId, userName: name, reason: "spam" });
    } catch (e) {
      // Biasanya gagal karena bot belum jadi admin / tidak punya izin restrict
      await bot.sendMessage(
        chatId,
        `🚨 ${mention} sudah mencapai batas peringatan spam (${MAX_WARNING}/${MAX_WARNING}), tapi bot gagal mute (pastikan bot adalah admin dengan izin "Restrict Members").`,
        { parse_mode: "HTML" }
      );
      console.error("Gagal mute user:", e.message);
    }
  } else {
    await bot.sendMessage(
      chatId,
      `⚠️ ${mention}, terdeteksi mengirim pesan terlalu cepat! Peringatan ${current}/${MAX_WARNING}.`,
      { parse_mode: "HTML" }
    );
    pushEvent("spam-warn", { chatId: String(chatId), userId, userName: name, count: current, max: MAX_WARNING });
  }
}

// Dipanggil dari handler "message" utama. Hanya berlaku di grup, dan mengabaikan bot lain.
async function checkSpam(msg) {
  if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return;
  if (!msg.from || msg.from.is_bot) return;
  if (!isWarnEnabled(msg.chat.id)) return; // fitur warning dimatikan admin di grup ini

  if (isSpamming(msg.chat.id, msg.from.id)) {
    await handleSpamWarning(msg);
  }
}

// ================= ON/OFF WARNING (per grup) =================
// Admin grup bisa nyalain/matiin sistem warning-spam di grup masing-masing.
// Setting disimpan ke file biar tidak reset kalau bot di-restart.
const warnSettingsFile = path.join(__dirname, "warn-settings.json");
let warnSettings = {};
try {
  warnSettings = JSON.parse(fs.readFileSync(warnSettingsFile, "utf8"));
} catch (e) {
  warnSettings = {};
}

function isWarnEnabled(chatId) {
  const val = warnSettings[String(chatId)];
  return val === undefined ? true : val; // default: aktif
}

function saveWarnSettings() {
  try {
    fs.writeFileSync(warnSettingsFile, JSON.stringify(warnSettings, null, 2));
  } catch (e) {
    console.error("⚠️ Gagal simpan warn-settings.json:", e.message);
  }
}

async function isGroupAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ["creator", "administrator"].includes(member.status);
  } catch (e) {
    return false;
  }
}

bot.onText(/^\/warnon$/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  const admin = await isGroupAdmin(chatId, msg.from.id);
  if (!admin) {
    return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengubah pengaturan ini.");
  }
  warnSettings[String(chatId)] = true;
  saveWarnSettings();
  bot.sendMessage(chatId, "✅ Sistem warning/anti-spam sudah DIAKTIFKAN di grup ini.");
});

bot.onText(/^\/warnoff$/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  const admin = await isGroupAdmin(chatId, msg.from.id);
  if (!admin) {
    return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengubah pengaturan ini.");
  }
  warnSettings[String(chatId)] = false;
  saveWarnSettings();
  bot.sendMessage(chatId, "🔕 Sistem warning/anti-spam sudah DIMATIKAN di grup ini.");
});

// ================= KONFIGURASI ANTI-SPAM PER GRUP (dari dashboard) =================
// Nilai default (SPAM_MSG_COUNT/SPAM_TIME_WINDOW/aksi "mute") dipakai kalau grup
// belum pernah diatur lewat dashboard. Disimpan terpisah dari warnSettings (yang
// cuma nyimpen on/off) biar tidak mengubah struktur file lama.
const antiSpamConfigFile = path.join(__dirname, "antispam-config.json");
let antiSpamConfig = {};
try {
  if (fs.existsSync(antiSpamConfigFile)) {
    antiSpamConfig = JSON.parse(fs.readFileSync(antiSpamConfigFile, "utf8"));
  }
} catch (e) {
  antiSpamConfig = {};
}
function saveAntiSpamConfig() {
  try {
    fs.writeFileSync(antiSpamConfigFile, JSON.stringify(antiSpamConfig, null, 2));
  } catch (e) {
    console.error("⚠️ Gagal simpan antispam-config.json:", e.message);
  }
}
function getAntiSpamConfig(chatId) {
  const c = antiSpamConfig[String(chatId)] || {};
  const mm = parseInt(c.maxMessages, 10);
  const ps = parseInt(c.perSeconds, 10);
  return {
    maxMessages: Number.isFinite(mm) && mm > 0 ? mm : SPAM_MSG_COUNT,
    perSeconds: Number.isFinite(ps) && ps > 0 ? ps : SPAM_TIME_WINDOW,
    action: ["warn", "mute", "kick"].includes(c.action) ? c.action : "mute",
  };
}

// ================= BLACKLIST KATA PER GRUP (dari dashboard) =================
// Admin bisa set daftar kata/frasa terlarang lewat dashboard web. Kalau ada
// member (bukan admin grup) yang kirim pesan mengandung salah satu kata itu,
// bot otomatis hapus pesannya + jalanin aksi tambahan sesuai pengaturan.
const blacklistSettingsFile = path.join(__dirname, "blacklist-settings.json");
let blacklistSettings = {};
try {
  if (fs.existsSync(blacklistSettingsFile)) {
    blacklistSettings = JSON.parse(fs.readFileSync(blacklistSettingsFile, "utf8"));
  }
} catch (e) {
  blacklistSettings = {};
}
function saveBlacklistSettings() {
  try {
    fs.writeFileSync(blacklistSettingsFile, JSON.stringify(blacklistSettings, null, 2));
  } catch (e) {
    console.error("⚠️ Gagal simpan blacklist-settings.json:", e.message);
  }
}
function getBlacklistConfig(chatId) {
  const c = blacklistSettings[String(chatId)];
  return {
    enabled: !!(c && c.enabled),
    words: (c && Array.isArray(c.words) ? c.words : []).filter(Boolean),
    action: c && ["delete", "warn", "mute"].includes(c.action) ? c.action : "delete",
  };
}

// Cek + tindak lanjut kalau pesan mengandung kata terlarang. Return true kalau
// pesan barusan dihapus (biar pemanggil bisa skip pemrosesan lain kalau perlu).
async function checkBlacklist(msg) {
  try {
    if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return false;
    if (!msg.from || msg.from.is_bot) return false;
    const text = msg.text || msg.caption || "";
    if (!text) return false;

    const cfg = getBlacklistConfig(msg.chat.id);
    if (!cfg.enabled || cfg.words.length === 0) return false;

    const lower = text.toLowerCase();
    const hit = cfg.words.some((w) => lower.includes(String(w).toLowerCase()));
    if (!hit) return false;

    // Jangan filter pesan admin grup, biar tidak salah hapus pesan penting admin.
    const admin = await isGroupAdmin(msg.chat.id, msg.from.id);
    if (admin) return false;

    try {
      await bot.deleteMessage(msg.chat.id, msg.message_id);
    } catch (e) {
      console.error("⚠️ Gagal hapus pesan blacklist:", e.message);
    }

    const name = msg.from.first_name || msg.from.username || "User";
    const mention = `<a href="tg://user?id=${msg.from.id}">${name}</a>`;
    pushEvent("blacklist", { chatId: String(msg.chat.id), userId: msg.from.id, userName: name, action: cfg.action });

    if (cfg.action === "warn") {
      await bot.sendMessage(
        msg.chat.id,
        `🚫 Pesan ${mention} dihapus karena mengandung kata terlarang.`,
        { parse_mode: "HTML" }
      );
      await handleSpamWarning(msg); // tambahkan sebagai warning spam juga
    } else if (cfg.action === "mute") {
      try {
        const untilDate = Math.floor(Date.now() / 1000) + 10 * 60;
        await bot.restrictChatMember(msg.chat.id, msg.from.id, {
          permissions: { can_send_messages: false },
          until_date: untilDate,
        });
        await bot.sendMessage(
          msg.chat.id,
          `🔇 ${mention} di-mute 10 menit karena mengirim kata terlarang.`,
          { parse_mode: "HTML" }
        );
      } catch (e) {
        await bot.sendMessage(
          msg.chat.id,
          `🚫 Pesan ${mention} dihapus (kata terlarang), tapi bot gagal mute (pastikan bot admin dengan izin Restrict Members).`,
          { parse_mode: "HTML" }
        );
      }
    } else {
      await bot.sendMessage(
        msg.chat.id,
        `🚫 Pesan ${mention} dihapus karena mengandung kata terlarang.`,
        { parse_mode: "HTML" }
      );
    }
    return true;
  } catch (e) {
    console.error("⚠️ Error checkBlacklist:", e.message);
    return false;
  }
}

// ================= ANTI-LINK PER GRUP =================
// Admin grup bisa nyalain fitur anti-link buat otomatis hapus pesan yang
// mengandung link (http/https, t.me, domain umum kayak .com/.net/dst) dari
// member biasa. Admin grup & link yang ada di whitelist tetap dibolehin.
// Disimpan mengikuti pola persis blacklist-settings.json biar konsisten.
const antiLinkSettingsFile = path.join(__dirname, "antilink-settings.json");
let antiLinkSettings = {};
try {
  if (fs.existsSync(antiLinkSettingsFile)) {
    antiLinkSettings = JSON.parse(fs.readFileSync(antiLinkSettingsFile, "utf8"));
  }
} catch (e) {
  antiLinkSettings = {};
}
function saveAntiLinkSettings() {
  try {
    fs.writeFileSync(antiLinkSettingsFile, JSON.stringify(antiLinkSettings, null, 2));
  } catch (e) {
    console.error("⚠️ Gagal simpan antilink-settings.json:", e.message);
  }
}
function getAntiLinkConfig(chatId) {
  const c = antiLinkSettings[String(chatId)];
  return {
    enabled: !!(c && c.enabled),
    action: c && ["delete", "warn", "mute", "kick"].includes(c.action) ? c.action : "delete",
    whitelist: (c && Array.isArray(c.whitelist) ? c.whitelist : []).filter(Boolean),
  };
}
function setAntiLinkConfig(chatId, patch) {
  const key = String(chatId);
  const current = getAntiLinkConfig(chatId);
  antiLinkSettings[key] = { ...current, ...patch };
  saveAntiLinkSettings();
  return antiLinkSettings[key];
}

// Regex umum buat nangkep link: http(s)://..., www...., t.me/..., dan domain
// telanjang model "contohsitus.com/apapun". Cukup luas tapi tidak nangkep
// kalimat biasa yang cuma kebetulan ada titik di tengah.
const GENERIC_LINK_REGEX =
  /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]+\.(?:com|net|org|id|co|xyz|me|io|link|club|info|biz|online|site|shop|store|top|vip|icu)\b(?:\/[^\s]*)?|\bt\.me\/[^\s]+/gi;

function extractLinkDomains(text) {
  const matches = text.match(GENERIC_LINK_REGEX) || [];
  return matches.map((m) => {
    let s = m.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
    return s.split("/")[0].toLowerCase();
  });
}

// Cek + tindak lanjut kalau pesan mengandung link yang tidak di-whitelist.
// Return true kalau pesan barusan dihapus.
// Regex ini SENGAJA diduplikasi dari plugins/tiktok.js (bukan di-import),
// supaya checkAntiLink tidak perlu gantung ke ada/tidaknya plugin tiktok.
const TIKTOK_URL_REGEX = /https?:\/\/(?:www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;
async function checkAntiLink(msg) {
  try {
    if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return false;
    if (!msg.from || msg.from.is_bot) return false;
    const text = msg.text || msg.caption || "";
    if (!text) return false;

    const cfg = getAntiLinkConfig(msg.chat.id);
    if (!cfg.enabled) return false;

    // Link TikTok dikecualikan karena sudah ditangani fitur auto-download TikTok.
    if (TIKTOK_URL_REGEX.test(text)) return false;

    const domains = extractLinkDomains(text);
    if (!domains.length) return false;

    const allowed = domains.every((d) =>
      cfg.whitelist.some((w) => d === w.toLowerCase() || d.endsWith("." + w.toLowerCase()))
    );
    if (allowed) return false;

    // Jangan filter pesan admin grup.
    const admin = await isGroupAdmin(msg.chat.id, msg.from.id);
    if (admin) return false;

    try {
      await bot.deleteMessage(msg.chat.id, msg.message_id);
    } catch (e) {
      console.error("⚠️ Gagal hapus pesan anti-link:", e.message);
    }

    const name = msg.from.first_name || msg.from.username || "User";
    const mention = `<a href="tg://user?id=${msg.from.id}">${name}</a>`;
    pushEvent("antilink", { chatId: String(msg.chat.id), userId: msg.from.id, userName: name, action: cfg.action });

    if (cfg.action === "warn") {
      await bot.sendMessage(msg.chat.id, `🔗 Pesan ${mention} dihapus karena mengandung link.`, { parse_mode: "HTML" });
      await handleSpamWarning(msg);
    } else if (cfg.action === "mute") {
      try {
        const untilDate = Math.floor(Date.now() / 1000) + 10 * 60;
        await bot.restrictChatMember(msg.chat.id, msg.from.id, {
          permissions: { can_send_messages: false },
          until_date: untilDate,
        });
        await bot.sendMessage(msg.chat.id, `🔇 ${mention} di-mute 10 menit karena mengirim link.`, { parse_mode: "HTML" });
      } catch (e) {
        await bot.sendMessage(msg.chat.id, `🔗 Pesan ${mention} dihapus (link), tapi bot gagal mute (pastikan bot admin dengan izin Restrict Members).`, { parse_mode: "HTML" });
      }
    } else if (cfg.action === "kick") {
      try {
        await bot.banChatMember(msg.chat.id, msg.from.id);
        await bot.unbanChatMember(msg.chat.id, msg.from.id, { only_if_banned: true });
        await bot.sendMessage(msg.chat.id, `👢 ${mention} dikeluarkan karena mengirim link.`, { parse_mode: "HTML" });
      } catch (e) {
        await bot.sendMessage(msg.chat.id, `🔗 Pesan ${mention} dihapus (link), tapi bot gagal kick (pastikan bot admin dengan izin Ban Users).`, { parse_mode: "HTML" });
      }
    } else {
      await bot.sendMessage(msg.chat.id, `🔗 Pesan ${mention} dihapus karena mengandung link.`, { parse_mode: "HTML" });
    }
    return true;
  } catch (e) {
    console.error("⚠️ Error checkAntiLink:", e.message);
    return false;
  }
}

bot.onText(/^\/antilinkon$/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  const admin = await isGroupAdmin(chatId, msg.from.id);
  if (!admin) return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengubah pengaturan ini.");
  setAntiLinkConfig(chatId, { enabled: true });
  bot.sendMessage(chatId, "✅ Anti-link sudah DIAKTIFKAN. Pesan berisi link dari member (bukan admin) akan otomatis dihapus.");
});

bot.onText(/^\/antilinkoff$/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  const admin = await isGroupAdmin(chatId, msg.from.id);
  if (!admin) return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengubah pengaturan ini.");
  setAntiLinkConfig(chatId, { enabled: false });
  bot.sendMessage(chatId, "🔕 Anti-link sudah DIMATIKAN.");
});

bot.onText(/^\/antilinkaksi\s+(warn|mute|kick|delete)$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  const admin = await isGroupAdmin(chatId, msg.from.id);
  if (!admin) return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengubah pengaturan ini.");
  const action = match[1].toLowerCase();
  setAntiLinkConfig(chatId, { action });
  bot.sendMessage(chatId, `✅ Aksi anti-link diset ke: <b>${action}</b>`, { parse_mode: "HTML" });
});

bot.onText(/^\/antilinkwl(?:\s+(.+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  const admin = await isGroupAdmin(chatId, msg.from.id);
  if (!admin) return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengubah pengaturan ini.");

  const arg = (match[1] || "").trim();
  const cfg = getAntiLinkConfig(chatId);

  if (!arg) {
    const list = cfg.whitelist.length ? cfg.whitelist.map((w) => `• <code>${escapeHtml(w)}</code>`).join("\n") : "(kosong)";
    return bot.sendMessage(
      chatId,
      `🔗 <b>Whitelist Anti-Link</b>\n${list}\n\n💡 Tambah: <code>/antilinkwl domain.com</code>\n💡 Hapus: <code>/antilinkwl hapus domain.com</code>`,
      { parse_mode: "HTML" }
    );
  }

  const removeMatch = /^(?:hapus|remove|del)\s+(.+)$/i.exec(arg);
  if (removeMatch) {
    const target = removeMatch[1].trim().toLowerCase();
    const newList = cfg.whitelist.filter((w) => w.toLowerCase() !== target);
    setAntiLinkConfig(chatId, { whitelist: newList });
    return bot.sendMessage(chatId, `🗑️ Domain <code>${escapeHtml(target)}</code> dihapus dari whitelist anti-link.`, { parse_mode: "HTML" });
  }

  const domain = arg.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  if (!cfg.whitelist.includes(domain)) {
    setAntiLinkConfig(chatId, { whitelist: [...cfg.whitelist, domain] });
  }
  bot.sendMessage(chatId, `✅ Domain <code>${escapeHtml(domain)}</code> ditambahkan ke whitelist anti-link.`, { parse_mode: "HTML" });
});

// ================= STATISTIK GRUP =================
// Data disimpan ke file stats.json biar tidak hilang saat bot restart
const statsFile = path.join(__dirname, "stats.json");
let statsData = {};

try {
  if (fs.existsSync(statsFile)) {
    statsData = JSON.parse(fs.readFileSync(statsFile, "utf8"));
  }
} catch (e) {
  console.error("⚠️ Gagal load stats.json, mulai dari data kosong:", e.message);
  statsData = {};
}

let statsDirty = false;

function saveStats() {
  if (!statsDirty) return;
  try {
    fs.writeFileSync(statsFile, JSON.stringify(statsData, null, 2));
    statsDirty = false;
  } catch (e) {
    console.error("⚠️ Gagal simpan stats.json:", e.message);
  }
}
// Auto-save tiap 10 detik kalau ada perubahan, biar tidak nulis file tiap pesan
setInterval(saveStats, 10 * 1000);

function getChatStats(chatId) {
  const key = String(chatId);
  if (!statsData[key]) {
    statsData[key] = {
      totalMessages: 0,
      users: {}, // userId -> { name, count }
      hourly: Array(24).fill(0),
      daily: {}, // "YYYY-MM-DD" -> jumlah pesan
      joined: 0,
      left: 0,
      startedAt: new Date().toISOString(),
    };
    statsDirty = true;
  }
  return statsData[key];
}

function recordMessage(msg) {
  if (!msg.chat || (msg.chat.type !== "group" && msg.chat.type !== "supergroup")) return;
  if (!msg.from || msg.from.is_bot) return;

  const stats = getChatStats(msg.chat.id);
  const userId = String(msg.from.id);
  const name = msg.from.first_name || msg.from.username || "User";
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);

  stats.totalMessages += 1;
  stats.hourly[now.getHours()] += 1;
  stats.daily[dateKey] = (stats.daily[dateKey] || 0) + 1;

  if (!stats.users[userId]) {
    stats.users[userId] = { name, count: 0 };
  }
  stats.users[userId].name = name; // update kalau nama berubah
  stats.users[userId].count += 1;

  statsDirty = true;
}

function recordJoin(chatId, count = 1) {
  const stats = getChatStats(chatId);
  stats.joined += count;
  statsDirty = true;
  pushEvent("join", { chatId: String(chatId), count });
}

function recordLeave(chatId) {
  const stats = getChatStats(chatId);
  stats.left += 1;
  statsDirty = true;
  pushEvent("leave", { chatId: String(chatId) });
}

// ================= WELCOME / GOODBYE MESSAGE (CUSTOM) =================
// Admin bisa custom teks welcome & goodbye per grup. Placeholder yang bisa dipakai:
// {name}  -> nama member (otomatis jadi mention/tag)
// {group} -> nama grup
// {count} -> jumlah member grup saat ini
const welcomeFile = path.join(__dirname, "welcome-settings.json");
let welcomeSettings = {};
try {
  welcomeSettings = JSON.parse(fs.readFileSync(welcomeFile, "utf8"));
} catch (e) {
  welcomeSettings = {};
}

function saveWelcomeSettings() {
  try {
    fs.writeFileSync(welcomeFile, JSON.stringify(welcomeSettings, null, 2));
  } catch (e) {
    console.error("⚠️ Gagal simpan welcome-settings.json:", e.message);
  }
}

const DEFAULT_WELCOME = "👋 Selamat datang {name} di grup <b>{group}</b>! Semoga betah ya 🎉";
const DEFAULT_GOODBYE = "😢 {name} telah meninggalkan grup <b>{group}</b>. Sampai jumpa lagi!";

function getWelcomeConfig(chatId) {
  const key = String(chatId);
  if (!welcomeSettings[key]) {
    welcomeSettings[key] = { welcome: DEFAULT_WELCOME, goodbye: DEFAULT_GOODBYE, enabled: true };
  }
  return welcomeSettings[key];
}

function fillTemplate(template, { name, group, count }) {
  return template
    .replaceAll("{name}", name)
    .replaceAll("{group}", group)
    .replaceAll("{count}", count);
}

async function sendWelcomeMessage(chatId, member) {
  const config = getWelcomeConfig(chatId);
  if (!config.enabled) return;

  const name = `<a href="tg://user?id=${member.id}">${member.first_name || member.username || "User"}</a>`;
  let group = "grup ini";
  let count = "-";
  try {
    const chat = await bot.getChat(chatId);
    group = chat.title || group;
    count = await bot.getChatMemberCount(chatId);
  } catch (e) {
    // biarin default kalau gagal ambil info chat
  }

  const text = fillTemplate(config.welcome, { name, group, count });
  bot.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((e) => {
    console.error("⚠️ Gagal kirim welcome message:", e.message);
  });

  const rulesConfig = getRulesConfig(chatId);
  if (rulesConfig.autoSend) {
    bot.sendMessage(chatId, rulesConfig.rules, { parse_mode: "HTML" }).catch((e) => {
      console.error("⚠️ Gagal kirim auto-rules:", e.message);
    });
  }
}

async function sendGoodbyeMessage(chatId, member) {
  const config = getWelcomeConfig(chatId);
  if (!config.enabled) return;

  const name = member.first_name || member.username || "User";
  let group = "grup ini";
  let count = "-";
  try {
    const chat = await bot.getChat(chatId);
    group = chat.title || group;
    count = await bot.getChatMemberCount(chatId);
  } catch (e) {
    // biarin default kalau gagal ambil info chat
  }

  const text = fillTemplate(config.goodbye, { name, group, count });
  bot.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((e) => {
    console.error("⚠️ Gagal kirim goodbye message:", e.message);
  });
}

bot.onText(/^\/setwelcome\s+([\s\S]+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa atur welcome message.");
    }
  } catch (e) {
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  const config = getWelcomeConfig(chatId);
  config.welcome = match[1].trim();
  saveWelcomeSettings();

  bot.sendMessage(
    chatId,
    `✅ Welcome message berhasil diubah. Contoh preview:\n\n${fillTemplate(config.welcome, {
      name: `<a href="tg://user?id=${msg.from.id}">${msg.from.first_name}</a>`,
      group: msg.chat.title || "grup ini",
      count: "10",
    })}`,
    { parse_mode: "HTML" }
  );
});

bot.onText(/^\/setgoodbye\s+([\s\S]+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa atur goodbye message.");
    }
  } catch (e) {
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  const config = getWelcomeConfig(chatId);
  config.goodbye = match[1].trim();
  saveWelcomeSettings();

  bot.sendMessage(
    chatId,
    `✅ Goodbye message berhasil diubah. Contoh preview:\n\n${fillTemplate(config.goodbye, {
      name: msg.from.first_name || "User",
      group: msg.chat.title || "grup ini",
      count: "9",
    })}`,
    { parse_mode: "HTML" }
  );
});

bot.onText(/^\/welcome(on|off)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengubah pengaturan ini.");
    }
  } catch (e) {
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  const config = getWelcomeConfig(chatId);
  config.enabled = match[1] === "on";
  saveWelcomeSettings();

  bot.sendMessage(
    chatId,
    config.enabled ? "✅ Welcome/goodbye message DIAKTIFKAN." : "🔕 Welcome/goodbye message DIMATIKAN."
  );
});

bot.onText(/^\/cekwelcome$/, (msg) => {
  const chatId = msg.chat.id;
  const config = getWelcomeConfig(chatId);

  bot.sendMessage(
    chatId,
    `<b>⚙️ SETTING WELCOME/GOODBYE</b>\n\n` +
      `Status: <b>${config.enabled ? "🟢 ON" : "🔴 OFF"}</b>\n\n` +
      `<b>Welcome:</b>\n${config.welcome}\n\n` +
      `<b>Goodbye:</b>\n${config.goodbye}\n\n` +
      `<i>Placeholder: {name} {group} {count}</i>\n` +
      `Ubah pakai <code>/setwelcome teks</code> atau <code>/setgoodbye teks</code>`,
    { parse_mode: "HTML" }
  );
});


// ================= RULES GRUP (bisa di-custom & di-toggle ON/OFF) =================
const rulesFile = path.join(__dirname, "rules-settings.json");
let rulesSettings = {};
try {
  rulesSettings = JSON.parse(fs.readFileSync(rulesFile, "utf8"));
} catch (e) {
  rulesSettings = {};
}

function saveRulesSettings() {
  try {
    fs.writeFileSync(rulesFile, JSON.stringify(rulesSettings, null, 2));
  } catch (e) {
    console.error("⚠️ Gagal simpan rules-settings.json:", e.message);
  }
}

const DEFAULT_RULES =
  `┏━━━━━━━━━━━━━━┓\n` +
  `   👋 ATURAN SANTAI GRUP INI\n` +
  `┗━━━━━━━━━━━━━━┛\n\n` +
  `✨ Have fun, tapi tetap sopan ya!\n` +
  `━━━━━━━━━━━━━━━━━━\n` +
  `🚫 No SARA, no julid berlebihan, no spam\n` +
  `━━━━━━━━━━━━━━━━━━\n` +
  `📢 Mau promosi? Bilang admin dulu gapapa kok\n` +
  `━━━━━━━━━━━━━━━━━━\n` +
  `🤝 Beda pendapat boleh, ribut jangan\n` +
  `━━━━━━━━━━━━━━━━━━\n` +
  `🆘 Ada masalah? Chat admin aja, jangan panik\n\n` +
  `┏━━━━━━━━━━━━━━┓\n` +
  `Yang penting nyaman bareng-bareng 😊\n` +
  `┗━━━━━━━━━━━━━━┛`;

function getRulesConfig(chatId) {
  const key = String(chatId);
  if (!rulesSettings[key]) {
    rulesSettings[key] = { rules: DEFAULT_RULES, autoSend: true };
  }
  return rulesSettings[key];
}

bot.onText(/^\/rules$/, (msg) => {
  const chatId = msg.chat.id;
  const config = getRulesConfig(chatId);
  bot.sendMessage(chatId, config.rules, { parse_mode: "HTML" });
});

bot.onText(/^\/setrules\s+([\s\S]+)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa ubah rules.");
    }
  } catch (e) {
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  const config = getRulesConfig(chatId);
  config.rules = match[1].trim();
  saveRulesSettings();

  bot.sendMessage(chatId, "✅ Rules grup berhasil diubah. Ketik /rules buat lihat hasilnya.");
});

bot.onText(/^\/resetrules$/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa reset rules.");
    }
  } catch (e) {
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  const config = getRulesConfig(chatId);
  config.rules = DEFAULT_RULES;
  saveRulesSettings();
  bot.sendMessage(chatId, "✅ Rules grup dikembalikan ke default.");
});

// Toggle auto-kirim rules bareng welcome message pas ada member baru join
bot.onText(/^\/rulesnotif(on|off)$/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }
  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengubah pengaturan ini.");
    }
  } catch (e) {
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  const config = getRulesConfig(chatId);
  config.autoSend = match[1] === "on";
  saveRulesSettings();

  bot.sendMessage(
    chatId,
    config.autoSend
      ? "✅ Notif rules DIAKTIFKAN (otomatis dikirim ke member baru bareng welcome message)."
      : "🔕 Notif rules DIMATIKAN (member baru tidak otomatis dikirimin rules)."
  );
});

bot.on("message", (msg) => {
  recordMessage(msg);
  checkAntiLink(msg);
  checkBlacklist(msg);
  checkSpam(msg);

  if (msg.new_chat_members && msg.new_chat_members.length) {
    recordJoin(msg.chat.id, msg.new_chat_members.length);
    msg.new_chat_members.forEach((member) => {
      if (botId && member.id === botId) return; // bot sendiri yang ditambahkan, skip welcome
      sendWelcomeMessage(msg.chat.id, member);
    });
  }
  if (msg.left_chat_member) {
    recordLeave(msg.chat.id);
    if (!botId || msg.left_chat_member.id !== botId) {
      sendGoodbyeMessage(msg.chat.id, msg.left_chat_member);
    }
  }
  // Catatan: auto-detect link TikTok & caption /togif /tovideo sekarang jadi
  // listener bot.on("message") SENDIRI di plugins/tiktok.js & plugins/togif.js
  // (node-telegram-bot-api adalah EventEmitter biasa, jadi banyak listener
  // "message" terpisah tetap semuanya kepanggil, tidak saling menimpa).
});

// ================= DAFTAR COMMAND (muncul di tombol "/" Telegram) =================
// Diurutkan per kategori (Telegram nampilinnya sesuai urutan array ini) biar
// enak di-scroll: Menu utama -> Media & Download -> Hiburan & AI -> Grup &
// Moderasi -> Info & Utilitas -> Kustomisasi Tampilan (admin).
bot.setMyCommands([
  // --- Menu utama ---
  { command: "start", description: "🏠 Tampilkan menu utama" },
  { command: "tools", description: "🛠️ Buka menu Bot Tools" },

  // --- Media & Download ---
  { command: "image", description: "🖼️ Cari gambar - /image kucing lucu" },
  { command: "gif", description: "🎞️ Cari gif - /gif kucing lucu" },
  { command: "pinterest", description: "📌 Cari gambar Pinterest (album)" },
  { command: "video", description: "🎬 Cari video YouTube - /video tutorial js" },
  { command: "anime", description: "🎌 Cari info & trailer anime - /anime naruto" },
  { command: "episodes", description: "📚 Daftar episode + link nonton resmi - /episodes naruto 1-3" },
  { command: "music", description: "🎵 Cari musik YouTube - /music lofi" },
  { command: "tiktok", description: "📱 Download video TikTok tanpa watermark - kirim link" },
  { command: "togif", description: "🎞️ Convert video ke GIF (tanpa suara) - reply video/caption /togif" },
  { command: "tovideo", description: "🎬 Convert video (TETAP ADA SUARA) - reply video/caption /tovideo" },

  // --- Hiburan & AI ---
  { command: "ai", description: "🤖 Tanya Gemini AI - /ai halo" },
  { command: "jam", description: "🕒 Jam digital realtime" },
  { command: "stopjam", description: "🛑 Hentikan jam realtime" },
  { command: "ttt", description: "🎮 Main Tic Tac Toe 2 pemain" },
  { command: "stopttt", description: "🛑 Batalkan game Tic Tac Toe" },
  { command: "suit", description: "✊✋✌️ Main Batu Gunting Kertas 2 pemain" },
  { command: "stopsuit", description: "🛑 Batalkan game Batu Gunting Kertas" },
  { command: "joke", description: "😹 Kirim jokes random" },
  { command: "ping", description: "🏓 Cek kecepatan respon bot" },

  // --- Grup & Moderasi ---
  { command: "stats", description: "📊 Statistik aktivitas grup" },
  { command: "statsreset", description: "♻️ Reset statistik grup (khusus admin)" },
  { command: "warns", description: "⚠️ Cek jumlah warning spam user (reply pesannya)" },
  { command: "resetwarn", description: "♻️ Reset warning spam user (khusus admin)" },
  { command: "warnon", description: "🟢 Aktifkan anti-spam grup (khusus admin)" },
  { command: "warnoff", description: "🔴 Matikan anti-spam grup (khusus admin)" },
  { command: "mute", description: "🔇 Bisukan user - reply pesannya (khusus admin)" },
  { command: "unmute", description: "🔊 Buka bisu user - reply pesannya (khusus admin)" },
  { command: "rules", description: "📜 Lihat rules grup" },
  { command: "setrules", description: "✏️ Ubah rules grup (khusus admin)" },
  { command: "resetrules", description: "♻️ Kembalikan rules ke default (khusus admin)" },
  { command: "rulesnotifon", description: "🟢 Auto-kirim rules ke member baru (khusus admin)" },
  { command: "rulesnotifoff", description: "🔴 Matikan auto-kirim rules (khusus admin)" },
  { command: "cekwelcome", description: "⚙️ Cek setting welcome/goodbye" },
  { command: "setwelcome", description: "✏️ Ubah pesan welcome (khusus admin)" },
  { command: "setgoodbye", description: "✏️ Ubah pesan goodbye (khusus admin)" },
  { command: "welcomeon", description: "🟢 Aktifkan welcome/goodbye (khusus admin)" },
  { command: "welcomeoff", description: "🔴 Matikan welcome/goodbye (khusus admin)" },
  { command: "antilinkon", description: "🟢 Aktifkan anti-link grup (khusus admin)" },
  { command: "antilinkoff", description: "🔴 Matikan anti-link grup (khusus admin)" },
  { command: "antilinkaksi", description: "⚙️ Atur aksi anti-link - /antilinkaksi mute (khusus admin)" },
  { command: "antilinkwl", description: "📋 Whitelist domain anti-link - /antilinkwl domain.com (khusus admin)" },

  // --- Info & Utilitas ---
  { command: "kurs", description: "💱 Cek kurs mata uang - /kurs usd" },
  { command: "btc", description: "🪙 Cek harga Bitcoin" },
  { command: "eth", description: "🪙 Cek harga Ethereum" },
  { command: "crypto", description: "🪙 Cek harga koin lain - /crypto sol" },
  { command: "market", description: "📊 Ringkasan top 5 crypto" },
  { command: "translate", description: "🌐 Terjemahkan teks - /translate en halo" },
  { command: "jadwalsholat", description: "🕌 Jadwal sholat - /jadwalsholat jakarta" },
  { command: "setsholat", description: "📍 Set kota jadwal sholat grup (khusus admin)" },
  { command: "stopsholat", description: "🛑 Matikan auto-post jadwal sholat (khusus admin)" },
  { command: "serverinfo", description: "🖥️ Info server bot (khusus admin)" },

  // --- Kustomisasi tampilan (khusus admin) ---
  { command: "setmp3", description: "🎧 Ganti lagu tema menu (khusus admin)" },
  { command: "setnamamp3", description: "🏷️ Ganti judul lagu tema (khusus admin)" },
  { command: "setbanner", description: "🖼️ Ganti banner menu (khusus admin)" },
]);

// ================= MENU (inline keyboard) =================
// Halaman 1: Media & Download. Halaman 2: Hiburan & AI. Halaman 3: Grup, Info
// & Utilitas. Baris nav otomatis nyesuaiin: cuma ◀️ di halaman terakhir,
// cuma ▶️ di halaman pertama, dan dua-duanya di halaman tengah.
const MENU_TOTAL_PAGES = 3;
const MENU_PAGE_LABELS = ["🎨 Media", "🎮 Hiburan & AI", "🛡️ Grup & Info"];

function mainMenuKeyboard(chatId, page = 1) {
  const navRow = [];
  if (page > 1) {
    navRow.push({ text: `◀️ ${MENU_PAGE_LABELS[page - 2]}`, callback_data: `menu_page_${page - 1}` });
  }
  if (page < MENU_TOTAL_PAGES) {
    navRow.push({ text: `${MENU_PAGE_LABELS[page]} ▶️`, callback_data: `menu_page_${page + 1}` });
  }

  const bottomRow = [
    { text: "🔄 Refresh", callback_data: `refresh_menu_${page}` },
    { text: "❌ Tutup", callback_data: "close_menu" },
  ];

  const mediaRows = [
    [{ text: "◇ 🎨 MEDIA & DOWNLOAD ◇", callback_data: "noop" }],
    [
      { text: "🖼️ Gambar", callback_data: "help_image" },
      { text: "📌 Pinterest", callback_data: "help_pinterest" },
    ],
    [
      { text: "🎞️ Gif", callback_data: "help_gif" },
      { text: "🎬 Video", callback_data: "help_video" },
    ],
    [
      { text: "🎵 Musik", callback_data: "help_music" },
      { text: "🎌 Anime", callback_data: "help_anime" },
    ],
    [
      { text: "📚 Episode Anime", callback_data: "help_episodes" },
      { text: "📱 TikTok (No WM)", callback_data: "help_tiktok" },
    ],
    [
      { text: "🎞️ Video→GIF", callback_data: "help_togif" },
      { text: "🎬 Video (ada suara)", callback_data: "help_tovideo" },
    ],
  ];

  const hiburanRows = [
    [{ text: "◇ 🎮 HIBURAN ◇", callback_data: "noop" }],
    [
      { text: "🕒 Jam Realtime", callback_data: "run_jam" },
      { text: "🏓 Ping", callback_data: "run_ping" },
    ],
    [
      { text: "🎮 Tic Tac Toe", callback_data: "help_ttt" },
      { text: "✊✋✌️ Suit", callback_data: "help_suit" },
    ],
    [
      { text: "🤖 Tanya AI", callback_data: "help_ai" },
      { text: "😹 Joke", callback_data: "run_joke" },
    ],
  ];

  const grupInfoRows = [
    [{ text: "◇ 🛡️ GRUP & MODERASI ◇", callback_data: "noop" }],
    [
      { text: "📊 Statistik", callback_data: "help_stats" },
      { text: "⚠️ Anti-Spam", callback_data: "help_spam" },
    ],
    [
      { text: "📜 Rules", callback_data: "run_rules" },
      { text: "👋 Welcome/Goodbye", callback_data: "help_welcome" },
    ],
    [{ text: "◇ 🕌 & 💰 INFO ◇", callback_data: "noop" }],
    [
      { text: "🕌 Jadwal Sholat", callback_data: "help_sholat" },
      { text: "🌐 Translate", callback_data: "help_translate" },
    ],
    [
      { text: "💱 Kurs", callback_data: "help_kurs" },
      { text: "🪙 Crypto", callback_data: "help_crypto" },
    ],
    [{ text: "📊 Top Market", callback_data: "run_market" }],
    [{ text: "🛠️ Buka Bot Tools", callback_data: "run_tools" }],
  ];

  const contentRows = page === 1 ? mediaRows : page === 2 ? hiburanRows : grupInfoRows;

  return {
    reply_markup: {
      inline_keyboard: [...contentRows, navRow, bottomRow],
    },
  };
}

// Kartu ala "USER PROFILE / SERVER STATUS": header ┌─「 judul 」, isi pakai
// bullet ◇, ditutup garis panjang yang berakhir di "○" (mirip desain referensi).
function infoCard(title, lines) {
  const body = lines.map((l) => `◇ ${l}`).join("\n");
  return `┌─「 ${title} 」\n${body}\n└${"─".repeat(22)}○`;
}

function menuText(page = 1) {
  const pageLabel = `${page}/${MENU_TOTAL_PAGES} · ${MENU_PAGE_LABELS[page - 1].replace(/^\S+\s/, "")}`;

  const bodies = [
    infoCard("🎨 MEDIA &amp; DOWNLOAD", [
      "<code>/image</code> <code>/gif</code> <code>/pinterest</code>",
      "<code>/video</code> <code>/anime</code> <code>/music</code>",
      "<code>/tiktok</code> <code>/togif</code> <code>/tovideo</code>",
    ]),
    infoCard("🎮 HIBURAN &amp; AI", [
      "<code>/jam</code> <code>/ttt</code> <code>/suit</code>",
      "<code>/ai</code> <code>/joke</code> <code>/ping</code>",
    ]),
    `${infoCard("🛡️ GRUP &amp; MODERASI", [
      "<code>/stats</code> <code>/warns</code> <code>/rules</code>",
      "<code>/cekwelcome</code>",
    ])}\n\n${infoCard("🕌 INFO &amp; KURS", [
      "<code>/jadwalsholat</code> <code>/translate</code>",
      "<code>/kurs</code> <code>/btc</code> <code>/eth</code> <code>/crypto</code> <code>/market</code>",
    ])}\n\n${infoCard("🛠️ ADMIN TOOLS", ["<code>/tools</code> <code>/serverinfo</code> <code>/panel</code>"])}`,
  ];

  const statusCard = infoCard("🤖 BOT STATUS", [
    botStatusLine(),
    botMemoryLine(),
    `Halaman: <b>${pageLabel}</b>`,
  ]);

  return `
✨ <b>𝗕𝗢𝗧 𝗠𝗘𝗡𝗨</b>

${statusCard}

👋 Pilih fitur lewat tombol di bawah, atau langsung ketik <i>command</i>-nya. Tap tombol buat lihat cara pakai tiap fitur.

${bodies[page - 1]}

💡 Ketik <code>/start</code> kapan saja buat balik ke sini.
`.trim();
}

// Kirim menu utama. Kalau ada banner (animasi/gif/mp4 ATAU foto jpg) di folder
// images/, tampilkan di atas menu. Prioritas: banner.mp4 (animasi, paling
// ringan & kualitas terbaik di Telegram) -> banner.gif (animasi mentah) ->
// banner.jpg (foto statis biasa). Animasi Telegram = auto-play, loop, tanpa
// suara, tanpa perlu diklik user (beda dengan video biasa yang butuh tap play).
const bannerMp4Path = path.join(__dirname, "images", "banner.mp4");
const bannerGifPath = path.join(__dirname, "images", "banner.gif");
const bannerJpgPath = path.join(__dirname, "images", "banner.jpg");
function resolveBannerPath() {
  if (fs.existsSync(bannerMp4Path)) return { path: bannerMp4Path, type: "animation" };
  if (fs.existsSync(bannerGifPath)) return { path: bannerGifPath, type: "animation" };
  if (fs.existsSync(bannerJpgPath)) return { path: bannerJpgPath, type: "photo" };
  return null;
}

// Kalau ada file mp3 di folder assets/, dikirim otomatis bareng menu (sebagai pesan terpisah setelah menu)
const menuMusicPath = path.join(__dirname, "assets", "menu-song.mp3");

// Cache file_id banner & lagu menu setelah upload PERTAMA berhasil. Tanpa ini,
// setiap "/menu" akan upload ULANG file dari disk ke Telegram setiap kali --
// itu penyebab utama "/menu" kadang lama keluarnya (apalagi pas bot baru
// nyala: koneksi belum "hangat" & file belum ke-cache OS, jadi upload
// pertama terasa jauh lebih lambat dari biasanya). Dengan file_id, request
// berikutnya cukup rujuk file yang sudah ada di server Telegram (nyaris
// instan), tidak upload ulang dari HP sama sekali.
//
// PENTING: cache ini disimpan juga ke disk (menu-cache.json), bukan cuma di
// memori. Kalau cuma di memori, tiap kali bot di-restart (mati listrik, HP
// kena kill, redeploy, dll) cache-nya ke-reset ke null, jadi /menu PERTAMA
// setelah tiap restart selalu lambat lagi (upload ulang banner+lagu dari
// disk). Dengan disimpan ke file, begitu bot nyala lagi, cache lama masih
// bisa langsung dipakai, jadi /menu tetap cepat sejak request pertama.
const menuCacheFile = path.join(__dirname, "menu-cache.json");
let cachedBannerFileId = null;
let cachedBannerType = null; // "animation" (gif/mp4) atau "photo" (jpg), mengikuti jenis file banner terakhir yang dipasang
let cachedMenuSongFileId = null;
let menuSongTitle = "Lagu Tema Bot"; // Nama/judul lagu yang ditampilkan Telegram, bisa diganti lewat /setnamamp3

try {
  if (fs.existsSync(menuCacheFile)) {
    const cached = JSON.parse(fs.readFileSync(menuCacheFile, "utf8"));
    cachedBannerFileId = cached.bannerFileId || null;
    cachedBannerType = cached.bannerType || (cachedBannerFileId ? "animation" : null); // default "animation" biar kompatibel dengan cache lama
    cachedMenuSongFileId = cached.menuSongFileId || null;
    menuSongTitle = cached.menuSongTitle || menuSongTitle;
  }
} catch (e) {
  console.error("⚠️ Gagal load menu-cache.json, mulai dari cache kosong:", e.message);
}

function saveMenuCache() {
  try {
    fs.writeFileSync(
      menuCacheFile,
      JSON.stringify(
        {
          bannerFileId: cachedBannerFileId,
          bannerType: cachedBannerType,
          menuSongFileId: cachedMenuSongFileId,
          menuSongTitle,
        },
        null,
        2
      )
    );
  } catch (e) {
    console.error("⚠️ Gagal simpan menu-cache.json:", e.message);
  }
}

// Kirim lagu tema menu, kalau filenya ada. Dipisah jadi fungsi sendiri biar gampang dipanggil ulang.
async function sendMenuSong(chatId) {
  if (!fs.existsSync(menuMusicPath) && !cachedMenuSongFileId) return;
  const songStart = Date.now();
  const usingSongCache = !!cachedMenuSongFileId;
  try {
    await bot.sendChatAction(chatId, "upload_voice");
    const sent = await bot.sendAudio(chatId, cachedMenuSongFileId || fs.createReadStream(menuMusicPath), {
      title: menuSongTitle,
      performer: "Bot",
    });
    console.log(
      `[MENU] chat=${chatId} lagu terkirim (${usingSongCache ? "dari cache" : "UPLOAD DISK"}, judul="${menuSongTitle}") dalam ${
        Date.now() - songStart
      }ms`
    );
    if (sent && sent.audio && sent.audio.file_id) {
      const isNewFileId = sent.audio.file_id !== cachedMenuSongFileId;
      cachedMenuSongFileId = sent.audio.file_id;
      if (isNewFileId) saveMenuCache();
    }
  } catch (err) {
    console.error("Gagal kirim lagu menu:", err.message);
    // Kalau gagal pakai file_id cache (misal sudah kedaluwarsa/dihapus di sisi
    // Telegram), reset cache-nya supaya percobaan berikutnya upload ulang dari disk.
    if (cachedMenuSongFileId) {
      cachedMenuSongFileId = null;
      saveMenuCache();
      return sendMenuSong(chatId);
    }
  }
}

// ================= SETAUDIO: GANTI LAGU TEMA MENU =================
// Fitur admin buat ganti file assets/menu-song.mp3 (yang dikirim bareng /menu)
// tanpa perlu upload manual ke server. Caranya:
//   1) Kirim file mp3/audio dengan caption "/setmp3", ATAU
//   2) Reply ke pesan yang berisi file mp3/audio dengan mengetik "/setmp3"
const assetsDir = path.join(__dirname, "assets");
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

// Ambil file_id audio dari sebuah pesan Telegram, terima dalam bentuk audio
// asli, voice note, ATAU dokumen yang mime type-nya audio (banyak orang kirim
// mp3 sebagai "file/dokumen" biar tidak dikompres Telegram).
function getAudioSourceFromMessage(message) {
  if (!message) return null;
  if (message.audio) {
    return { file_id: message.audio.file_id, title: message.audio.title, performer: message.audio.performer };
  }
  if (message.voice) {
    return { file_id: message.voice.file_id };
  }
  if (message.document && message.document.mime_type && message.document.mime_type.startsWith("audio/")) {
    return { file_id: message.document.file_id };
  }
  return null;
}

bot.on("message", async (msg) => {
  const rawText = msg.text || msg.caption || "";
  if (!/^\/setmp3(?:@\w+)?\b/i.test(rawText)) return; // bukan command /setmp3, abaikan

  const chatId = msg.chat.id;

  // Cek admin dulu. Ini setting GLOBAL (berlaku ke semua grup, bukan per-chat),
  // jadi di grup harus admin grup, dan di chat pribadi/mana pun HARUS admin
  // bot (ADMIN_IDS/OWNER_CHAT_ID) -- BUKAN "bebas siapa saja" seperti sebelumnya.
  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    const admin = await isGroupAdmin(chatId, msg.from.id);
    if (!admin) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengganti lagu tema bot.");
    }
  } else if (!isBotAdmin(msg.from.id)) {
    return bot.sendMessage(chatId, "⛔ Fitur ini khusus admin bot (mengubah lagu tema untuk semua grup).");
  }

  // Audio boleh nempel langsung di pesan yang sama (caption /setmp3), atau
  // di pesan yang di-reply.
  const source = getAudioSourceFromMessage(msg) || getAudioSourceFromMessage(msg.reply_to_message);

  if (!source) {
    return bot.sendMessage(
      chatId,
      "⚠️ Format salah. Kirim file mp3/audio dengan caption <code>/setmp3</code>, " +
        "atau reply pesan yang berisi mp3 dengan mengetik <code>/setmp3</code>.",
      { parse_mode: "HTML" }
    );
  }

  let downloadedPath;
  let stopSim;
  const progress = createProgressUpdater(chatId, "Ganti Audio Menu");

  try {
    await progress.start(0, "Mengunduh file audio dari Telegram...");
    // node-telegram-bot-api tidak expose progress asli buat downloadFile(),
    // jadi disimulasikan dulu biar user tetap lihat progress berjalan.
    stopSim = simulateProgress(progress, { max: 85, stepMs: 300 });

    // Download file audio dari server Telegram ke folder sementara dulu.
    downloadedPath = await callTelegramWithRetry(() => bot.downloadFile(source.file_id, tempDir), {
      label: "setmp3 downloadFile",
    });

    if (stopSim) {
      stopSim();
      stopSim = null;
    }
    await progress.update(90, "Memasang audio baru...");

    // Pindahkan (timpa) jadi assets/menu-song.mp3, ini file yang dibaca sendMenuSong().
    fs.copyFileSync(downloadedPath, menuMusicPath);
    fs.unlink(downloadedPath, () => {}); // bersihin file sementara, abaikan kalau gagal

    // Reset cache file_id lama supaya /menu berikutnya upload ULANG file baru
    // ini ke Telegram (bukan masih ngirim lagu lama yang ke-cache).
    cachedMenuSongFileId = null;
    saveMenuCache();

    await progress.remove();
    await bot.sendMessage(chatId, "✅ Audio tema menu berhasil diganti! Preview di bawah 👇");

    // Kirim preview biar admin langsung bisa dengar hasilnya & sekaligus
    // bikin cache file_id yang baru.
    await sendMenuSong(chatId);
  } catch (err) {
    if (stopSim) stopSim();
    console.error("⚠️ Gagal setmp3:", err.message);
    if (downloadedPath) fs.unlink(downloadedPath, () => {});
    await progress.replaceWith(`❌ Gagal mengganti audio: ${err.message}`);
  }
});

// ================= SETNAMAMP3: GANTI NAMA/JUDUL LAGU TEMA MENU =================
// Ganti judul yang ditampilkan Telegram untuk lagu tema (default: "Lagu Tema Bot").
// Format: /setnamamp3 <nama baru>
// CATATAN PENTING: Telegram HANYA membaca title/performer dari FILE YANG BARU
// DI-UPLOAD, bukan dari file_id yang sudah ke-cache. Makanya di sini cache
// lama WAJIB direset supaya /menu berikutnya upload ulang dari disk dengan
// judul baru (kalau tidak, judul lama bakal tetap kepakai terus).
bot.onText(/^\/setnamamp3(?:@\w+)?\s+([\s\S]+)$/i, async (msg, match) => {
  const chatId = msg.chat.id;

  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    const admin = await isGroupAdmin(chatId, msg.from.id);
    if (!admin) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengganti nama lagu tema bot.");
    }
  } else if (!isBotAdmin(msg.from.id)) {
    return bot.sendMessage(chatId, "⛔ Fitur ini khusus admin bot (mengubah nama lagu tema untuk semua grup).");
  }

  const newTitle = match[1].trim().slice(0, 64); // batasi biar tidak kepanjangan pas ditampilkan Telegram
  if (!newTitle) {
    return bot.sendMessage(chatId, "⚠️ Nama tidak boleh kosong. Contoh: <code>/setnamamp3 Lagu Kebangsaan Grup</code>", {
      parse_mode: "HTML",
    });
  }

  menuSongTitle = newTitle;
  cachedMenuSongFileId = null; // paksa upload ulang dari disk biar judul baru kepakai
  saveMenuCache();

  await bot.sendMessage(chatId, `✅ Nama lagu tema menu diganti jadi: <b>${newTitle}</b>\n\nPreview di bawah 👇`, {
    parse_mode: "HTML",
  });
  await sendMenuSong(chatId);
});

bot.onText(/^\/setnamamp3$/i, (msg) =>
  bot.sendMessage(msg.chat.id, "⚠️ Format: <code>/setnamamp3 Lagu Kebangsaan Grup</code>", { parse_mode: "HTML" })
);

// ================= SETBANNER: GANTI BANNER MENU (GIF/MP4/JPG) =================
// Fitur admin buat ganti banner yang muncul di atas /menu, mendukung animasi
// (GIF/MP4) maupun foto statis (JPG/PNG). Caranya sama seperti /setmp3:
//   1) Kirim gambar/gif dengan caption "/setbanner", ATAU
//   2) Reply ke pesan yang berisi gambar/gif dengan mengetik "/setbanner"
// File lama (apa pun jenisnya) otomatis dihapus supaya tidak ada banner ganda
// yang bikin bingung banner mana yang kepakai.
function getBannerSourceFromMessage(message) {
  if (!message) return null;
  if (message.animation) {
    return { file_id: message.animation.file_id, targetPath: bannerMp4Path, type: "animation" };
  }
  if (message.video) {
    return { file_id: message.video.file_id, targetPath: bannerMp4Path, type: "animation" };
  }
  if (message.photo && message.photo.length) {
    // Array foto Telegram terurut kecil -> besar, ambil resolusi terbesar (elemen terakhir)
    const largest = message.photo[message.photo.length - 1];
    return { file_id: largest.file_id, targetPath: bannerJpgPath, type: "photo" };
  }
  if (message.document && message.document.mime_type) {
    const mime = message.document.mime_type;
    if (mime === "image/gif") {
      return { file_id: message.document.file_id, targetPath: bannerGifPath, type: "animation" };
    }
    if (mime.startsWith("video/")) {
      return { file_id: message.document.file_id, targetPath: bannerMp4Path, type: "animation" };
    }
    if (mime.startsWith("image/")) {
      return { file_id: message.document.file_id, targetPath: bannerJpgPath, type: "photo" };
    }
  }
  return null;
}

bot.on("message", async (msg) => {
  const rawText = msg.text || msg.caption || "";
  if (!/^\/setbanner(?:@\w+)?\b/i.test(rawText)) return; // bukan command /setbanner, abaikan

  const chatId = msg.chat.id;

  // Cek admin dulu. Ini setting GLOBAL (berlaku ke semua grup, bukan per-chat),
  // jadi di grup harus admin grup, dan di chat pribadi/mana pun HARUS admin
  // bot (ADMIN_IDS/OWNER_CHAT_ID) -- BUKAN "bebas siapa saja" seperti sebelumnya.
  if (msg.chat.type === "group" || msg.chat.type === "supergroup") {
    const admin = await isGroupAdmin(chatId, msg.from.id);
    if (!admin) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa mengganti banner bot.");
    }
  } else if (!isBotAdmin(msg.from.id)) {
    return bot.sendMessage(chatId, "⛔ Fitur ini khusus admin bot (mengubah banner untuk semua grup).");
  }

  // Gambar/gif boleh nempel langsung di pesan yang sama (caption /setbanner),
  // atau di pesan yang di-reply.
  const source = getBannerSourceFromMessage(msg) || getBannerSourceFromMessage(msg.reply_to_message);

  if (!source) {
    return bot.sendMessage(
      chatId,
      "⚠️ Format salah. Kirim GIF/JPG/PNG dengan caption <code>/setbanner</code>, " +
        "atau reply pesan yang berisi GIF/gambar dengan mengetik <code>/setbanner</code>.",
      { parse_mode: "HTML" }
    );
  }

  let downloadedPath;
  let stopSim;
  const progress = createProgressUpdater(chatId, "Ganti Banner Menu");

  try {
    await progress.start(0, "Mengunduh file dari Telegram...");
    // node-telegram-bot-api tidak expose progress asli buat downloadFile(),
    // jadi disimulasikan dulu biar user tetap lihat progress berjalan.
    stopSim = simulateProgress(progress, { max: 85, stepMs: 300 });

    // Download file dari server Telegram ke folder sementara dulu.
    downloadedPath = await callTelegramWithRetry(() => bot.downloadFile(source.file_id, tempDir), {
      label: "setbanner downloadFile",
    });

    if (stopSim) {
      stopSim();
      stopSim = null;
    }
    await progress.update(90, "Memasang banner baru...");

    // Hapus SEMUA file banner lama (mp4/gif/jpg) dulu, biar cuma ada satu
    // banner aktif dan tidak ambigu jenis mana yang bakal dipakai.
    [bannerMp4Path, bannerGifPath, bannerJpgPath].forEach((p) => {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });
    fs.copyFileSync(downloadedPath, source.targetPath);
    fs.unlink(downloadedPath, () => {}); // bersihin file sementara, abaikan kalau gagal

    // Reset cache file_id lama supaya /menu berikutnya upload ULANG banner
    // baru ini ke Telegram (bukan masih pakai banner lama yang ke-cache).
    cachedBannerFileId = null;
    cachedBannerType = null;
    saveMenuCache();

    await progress.remove();
    await bot.sendMessage(
      chatId,
      `✅ Banner menu berhasil diganti (${source.type === "photo" ? "foto" : "animasi"})! Preview di bawah 👇`
    );

    // Kirim preview menu lengkap biar admin langsung lihat hasilnya & sekaligus
    // bikin cache file_id yang baru.
    await sendMainMenu(chatId);
  } catch (err) {
    if (stopSim) stopSim();
    console.error("⚠️ Gagal setbanner:", err.message);
    if (downloadedPath) fs.unlink(downloadedPath, () => {});
    await progress.replaceWith(`❌ Gagal mengganti banner: ${err.message}`);
  }
});

async function sendMainMenu(chatId) {
  const menuStart = Date.now();
  const bannerInfo = resolveBannerPath();
  const bannerType = cachedBannerFileId ? cachedBannerType : bannerInfo ? bannerInfo.type : null;
  console.log(
    `[MENU] chat=${chatId} cek banner -> path=${(bannerInfo && bannerInfo.path) || "(none)"} tipe=${
      bannerType || "-"
    } cache=${cachedBannerFileId ? "ADA" : "kosong"} songCache=${
      cachedMenuSongFileId ? "ADA" : "kosong"
    } queueBerat=${heavyJobQueueWaiting}`
  );

  if (cachedBannerFileId || bannerInfo) {
    try {
      // Gif/mp4/jpg + caption + tombol jadi SATU pesan. Caption gif/foto punya
      // limit sama (1024 karakter) makanya menuText() sudah dipangkas ringkas.
      // Pakai file_id cache kalau ada (jauh lebih cepat), baru fallback upload
      // dari disk kalau belum pernah/cache-nya gagal dipakai.
      //
      // Banner & lagu dikirim PARALEL (bukan nunggu satu-satu) -- kalau salah
      // satu/keduanya belum ke-cache dan harus upload dari disk, waktu
      // tunggunya jadi maksimal cuma sebesar upload yang paling lambat, bukan
      // dijumlah kayak sebelumnya (banner selesai dulu baru lagu mulai).
      const usingBannerCache = !!cachedBannerFileId;
      const bannerSource = cachedBannerFileId || fs.createReadStream(bannerInfo.path);
      const sendBannerFn = bannerType === "photo" ? bot.sendPhoto.bind(bot) : bot.sendAnimation.bind(bot);
      const bannerSendPromise = callTelegramWithRetry(
        () =>
          sendBannerFn(chatId, bannerSource, {
            caption: menuText(1),
            parse_mode: "HTML",
            ...mainMenuKeyboard(chatId, 1),
          }),
        { label: "start.banner" }
      ).then((res) => {
        console.log(
          `[MENU] chat=${chatId} banner terkirim (${usingBannerCache ? "dari cache" : "UPLOAD DISK"}, tipe=${bannerType}) dalam ${
            Date.now() - menuStart
          }ms`
        );
        return res;
      });
      const [sent] = await Promise.all([bannerSendPromise, sendMenuSong(chatId)]);
      console.log(`[MENU] chat=${chatId} SELESAI total ${Date.now() - menuStart}ms`);

      let newFileId = null;
      if (sent && sent.animation && sent.animation.file_id) newFileId = sent.animation.file_id;
      else if (sent && sent.photo && sent.photo.length) newFileId = sent.photo[sent.photo.length - 1].file_id;

      if (newFileId) {
        const isNewFileId = newFileId !== cachedBannerFileId || bannerType !== cachedBannerType;
        cachedBannerFileId = newFileId;
        cachedBannerType = bannerType;
        if (isNewFileId) {
          saveMenuCache();
          console.log(
            `[MENU] file_id banner baru disimpan ke cache -> /menu berikutnya harusnya instan. File: ${menuCacheFile}`
          );
        }
      }
      return sent;
    } catch (err) {
      const tgDetail =
        (err && err.response && err.response.body && JSON.stringify(err.response.body)) || null;
      console.error(
        "Gagal kirim banner:",
        err && err.message ? err.message : "(tidak ada pesan error)",
        tgDetail ? `| detail Telegram: ${tgDetail}` : "",
        err && err.code ? `| code: ${err.code}` : ""
      );
      // Kalau gagal pakai file_id cache, reset dan coba sekali lagi upload dari disk.
      if (cachedBannerFileId) {
        cachedBannerFileId = null;
        cachedBannerType = null;
        saveMenuCache();
        return sendMainMenu(chatId);
      }
      // lanjut ke fallback teks di bawah
    }
  }

  const sent = await callTelegramWithRetry(
    () =>
      bot.sendMessage(chatId, menuText(1), {
        parse_mode: "HTML",
        ...mainMenuKeyboard(chatId, 1),
      }),
    { label: "start.menu.text" }
  );
  await sendMenuSong(chatId);
  return sent;
}

// ================= BOOT SEQUENCE (efek animasi ala terminal booting) =================
// Ditampilkan sekilas tiap /start dipanggil, sebelum menu utama muncul --
// biar kesan pertama kayak lagi boot sistem/hacker terminal. Pesan boot ini
// pesan teks biasa (bukan media) jadi tidak ganggu logic banner/caption di
// sendMainMenu(), dan otomatis dihapus begitu selesai.
const BOOT_ASCII = `<code>╭───────────────────╮
│  B O O T C O R E  │
│ BOOTING SYSTEM... │
╰───────────────────╯</code>`;

// Sebelumnya cuma 5 titik persen yang jauh jaraknya (12 -> 34 -> 58...) jadi
// bar-nya keliatan "lompat-lompat"/kaku tiap di-edit. Sekarang bar-nya diisi
// per-frame (interval kecil, kenaikan persen kecil) biar keliatan ngalir
// halus kayak animasi loading beneran, sementara label teksnya tetap cuma
// ganti di titik-titik tertentu (nggak usah ganti tiap frame, kalau kebanyakan
// ganti teks malah bikin mata capek bacanya, bukan smooth).
const BOOT_LABEL_STAGES = [
  { until: 20, label: "Booting kernel..." },
  { until: 45, label: "Memuat modul inti..." },
  { until: 65, label: "Memverifikasi izin akses..." },
  { until: 90, label: "Sinkronisasi konfigurasi..." },
  { until: 100, label: "Sistem online. Access granted." },
];

function labelForPercent(percent) {
  const stage = BOOT_LABEL_STAGES.find((s) => percent <= s.until);
  return stage ? stage.label : BOOT_LABEL_STAGES[BOOT_LABEL_STAGES.length - 1].label;
}

// Frame persen naik pelan-pelan. Sebelumnya 12 frame @160ms -- ternyata
// terlalu rapat dan mancing flood-control Telegram (edit message beruntun
// kelewat cepat), yang efeknya malah bikin animasi DAN navigasi tombol
// (geser halaman menu) kena drop/gagal diam-diam sesudahnya. Diturunin ke
// 7 frame @260ms: masih kerasa ngalir (nggak lompat kayak versi 5-step
// awal) tapi jauh lebih aman dari rate limit.
const BOOT_FRAME_PERCENTS = [8, 22, 38, 55, 72, 88, 100];
const BOOT_FRAME_DELAY_MS = 260;

function buildBootText(percent) {
  const bar = buildProgressBar(percent);
  const icon = percent >= 100 ? "✅" : "⏳";
  return (
    `${BOOT_ASCII}\n\n` +
    `<code>${bar}</code>\n` +
    `${icon} <i>${labelForPercent(percent)}</i>`
  );
}

async function runBootSequence(chatId) {
  try {
    const sent = await callTelegramWithRetry(
      () =>
        bot.sendMessage(chatId, buildBootText(BOOT_FRAME_PERCENTS[0]), {
          parse_mode: "HTML",
        }),
      { label: "start.boot" }
    );
    for (let i = 1; i < BOOT_FRAME_PERCENTS.length; i++) {
      await new Promise((r) => setTimeout(r, BOOT_FRAME_DELAY_MS));
      try {
        await callTelegramWithRetry(
          () =>
            bot.editMessageText(buildBootText(BOOT_FRAME_PERCENTS[i]), {
              chat_id: chatId,
              message_id: sent.message_id,
              parse_mode: "HTML",
            }),
          { maxRetries: 1, label: "start.boot.frame" }
        );
      } catch (e) {
        // abaikan kalau gagal edit (misal pesan sempat dihapus user)
      }
    }
    await new Promise((r) => setTimeout(r, 450));
    try {
      await bot.deleteMessage(chatId, sent.message_id);
    } catch (e) {
      // abaikan kalau gagal hapus (misal bot tidak punya izin di grup itu)
    }
  } catch (e) {
    console.error("⚠️ Gagal jalanin boot sequence:", e.message);
  }
}

// ================= START =================
bot.onText(/^\/start$/, async (msg) => {
  const chatId = msg.chat.id;
  await runBootSequence(chatId);
  try {
    await sendMainMenu(chatId);
  } catch (err) {
    // Kalau sendMainMenu gagal total (banner + fallback teks dua-duanya kena
    // error, misal rate limit 429 atau koneksi Telegram lagi bermasalah),
    // sebelumnya user cuma diam aja tanpa respon apapun. Sekarang minimal
    // dikasih tau + disuruh coba lagi, jangan sampai keliatan bot "mati".
    console.error(`⚠️ /start gagal total buat chat=${chatId}:`, err && err.message ? err.message : err);
    try {
      await callTelegramWithRetry(
        () =>
          bot.sendMessage(
            chatId,
            "⚠️ Menu lagi gagal dimuat (kemungkinan server Telegram lagi sibuk). Coba ketik <code>/start</code> lagi sebentar lagi ya.",
            { parse_mode: "HTML" }
          ),
        { label: "start.fallback" }
      );
    } catch (e2) {
      console.error(`⚠️ Fallback /start juga gagal buat chat=${chatId}:`, e2.message);
    }
  }
});

// ================= PANEL ADMIN (/panel) — HANYA UNTUK ADMIN BOT =================
// Dashboard ringkas langsung lewat chat Telegram (bukan web), isinya rekap
// statistik seluruh grup, daftar grup, info server, dan broadcast pesan ke
// semua grup. Diproteksi ADMIN_IDS/OWNER_CHAT_ID (lihat konfigurasi di atas)
// -- kalau bukan admin, command ini DIAM SAJA (tidak kasih tau alasan
// penolakan) supaya orang lain tidak tahu fitur ini ada sama sekali.

// Nyimpen user yang lagi "nunggu" ketik pesan buat broadcast, biar pesan
// berikutnya yang dia ketik di chat pribadi otomatis dianggap isi broadcast
// dan bukan command biasa. Key: userId (string) -> true.
const pendingBroadcast = new Map();

function getGlobalSummary() {
  const chatIds = Object.keys(statsData);
  // Pakai format yang SAMA persis dengan yang dipakai recordMessage() buat
  // nulis stats.daily (lihat fungsi recordMessage di atas), supaya key-nya
  // nyambung dan angka "pesan hari ini" akurat.
  const todayKey = new Date().toISOString().slice(0, 10);
  let totalMsgToday = 0;
  let totalMsgAll = 0;
  let totalJoined = 0;
  let totalLeft = 0;

  for (const id of chatIds) {
    const s = statsData[id] || {};
    totalMsgAll += s.totalMessages || 0;
    totalMsgToday += (s.daily && s.daily[todayKey]) || 0;
    totalJoined += s.joined || 0;
    totalLeft += s.left || 0;
  }

  return {
    totalGroups: chatIds.length,
    totalMsgToday,
    totalMsgAll,
    totalJoined,
    totalLeft,
  };
}

function adminPanelText() {
  const g = getGlobalSummary();
  const botUptime = formatUptime(process.uptime());
  return (
    `🛡️ 𝗣𝗔𝗡𝗘𝗟 𝗔𝗗𝗠𝗜𝗡\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `Dashboard ini cuma bisa dilihat & dipakai admin bot.\n\n` +
    `<b>📊 Ringkasan</b>\n` +
    `▸ Total grup terpantau : <b>${g.totalGroups}</b>\n` +
    `▸ Pesan hari ini : <b>${g.totalMsgToday}</b>\n` +
    `▸ Pesan sepanjang waktu : <b>${g.totalMsgAll}</b>\n` +
    `▸ Member masuk/keluar : <b>${g.totalJoined}</b> / <b>${g.totalLeft}</b>\n` +
    `▸ Uptime bot : <b>${botUptime}</b>\n\n` +
    `Pilih menu di bawah 👇`
  );
}

function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "📊 Statistik Global", callback_data: "adminpanel:stats" },
        { text: "🗂 Daftar Grup", callback_data: "adminpanel:groups" },
      ],
      [
        { text: "📢 Broadcast ke Grup", callback_data: "adminpanel:broadcast" },
        { text: "🖥 Info Server", callback_data: "adminpanel:serverinfo" },
      ],
      [
        { text: "📋 Semua Fitur Bot", callback_data: "adminpanel:features:1" },
        { text: "⚙️ Config Grup", callback_data: "adminpanel:groupconfig" },
      ],
      [
        { text: "👑 Admin Bot", callback_data: "adminpanel:admins" },
        { text: "🔄 Restart Bot", callback_data: "adminpanel:restart" },
      ],
      [
        { text: "🔄 Refresh", callback_data: "adminpanel:refresh" },
        { text: "❌ Tutup", callback_data: "adminpanel:close" },
      ],
    ],
  };
}

// ================= SEMUA FITUR BOT (dalam /panel) =================
// Rekap LENGKAP semua command yang ada di bot ini, dikelompokin per
// kategori & dipecah beberapa halaman biar tidak kena limit panjang pesan
// Telegram (4096 karakter). Ini murni referensi teks (read-only), beda
// dengan /tools yang punya tombol aksi langsung.
const ADMIN_FEATURES_TOTAL_PAGES = 3;
const ADMIN_FEATURES_PAGE_LABELS = ["🎨 Media & Hiburan", "🛡️ Grup, Moderasi & Info", "🛠️ Admin Tools & Panel"];

function adminFeaturesText(page = 1) {
  const pageLabel = `${page}/${ADMIN_FEATURES_TOTAL_PAGES} · ${ADMIN_FEATURES_PAGE_LABELS[page - 1]}`;

  const bodies = [
    `┏ 🎨 <b>MEDIA &amp; DOWNLOAD</b>\n` +
      `┗ <code>/image</code> — cari &amp; kirim gambar\n` +
      `┗ <code>/gif</code> — cari &amp; kirim GIF\n` +
      `┗ <code>/pinterest</code> — kirim album gambar Pinterest\n` +
      `┗ <code>/video</code> — cari &amp; kirim video YouTube\n` +
      `┗ <code>/anime</code> — info anime (poster, sinopsis, trailer)\n` +
      `┗ <code>/episodes</code> — daftar episode &amp; tanggal tayang anime\n` +
      `┗ <code>/music</code> — cari &amp; kirim lagu MP3\n` +
      `┗ <code>/tiktok</code> — download video TikTok tanpa watermark\n` +
      `┗ <code>/togif</code> — ubah video/animasi jadi GIF\n` +
      `┗ <code>/tovideo</code> — ubah video/animasi jadi video (tetap ada suara)\n\n` +
      `┏ 🎮 <b>HIBURAN</b>\n` +
      `┗ <code>/jam</code> / <code>/stopjam</code> — jam digital live di chat\n` +
      `┗ <code>/ttt</code> / <code>/stopttt</code> — Tic Tac Toe 2 pemain\n` +
      `┗ <code>/suit</code> / <code>/stopsuit</code> — Batu Gunting Kertas 2 pemain\n` +
      `┗ <code>/ai</code> — ngobrol sama AI (Gemini, ada memori percakapan)\n` +
      `┗ <code>/aireset</code> — reset memori obrolan /ai\n` +
      `┗ <code>/joke</code> — kirim jokes/meme receh\n` +
      `┗ <code>/ping</code> / <code>/stopping</code> — tes kecepatan respon bot`,

    `┏ 🛡️ <b>GRUP &amp; MODERASI</b> <i>(admin grup)</i>\n` +
      `┗ <code>/warnon</code> / <code>/warnoff</code> — nyalain/matiin sistem warning spam\n` +
      `┗ <code>/warns</code> — cek jumlah warning user (reply pesan)\n` +
      `┗ <code>/resetwarn</code> — reset warning user (reply pesan)\n` +
      `┗ <code>/mute</code> / <code>/unmute</code> — bungkam/lepas bungkam user (reply pesan)\n` +
      `┗ <code>/rules</code> / <code>/setrules</code> / <code>/resetrules</code> — atur aturan grup\n` +
      `┗ <code>/rulesnotifon</code> / <code>/rulesnotifoff</code> — notif rules member baru\n` +
      `┗ <code>/cekwelcome</code> / <code>/setwelcome</code> / <code>/setgoodbye</code> — pesan sambutan/perpisahan\n` +
      `┗ <code>/welcomeon</code> / <code>/welcomeoff</code> — nyalain/matiin welcome\n` +
      `┗ <code>/setmp3</code> / <code>/setnamamp3</code> — lagu tema yang diputer di /start\n` +
      `┗ <code>/setbanner</code> — banner gambar/GIF/video di /start\n` +
      `┗ <code>/stats</code> / <code>/statsreset</code> — statistik aktivitas grup\n` +
      `┗ <code>/antilinkon</code> / <code>/antilinkoff</code> — nyalain/matiin anti-link\n` +
      `┗ <code>/antilinkaksi</code> — atur tindakan (warn/mute/kick/delete)\n` +
      `┗ <code>/antilinkwl</code> — atur whitelist domain anti-link\n\n` +
      `┏ 🕌 <b>INFO</b>\n` +
      `┗ <code>/jadwalsholat</code> / <code>/setsholat</code> / <code>/stopsholat</code> — jadwal sholat\n` +
      `┗ <code>/translate</code> — terjemahin teks antar bahasa\n` +
      `┗ <code>/kurs</code> — kurs mata uang ke Rupiah\n` +
      `┗ <code>/btc</code> <code>/eth</code> <code>/crypto</code> <code>/market</code> — harga crypto real-time`,

    `┏ 🛠️ <b>ADMIN TOOLS</b> <i>(untuk semua admin grup)</i>\n` +
      `┗ <code>/tools</code> — panel tools cepat khusus admin grup\n` +
      `┗ <code>/serverinfo</code> — status &amp; resource server bot\n\n` +
      `┏ 👑 <b>PANEL BOT ADMIN</b> <i>(khusus ${ADMIN_IDS.length > 1 ? "kamu & admin bot lain" : "kamu"}, tidak muncul buat orang lain)</i>\n` +
      `┗ <code>/panel</code> — buka dashboard ini\n` +
      `┗ 📊 Statistik Global — rekap semua grup jadi satu\n` +
      `┗ 🗂 Daftar Grup — grup mana aja yang bot ini ikuti\n` +
      `┗ 📢 Broadcast ke Grup — kirim satu pesan ke semua grup\n` +
      `┗ ⚙️ Config Grup — cek pengaturan tiap grup tanpa buka dashboard web\n` +
      `┗ 👑 Admin Bot — daftar ID yang punya akses /panel\n` +
      `┗ 🔄 Restart Bot — restart proses bot dari jarak jauh\n` +
      `┗ <code>/testnotif</code> — tes notifikasi alert ke OWNER_CHAT_ID`,
  ];

  return (
    `📋 <b>𝗦𝗘𝗠𝗨𝗔 𝗙𝗜𝗧𝗨𝗥 𝗕𝗢𝗧</b>\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `📄 Halaman <b>${pageLabel}</b>\n\n` +
    `${bodies[page - 1]}\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `💡 Detail cara pakai tiap fitur ada di <code>/tools</code> &amp; <code>/start</code>.`
  );
}

function adminFeaturesKeyboard(page = 1) {
  const navRow = [];
  if (page > 1) navRow.push({ text: "⬅️ Sebelumnya", callback_data: `adminpanel:features:${page - 1}` });
  if (page < ADMIN_FEATURES_TOTAL_PAGES) navRow.push({ text: "➡️ Berikutnya", callback_data: `adminpanel:features:${page + 1}` });
  const rows = [];
  if (navRow.length) rows.push(navRow);
  rows.push([{ text: "⬅️ Kembali ke Panel", callback_data: "adminpanel:refresh" }]);
  return { inline_keyboard: rows };
}

// ================= CEK CONFIG GRUP (dalam /panel) =================
// Nunjukkin rekap pengaturan tiap grup (welcome, rules, warning, anti-spam,
// blacklist, jadwal sholat) langsung dari chat pribadi admin, tanpa perlu
// buka dashboard web. Data diambil dari file config yang sama persis dipakai
// dashboard.js, jadi selalu sinkron.
async function buildGroupConfigPickerKeyboard() {
  const chatIds = Object.keys(statsData);
  if (!chatIds.length) return null;

  const sorted = chatIds
    .map((id) => ({ id, total: (statsData[id] && statsData[id].totalMessages) || 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10); // dibatasin 10 grup teraktif biar tombol tidak kepanjangan

  const titleLookups = await Promise.allSettled(sorted.map((g) => bot.getChat(g.id)));

  const buttons = sorted.map((g, i) => {
    const res = titleLookups[i];
    const rawTitle = res.status === "fulfilled" && res.value && res.value.title ? res.value.title : `Chat ${g.id}`;
    const title = rawTitle.length > 28 ? rawTitle.slice(0, 27) + "…" : rawTitle;
    return [{ text: `⚙️ ${title}`, callback_data: `adminpanel:groupconfig:${g.id}` }];
  });

  buttons.push([{ text: "⬅️ Kembali ke Panel", callback_data: "adminpanel:refresh" }]);
  return { inline_keyboard: buttons, extra: chatIds.length > sorted.length ? chatIds.length - sorted.length : 0 };
}

function buildGroupConfigDetailText(chatId, chatTitle) {
  const welcome = getWelcomeConfig(chatId);
  const rules = getRulesConfig(chatId);
  const warnOn = isWarnEnabled(chatId);
  const antiSpam = getAntiSpamConfig(chatId);
  const blacklist = getBlacklistConfig(chatId);
  const antiLink = getAntiLinkConfig(chatId);
  const sholat = sholatSettings[String(chatId)];

  const onOff = (b) => (b ? "🟢 ON" : "🔴 OFF");

  return (
    `⚙️ <b>Config Grup</b>\n` +
    `${chatTitle ? escapeHtml(chatTitle) + "\n" : ""}` +
    `<code>ID: ${chatId}</code>\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `▸ Welcome/Goodbye : ${onOff(welcome.enabled)}\n` +
    `▸ Notif Rules otomatis : ${onOff(rules.autoSend)}\n` +
    `▸ Warning/Anti-spam : ${onOff(warnOn)}\n` +
    `▸ Batas anti-spam : <b>${antiSpam.maxMessages}</b> pesan / <b>${antiSpam.perSeconds}</b>s → aksi <b>${antiSpam.action}</b>\n` +
    `▸ Blacklist kata : ${onOff(blacklist.enabled)}${blacklist.enabled ? ` (${blacklist.words.length} kata, aksi ${blacklist.action})` : ""}\n` +
    `▸ Anti-Link : ${onOff(antiLink.enabled)}${antiLink.enabled ? ` (aksi ${antiLink.action}, ${antiLink.whitelist.length} domain di-whitelist)` : ""}\n` +
    `▸ Jadwal sholat otomatis : ${sholat && sholat.autoPost ? `🟢 ON (${escapeHtml(sholat.kota)})` : "🔴 OFF"}\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `💡 Buat ubah pengaturan ini, pakai command di grup terkait atau lewat dashboard web.`
  );
}

// ================= DAFTAR ADMIN BOT (dalam /panel) =================
async function buildAdminListText() {
  const lookups = await Promise.allSettled(ADMIN_IDS.map((id) => bot.getChat(id)));
  const lines = ADMIN_IDS.map((id, i) => {
    const res = lookups[i];
    let name = `ID ${id}`;
    if (res.status === "fulfilled" && res.value) {
      const c = res.value;
      name = c.username ? `@${c.username}` : [c.first_name, c.last_name].filter(Boolean).join(" ") || name;
    }
    const isOwner = OWNER_CHAT_ID && String(OWNER_CHAT_ID) === String(id);
    return `${i + 1}. ${escapeHtml(name)} ${isOwner ? "👑 (owner)" : ""}\n    └ ID: <code>${id}</code>`;
  });

  return (
    `👑 <b>Admin Bot</b> (${ADMIN_IDS.length} orang punya akses <code>/panel</code>)\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `${lines.join("\n")}\n\n` +
    `💡 Tambah/hapus admin lewat <code>ADMIN_IDS</code> di file <code>.env</code>, lalu restart bot.`
  );
}

async function sendAdminPanel(chatId) {
  await bot.sendMessage(chatId, adminPanelText(), {
    parse_mode: "HTML",
    reply_markup: adminPanelKeyboard(),
  });
}

bot.onText(/^\/panel$/, async (msg) => {
  if (!isBotAdmin(msg.from.id)) {
    notifyOwnerUnauthorizedPanel(msg.from, msg.chat);
    return bot.sendMessage(msg.chat.id, "⛔ Panel admin cuma bisa dipakai admin bot.", { parse_mode: "HTML" });
  }
  pendingBroadcast.delete(String(msg.from.id)); // reset state broadcast lama kalau ada
  await sendAdminPanel(msg.chat.id);
});

bot.onText(/^\/cancelbroadcast$/, async (msg) => {
  if (!isBotAdmin(msg.from.id)) return;
  if (pendingBroadcast.delete(String(msg.from.id))) {
    await bot.sendMessage(msg.chat.id, "✅ Broadcast dibatalkan.");
  }
});

async function buildGroupsListText() {
  const chatIds = Object.keys(statsData);
  if (!chatIds.length) {
    return "🗂 <b>Daftar Grup</b>\n\nBelum ada data grup yang terpantau.";
  }

  // Urutkan dari paling aktif (total pesan terbanyak), tampilkan maksimal 20
  // biar pesan tidak kepanjangan / kena limit Telegram.
  const sorted = chatIds
    .map((id) => ({ id, total: (statsData[id] && statsData[id].totalMessages) || 0 }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 20);

  const titleLookups = await Promise.allSettled(
    sorted.map((g) => bot.getChat(g.id))
  );

  const lines = sorted.map((g, i) => {
    const res = titleLookups[i];
    const title =
      res.status === "fulfilled" && res.value && res.value.title
        ? res.value.title
        : `Chat ${g.id}`;
    return `${i + 1}. <b>${escapeHtml(title)}</b>\n    └ ID: <code>${g.id}</code> · ${g.total} pesan`;
  });

  const extra = chatIds.length > sorted.length ? `\n\n<i>+${chatIds.length - sorted.length} grup lainnya (tidak ditampilkan, diurutkan dari paling aktif)</i>` : "";

  return `🗂 <b>Daftar Grup</b> (${chatIds.length} total)\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n${lines.join("\n")}${extra}`;
}

bot.on("callback_query", async (query) => {
  const data = query.data || "";
  if (!data.startsWith("adminpanel:")) return; // bukan buat handler ini, biarin handler lain yang proses

  if (!isBotAdmin(query.from.id)) {
    return bot.answerCallbackQuery(query.id, {
      text: "⛔ Kamu bukan admin bot.",
      show_alert: true,
    });
  }

  const parts = data.split(":");
  const action = parts[1];
  const extra = parts[2]; // dipakai buat "features:<page>" & "groupconfig:<chatId>"
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;

  try {
    if (action === "refresh") {
      await bot.editMessageText(adminPanelText(), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: adminPanelKeyboard(),
      });
      return bot.answerCallbackQuery(query.id, { text: "🔄 Diperbarui." });
    }

    if (action === "close") {
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      return bot.answerCallbackQuery(query.id);
    }

    if (action === "stats") {
      const g = getGlobalSummary();
      const text =
        `📊 <b>Statistik Global</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
        `▸ Total grup terpantau : <b>${g.totalGroups}</b>\n` +
        `▸ Pesan hari ini : <b>${g.totalMsgToday}</b>\n` +
        `▸ Pesan sepanjang waktu : <b>${g.totalMsgAll}</b>\n` +
        `▸ Total member masuk : <b>${g.totalJoined}</b>\n` +
        `▸ Total member keluar : <b>${g.totalLeft}</b>`;
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "adminpanel:refresh" }]] },
      });
      return bot.answerCallbackQuery(query.id);
    }

    if (action === "groups") {
      await bot.answerCallbackQuery(query.id, { text: "⏳ Mengambil daftar grup..." });
      const text = await buildGroupsListText();
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "adminpanel:refresh" }]] },
      });
      return;
    }

    if (action === "serverinfo") {
      await bot.deleteMessage(chatId, messageId).catch(() => {});
      await bot.answerCallbackQuery(query.id);
      return ctx.actions.sendServerInfo(chatId);
    }

    if (action === "broadcast") {
      pendingBroadcast.set(String(query.from.id), true);
      await bot.editMessageText(
        `📢 <b>Broadcast ke Semua Grup</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
          `Ketik & kirim pesan yang mau dibroadcast (chat pribadi ke bot ini).\n` +
          `Pesan akan dikirim persis seperti yang kamu ketik ke <b>semua grup</b> yang bot ini ikuti.\n\n` +
          `Ketik /cancelbroadcast buat batal.`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "❌ Batal", callback_data: "adminpanel:cancelbroadcast" }]] },
        }
      );
      return bot.answerCallbackQuery(query.id);
    }

    if (action === "cancelbroadcast") {
      pendingBroadcast.delete(String(query.from.id));
      await bot.editMessageText(adminPanelText(), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: adminPanelKeyboard(),
      });
      return bot.answerCallbackQuery(query.id, { text: "Dibatalkan." });
    }

    if (action === "features") {
      const page = Math.min(Math.max(parseInt(extra, 10) || 1, 1), ADMIN_FEATURES_TOTAL_PAGES);
      await bot.editMessageText(adminFeaturesText(page), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: adminFeaturesKeyboard(page),
      });
      return bot.answerCallbackQuery(query.id);
    }

    if (action === "groupconfig" && !extra) {
      await bot.answerCallbackQuery(query.id, { text: "⏳ Mengambil daftar grup..." });
      const picker = await buildGroupConfigPickerKeyboard();
      if (!picker) {
        await bot.editMessageText("⚙️ <b>Config Grup</b>\n\nBelum ada data grup yang terpantau.", {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali ke Panel", callback_data: "adminpanel:refresh" }]] },
        });
        return;
      }
      const extraNote = picker.extra ? `\n\n<i>+${picker.extra} grup lainnya (tidak ditampilkan, diurutkan dari paling aktif)</i>` : "";
      await bot.editMessageText(
        `⚙️ <b>Config Grup</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\nPilih grup buat lihat rekap pengaturannya:${extraNote}`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: picker.inline_keyboard },
        }
      );
      return;
    }

    if (action === "groupconfig" && extra) {
      await bot.answerCallbackQuery(query.id, { text: "⏳ Mengambil config grup..." });
      let title = null;
      try {
        const chat = await bot.getChat(extra);
        title = chat && chat.title;
      } catch (_) {}
      await bot.editMessageText(buildGroupConfigDetailText(extra, title), {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "⬅️ Pilih Grup Lain", callback_data: "adminpanel:groupconfig" }],
            [{ text: "⬅️ Kembali ke Panel", callback_data: "adminpanel:refresh" }],
          ],
        },
      });
      return;
    }

    if (action === "admins") {
      await bot.answerCallbackQuery(query.id, { text: "⏳ Mengambil daftar admin..." });
      const text = await buildAdminListText();
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "adminpanel:refresh" }]] },
      });
      return;
    }

    if (action === "restart") {
      await bot.editMessageText(
        `🔄 <b>Restart Bot</b>\n┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
          `Bot bakal langsung mati & kenyalain ulang (proses direstart lewat PM2/panel hosting).\n` +
          `Semua game/timer yang lagi jalan (jam, ttt, suit, dll) bakal ke-reset.\n\n` +
          `Yakin mau lanjut?`,
        {
          chat_id: chatId,
          message_id: messageId,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Ya, restart sekarang", callback_data: "adminpanel:restartconfirm" },
                { text: "❌ Batal", callback_data: "adminpanel:refresh" },
              ],
            ],
          },
        }
      );
      return bot.answerCallbackQuery(query.id);
    }

    if (action === "restartconfirm") {
      await bot.answerCallbackQuery(query.id, { text: "🔄 Merestart bot..." });
      await bot.editMessageText(
        `🔄 Bot sedang direstart oleh admin, tunggu beberapa detik lalu ketik <code>/start</code> lagi...`,
        { chat_id: chatId, message_id: messageId, parse_mode: "HTML" }
      );
      console.log(`🔄 Restart diminta oleh admin ${query.from.id} lewat /panel.`);
      setTimeout(() => process.exit(0), 800); // kasih waktu editMessageText kekirim dulu; PM2/panel hosting otomatis nyalain ulang
      return;
    }
  } catch (e) {
    console.error("⚠️ Error di panel admin (callback_query):", e.message);
    try {
      await bot.answerCallbackQuery(query.id, { text: "⚠️ Terjadi error, coba lagi.", show_alert: true });
    } catch (_) {}
  }
});

// Nangkep pesan lanjutan admin yang lagi mode "broadcast" (habis pencet
// tombol 📢 Broadcast). Sengaja pakai listener "message" terpisah biar tidak
// perlu utak-atik handler pesan lain yang sudah ada di file ini.
bot.on("message", async (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return; // command biasa dilewatin, biar tidak ke-broadcast tidak sengaja
  if (msg.chat.type !== "private") return; // broadcast cuma dipicu dari chat pribadi admin
  const userKey = String(msg.from.id);
  if (!pendingBroadcast.has(userKey)) return;
  if (!isBotAdmin(msg.from.id)) {
    pendingBroadcast.delete(userKey);
    return;
  }

  pendingBroadcast.delete(userKey); // langsung dihapus duluan biar tidak double-trigger kalau proses lambat

  const chatIds = Object.keys(statsData);
  if (!chatIds.length) {
    return bot.sendMessage(msg.chat.id, "⚠️ Belum ada grup yang terpantau, broadcast dibatalkan.");
  }

  const statusMsg = await bot.sendMessage(
    msg.chat.id,
    `⏳ Mengirim broadcast ke ${chatIds.length} grup...`
  );

  let success = 0;
  let failed = 0;
  for (const gid of chatIds) {
    try {
      await bot.sendMessage(gid, msg.text);
      success += 1;
    } catch (e) {
      failed += 1;
    }
    // Jeda kecil antar kirim biar tidak kena rate-limit Telegram (max ~30
    // pesan/detik lintas chat berbeda, kita main aman jauh di bawah itu).
    await new Promise((r) => setTimeout(r, 200));
  }

  await bot.editMessageText(
    `✅ Broadcast selesai.\n▸ Berhasil: <b>${success}</b>\n▸ Gagal: <b>${failed}</b>`,
    { chat_id: msg.chat.id, message_id: statusMsg.message_id, parse_mode: "HTML" }
  );
});

// ================= BOT TOOLS (menu utility terpisah) =================
function toolsText() {
  return (
    `<code>[root@bot-tools]#</code>\n` +
    `🛠️ <b>𝗕𝗢𝗧 𝗧𝗢𝗢𝗟𝗦</b>\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `${botStatusLine()}\n\n` +
    `Kumpulan fitur utility bot — tinggal tap tombolnya 👇\n\n` +
    `┏ 🔇 <b>Moderasi</b>\n` +
    `┗ <b>Mute</b> — reply pesan user, ketik <code>/mute</code> (permanen) atau <code>/mute 60</code> (60 menit)\n` +
    `┗ <b>Unmute</b> — reply pesan user, ketik <code>/unmute</code>\n\n` +
    `┏ 👋 <b>Welcome &amp; Rules</b>\n` +
    `┗ <b>Welcome</b> — <code>/setwelcome teks</code>, <code>/setgoodbye teks</code>, <code>/welcomeon</code>/<code>/welcomeoff</code>\n` +
    `┗ <b>Rules</b> — <code>/setrules teks</code>, <code>/resetrules</code>, <code>/rulesnotifon</code>/<code>/rulesnotifoff</code>\n\n` +
    `┏ 🕌 <b>Jadwal Sholat</b>\n` +
    `┗ <code>/setsholat kota</code> buat set auto-post harian, <code>/stopsholat</code> buat matiin\n\n` +
    `┏ 🔗 <b>Anti-Link</b>\n` +
    `┗ Hapus otomatis pesan berisi link dari member biasa (admin bebas)\n` +
    `┗ <code>/antilinkaksi warn|mute|kick|delete</code> — atur tindakan tambahan\n` +
    `┗ <code>/antilinkwl domain.com</code> — izinkan domain tertentu (whitelist)\n\n` +
    `┏ 🎨 <b>Kustomisasi Tampilan</b>\n` +
    `┗ <b>Ganti Audio Menu</b> — kirim/reply mp3 dengan <code>/setmp3</code>\n` +
    `┗ <b>Ganti Nama Audio</b> — ketik <code>/setnamamp3 Nama Barunya</code>\n` +
    `┗ <b>Ganti Banner Menu</b> — kirim/reply gif, mp4, atau jpg/png dengan <code>/setbanner</code>\n\n` +
    `┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n` +
    `<i>*Mute/unmute, set-welcome/rules/sholat, setmp3, setnamamp3, dan setbanner khusus admin, dan tidak lewat tombol karena butuh reply/kirim file media atau teks bebas.\n` +
    `*Semua tombol ⚙️ ON/OFF di bawah khusus admin grup — tinggal tap buat nyalain/matiin fitur.</i>`
  );
}

function toolsKeyboard(chatId) {
  const warnStatus = isWarnEnabled(chatId) ? "🟢 ON" : "🔴 OFF";
  const rulesStatus = getRulesConfig(chatId).autoSend ? "🟢 ON" : "🔴 OFF";
  const welcomeStatus = getWelcomeConfig(chatId).enabled ? "🟢 ON" : "🔴 OFF";
  const blacklistStatus = getBlacklistConfig(chatId).enabled ? "🟢 ON" : "🔴 OFF";
  const antiLinkStatus = getAntiLinkConfig(chatId).enabled ? "🟢 ON" : "🔴 OFF";
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✦ 🔎 CEK CEPAT ✦", callback_data: "noop" }],
        [
          { text: "🏓 Ping", callback_data: "run_ping" },
          { text: "🖥️ Server Info", callback_data: "run_serverinfo" },
        ],
        [
          { text: "📊 Stats Grup", callback_data: "run_stats" },
          { text: "⚠️ Cek Warn", callback_data: "help_spam" },
        ],
        [{ text: "✦ 👋 WELCOME & RULES ✦", callback_data: "noop" }],
        [
          { text: "👋 Cara Atur Welcome", callback_data: "help_welcome" },
          { text: "📜 Lihat Rules", callback_data: "run_rules" },
        ],
        [{ text: "✦ 🕌 JADWAL SHOLAT ✦", callback_data: "noop" }],
        [{ text: "🕌 Cara Atur Sholat", callback_data: "help_sholat" }],
        [{ text: "✦ 🔗 ANTI-LINK ✦", callback_data: "noop" }],
        [{ text: "🔗 Cara Atur Anti-Link", callback_data: "help_antilink" }],
        [{ text: "✦ 🎨 KUSTOMISASI ✦", callback_data: "noop" }],
        [
          { text: "🎧 Cara Ganti Audio", callback_data: "help_setmp3" },
          { text: "🖼️ Cara Ganti Banner", callback_data: "help_setbanner" },
        ],
        [{ text: "🏷️ Cara Ganti Nama Audio", callback_data: "help_setnamamp3" }],
        [{ text: "✦ ⚙️ SEMUA FITUR ON/OFF ✦", callback_data: "noop" }],
        [{ text: `🔔 Warning Spam: ${warnStatus}`, callback_data: "toggle_warn" }],
        [{ text: `📜 Notif Rules: ${rulesStatus}`, callback_data: "toggle_rules" }],
        [{ text: `👋 Welcome/Goodbye: ${welcomeStatus}`, callback_data: "toggle_welcome" }],
        [{ text: `🚫 Blacklist Kata: ${blacklistStatus}`, callback_data: "toggle_blacklist" }],
        [{ text: `🔗 Anti-Link: ${antiLinkStatus}`, callback_data: "toggle_antilink" }],
        [
          { text: "🏠 Menu Utama", callback_data: "back_to_menu" },
          { text: "🔄 Refresh", callback_data: "refresh_tools" },
        ],
      ],
    },
  };
}

bot.onText(/^\/tools$/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(msg.from.id)) {
    notifyOwnerUnauthorizedTools(msg.from, msg.chat);
    return bot.sendMessage(chatId, "⛔ Menu Bot Tools cuma bisa dipakai owner bot.", { parse_mode: "HTML" });
  }
  bot.sendMessage(chatId, toolsText(), {
    parse_mode: "HTML",
    ...toolsKeyboard(chatId),
  });
});

bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data === "run_serverinfo") {
    await bot.answerCallbackQuery(query.id, { text: "Mengambil info server..." });
    return ctx.actions.sendServerInfo(chatId);
  }

  if (data === "run_stats") {
    await bot.answerCallbackQuery(query.id, { text: "Mengambil statistik..." });
    return sendStats(chatId, query.message.chat.type);
  }

  if (data === "toggle_warn") {
    const chatType = query.message.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") {
      return bot.answerCallbackQuery(query.id, {
        text: "Fitur ini hanya berlaku di grup.",
        show_alert: true,
      });
    }
    const admin = await isGroupAdmin(chatId, query.from.id);
    if (!admin) {
      return bot.answerCallbackQuery(query.id, {
        text: "⚠️ Hanya admin grup yang bisa ubah pengaturan ini.",
        show_alert: true,
      });
    }
    const newState = !isWarnEnabled(chatId);
    warnSettings[String(chatId)] = newState;
    saveWarnSettings();
    await bot.answerCallbackQuery(query.id, {
      text: newState ? "✅ Warning spam diaktifkan" : "🔕 Warning spam dimatikan",
    });
    try {
      return await bot.editMessageText(toolsText(), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...toolsKeyboard(chatId),
      });
    } catch (e) {
      return;
    }
  }

  if (data === "toggle_rules") {
    const chatType = query.message.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") {
      return bot.answerCallbackQuery(query.id, {
        text: "Fitur ini hanya berlaku di grup.",
        show_alert: true,
      });
    }
    const admin = await isGroupAdmin(chatId, query.from.id);
    if (!admin) {
      return bot.answerCallbackQuery(query.id, {
        text: "⚠️ Hanya admin grup yang bisa ubah pengaturan ini.",
        show_alert: true,
      });
    }
    const config = getRulesConfig(chatId);
    config.autoSend = !config.autoSend;
    saveRulesSettings();
    await bot.answerCallbackQuery(query.id, {
      text: config.autoSend ? "✅ Notif rules diaktifkan" : "🔕 Notif rules dimatikan",
    });
    try {
      return await bot.editMessageText(toolsText(), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...toolsKeyboard(chatId),
      });
    } catch (e) {
      return;
    }
  }

  if (data === "toggle_welcome") {
    const chatType = query.message.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") {
      return bot.answerCallbackQuery(query.id, { text: "Fitur ini hanya berlaku di grup.", show_alert: true });
    }
    const admin = await isGroupAdmin(chatId, query.from.id);
    if (!admin) {
      return bot.answerCallbackQuery(query.id, { text: "⚠️ Hanya admin grup yang bisa ubah pengaturan ini.", show_alert: true });
    }
    const config = getWelcomeConfig(chatId);
    config.enabled = !config.enabled;
    saveWelcomeSettings();
    await bot.answerCallbackQuery(query.id, {
      text: config.enabled ? "✅ Welcome/goodbye diaktifkan" : "🔕 Welcome/goodbye dimatikan",
    });
    try {
      return await bot.editMessageText(toolsText(), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...toolsKeyboard(chatId),
      });
    } catch (e) {
      return;
    }
  }

  if (data === "toggle_blacklist") {
    const chatType = query.message.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") {
      return bot.answerCallbackQuery(query.id, { text: "Fitur ini hanya berlaku di grup.", show_alert: true });
    }
    const admin = await isGroupAdmin(chatId, query.from.id);
    if (!admin) {
      return bot.answerCallbackQuery(query.id, { text: "⚠️ Hanya admin grup yang bisa ubah pengaturan ini.", show_alert: true });
    }
    const cfg = getBlacklistConfig(chatId);
    blacklistSettings[String(chatId)] = { ...cfg, enabled: !cfg.enabled };
    saveBlacklistSettings();
    await bot.answerCallbackQuery(query.id, {
      text: !cfg.enabled ? "✅ Blacklist kata diaktifkan" : "🔕 Blacklist kata dimatikan",
    });
    try {
      return await bot.editMessageText(toolsText(), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...toolsKeyboard(chatId),
      });
    } catch (e) {
      return;
    }
  }

  if (data === "toggle_antilink") {
    const chatType = query.message.chat.type;
    if (chatType !== "group" && chatType !== "supergroup") {
      return bot.answerCallbackQuery(query.id, { text: "Fitur ini hanya berlaku di grup.", show_alert: true });
    }
    const admin = await isGroupAdmin(chatId, query.from.id);
    if (!admin) {
      return bot.answerCallbackQuery(query.id, { text: "⚠️ Hanya admin grup yang bisa ubah pengaturan ini.", show_alert: true });
    }
    const cfg = getAntiLinkConfig(chatId);
    setAntiLinkConfig(chatId, { enabled: !cfg.enabled });
    await bot.answerCallbackQuery(query.id, {
      text: !cfg.enabled ? "✅ Anti-link diaktifkan" : "🔕 Anti-link dimatikan",
    });
    try {
      return await bot.editMessageText(toolsText(), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...toolsKeyboard(chatId),
      });
    } catch (e) {
      return;
    }
  }

  if (data === "help_antilink") {
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(
      chatId,
      `🔗 Nyalain lewat tombol <b>🔗 Anti-Link</b> di atas atau ketik <code>/antilinkon</code> / <code>/antilinkoff</code> (khusus admin). Pesan berisi link dari member biasa otomatis dihapus; admin grup tidak difilter. Atur tindakan tambahan dengan <code>/antilinkaksi warn|mute|kick|delete</code>, dan izinkan domain tertentu dengan <code>/antilinkwl domain.com</code> (cek daftar: <code>/antilinkwl</code>).`,
      { parse_mode: "HTML" }
    );
  }

  if (data === "back_to_menu") {
    await bot.answerCallbackQuery(query.id, { text: "Membuka menu utama..." });
    return sendMainMenu(chatId);
  }

  if (data === "refresh_tools") {
    if (!isOwner(query.from.id)) {
      notifyOwnerUnauthorizedTools(query.from, query.message.chat);
      return bot.answerCallbackQuery(query.id, {
        text: "⛔ Menu Bot Tools cuma bisa dipakai owner bot.",
        show_alert: true,
      });
    }
    await bot.answerCallbackQuery(query.id, { text: "Tools diperbarui" });
    try {
      return await bot.editMessageText(toolsText(), {
        chat_id: chatId,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        ...toolsKeyboard(chatId),
      });
    } catch (e) {
      return; // isi/tombol sama persis, Telegram nolak edit — aman diabaikan
    }
  }
});



// ================= HANDLE TOMBOL INLINE =================
bot.on("callback_query", async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Callback game Tic Tac Toe & Suit ditangani oleh handler terpisah di bawah
  if (data && (data.startsWith("ttt_") || data.startsWith("suit_"))) return;

  const helpTexts = {
    help_image: "🖼️ Ketik: <code>/image kucing lucu</code>",
    help_gif: "🎞️ Ketik: <code>/gif kucing lucu</code>",
    help_pinterest: "📌 Ketik: <code>/pinterest anime</code> — bot akan kirim beberapa gambar sekaligus dalam bentuk album",
    help_video: "🎬 Ketik: <code>/video tutorial nodejs</code>",
    help_anime: "🎌 Ketik: <code>/anime naruto</code> — bot kirim poster, sinopsis, info, dan link trailer resminya dari MyAnimeList.",
    help_episodes:
      "📚 Ketik: <code>/episodes naruto 1-3</code> — bot kirim daftar judul & tanggal tayang episode 1 sampai 3, plus link untuk nonton resmi (Crunchyroll/Netflix/Muse Indonesia). Bagian angkanya opsional, default 1-3. Bot ini tidak mengirim file video episode karena itu konten berhak cipta.",
    help_music: "🎵 Ketik: <code>/music lofi hip hop</code> — bot akan kirim file MP3-nya",
    help_tiktok: "📱 Kirim link TikTok apa saja di chat (tanpa command), bot otomatis download videonya tanpa watermark. Atau bisa juga: <code>/tiktok https://vt.tiktok.com/xxxx</code>",
    help_togif: `🎞️ Reply video/animasi dengan <code>/togif</code>, atau kirim video dengan caption <code>/togif</code>. Bot ubah jadi GIF tanpa suara, auto-loop (maks ${ctx.config.MAX_TOGIF_DURATION_SECONDS}s). Opsional atur kualitas: <code>/togif 15 480</code> (fps, lebar).`,
    help_tovideo: `🎬 Sama seperti /togif, tapi hasilnya TETAP ADA SUARA dan dikirim sebagai video biasa (tap-to-play, bukan auto-loop). Reply video/animasi dengan <code>/tovideo</code>, atau kirim video dengan caption <code>/tovideo</code>. Maks ${ctx.config.MAX_TOGIF_DURATION_SECONDS}s. Opsional atur kualitas: <code>/tovideo 15 480</code> (fps, lebar).`,
    help_ai: "🤖 Ketik: <code>/ai apa itu javascript</code> — dijawab langsung oleh Google Gemini (gratis).",
    help_ttt: "🎮 Ketik: <code>/ttt</code> untuk mulai game Tic Tac Toe 2 pemain. Pemain kedua tinggal klik tombol \"Gabung Main\".",
    help_suit: "✊✋✌️ Ketik: <code>/suit</code> untuk mulai Batu Gunting Kertas 2 pemain. Pemain kedua klik \"Gabung Main\", lalu masing-masing pilih secara rahasia.",
    help_stats: "📊 Ketik: <code>/stats</code> untuk melihat statistik aktivitas grup ini (total pesan, jam ramai, top member, dll).",
    help_spam: "⚠️ Ketik: <code>/warns</code> (reply pesan user) untuk cek jumlah warning, atau <code>/resetwarn</code> untuk reset (khusus admin).",
    help_kurs: "💱 Ketik: <code>/kurs usd</code>, <code>/kurs euro</code>, <code>/kurs yen</code> — cek kurs mata uang ke Rupiah secara real-time.",
    help_crypto: "🪙 Ketik: <code>/btc</code> atau <code>/eth</code> buat cek cepat, atau <code>/crypto sol</code> untuk koin lain (BTC, ETH, BNB, SOL, DOGE, XRP, ADA, LTC, USDT, MATIC). Ketik <code>/market</code> untuk lihat ringkasan top 5 sekaligus.",
    help_welcome:
      "👋 Ketik <code>/cekwelcome</code> buat lihat setting welcome/goodbye saat ini. Admin bisa ubah lewat <code>/setwelcome teks</code> dan <code>/setgoodbye teks</code> (placeholder: <code>{name} {group} {count}</code>), atau nyalain/matiin lewat <code>/welcomeon</code> / <code>/welcomeoff</code>.",
    help_sholat:
      "🕌 Ketik: <code>/jadwalsholat jakarta</code> untuk cek jadwal sholat kota tersebut sekali aja. Admin grup bisa set kota tetap pakai <code>/setsholat jakarta</code> supaya bot auto-post jadwal tiap hari jam 00:05 WIB, dan <code>/stopsholat</code> buat matiin auto-post-nya.",
    help_translate:
      "🌐 Ketik <code>/translate en Halo, apa kabar?</code>, atau reply pesan teks lalu ketik <code>/translate en</code>. Bisa pakai kode bahasa (en, id, ja, ko, ar, zh-CN, dll) atau nama biasa seperti <code>/translate inggris</code>.",
    help_setmp3:
      "🎧 Kirim file mp3/audio dengan caption <code>/setmp3</code>, atau reply pesan yang berisi mp3 sambil ketik <code>/setmp3</code>. Lagu ini akan otomatis terkirim setiap ada yang buka <code>/start</code>. (Khusus admin di grup)",
    help_setbanner:
      "🖼️ Kirim gambar/GIF/video dengan caption <code>/setbanner</code>, atau reply pesan yang berisi gambar/GIF sambil ketik <code>/setbanner</code>. Mendukung GIF, MP4, JPG, maupun PNG — banner lama otomatis diganti. (Khusus admin di grup)",
    help_setnamamp3:
      "🏷️ Ketik: <code>/setnamamp3 Nama Barunya</code> — ganti judul lagu tema yang tampil di Telegram saat lagu dikirim bareng <code>/start</code> (default: \"Lagu Tema Bot\"). (Khusus admin di grup)",
  };

  // Header section di keyboard hanya dekorasi, tidak melakukan apa-apa
  if (data === "noop") {
    return bot.answerCallbackQuery(query.id);
  }

  if (helpTexts[data]) {
    await bot.answerCallbackQuery(query.id);
    return bot.sendMessage(chatId, helpTexts[data], { parse_mode: "HTML" });
  }

  if (data === "run_jam") {
    await bot.answerCallbackQuery(query.id, { text: "Menjalankan jam realtime..." });
    return ctx.actions.startClock(chatId);
  }

  if (data === "run_ping") {
    await bot.answerCallbackQuery(query.id, { text: "Mengecek ping..." });
    return ctx.actions.sendPing(chatId);
  }

  if (data === "run_tools") {
    if (!isOwner(query.from.id)) {
      notifyOwnerUnauthorizedTools(query.from, query.message.chat);
      return bot.answerCallbackQuery(query.id, {
        text: "⛔ Menu Bot Tools cuma bisa dipakai owner bot.",
        show_alert: true,
      });
    }
    await bot.answerCallbackQuery(query.id, { text: "Membuka Bot Tools..." });
    return bot.sendMessage(chatId, toolsText(), { parse_mode: "HTML", ...toolsKeyboard(chatId) });
  }

  if (data === "run_market") {
    await bot.answerCallbackQuery(query.id, { text: "Mengambil data top crypto..." });
    return ctx.actions.sendTopCryptoMarket(chatId);
  }

  if (data === "run_joke") {
    await bot.answerCallbackQuery(query.id, { text: "Ambil jokes random..." });
    return bot.sendMessage(chatId, `😹 <b>JOKE RANDOM</b>\n\n${ctx.actions.getRandomJoke(chatId)}`, {
      parse_mode: "HTML",
    });
  }

  if (data === "run_rules") {
    await bot.answerCallbackQuery(query.id, { text: "Mengambil rules grup..." });
    const config = getRulesConfig(chatId);
    return bot.sendMessage(chatId, config.rules, { parse_mode: "HTML" });
  }

  // Dipakai bareng oleh tombol geser halaman (menu_page_x) dan refresh (refresh_menu_x).
  // PENTING: cek pakai keberadaan properti `caption`, BUKAN nebak tipe medianya
  // (photo/animation/document/dll). Sebabnya: banner GIF yang diupload lewat
  // sendAnimation kadang malah kesimpan di sisi Telegram sebagai "document"
  // (bukan "animation") kalau content-type upload-nya tidak persis dikenali --
  // jadi query.message.animation bisa saja kosong walau pesannya tetap media
  // dengan caption. Kalau pesan itu punya caption, WAJIB pakai editMessageCaption;
  // pakai editMessageText di pesan media akan selalu gagal dengan error
  // "there is no text in the message to edit".
  async function editMenuMessage(page) {
    const hasCaption = typeof query.message.caption === "string";
    if (hasCaption) {
      return callTelegramWithRetry(
        () =>
          bot.editMessageCaption(menuText(page), {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: "HTML",
            ...mainMenuKeyboard(chatId, page),
          }),
        { maxRetries: 1, label: "menu.page.caption" }
      );
    }
    return callTelegramWithRetry(
      () =>
        bot.editMessageText(menuText(page), {
          chat_id: chatId,
          message_id: query.message.message_id,
          parse_mode: "HTML",
          ...mainMenuKeyboard(chatId, page),
        }),
      { maxRetries: 1, label: "menu.page.text" }
    );
  }

  if (data && data.startsWith("menu_page_")) {
    const page = parseInt(data.replace("menu_page_", ""), 10);
    if (!page || page < 1 || page > MENU_TOTAL_PAGES) return bot.answerCallbackQuery(query.id);
    await bot.answerCallbackQuery(query.id);
    try {
      return await editMenuMessage(page);
    } catch (e) {
      const tgDetail =
        (e && e.response && e.response.body && JSON.stringify(e.response.body)) || null;
      console.error(
        "⚠️ Gagal geser halaman menu:",
        e && e.message ? e.message : "(tidak ada pesan error)",
        tgDetail ? `| detail Telegram: ${tgDetail}` : ""
      );
      return;
    }
  }

  if (data && data.startsWith("refresh_menu_")) {
    const page = parseInt(data.replace("refresh_menu_", ""), 10);
    if (!page || page < 1 || page > MENU_TOTAL_PAGES) return bot.answerCallbackQuery(query.id);
    await bot.answerCallbackQuery(query.id, { text: "Menu diperbarui" });
    try {
      return await editMenuMessage(page);
    } catch (e) {
      const tgDetail =
        (e && e.response && e.response.body && JSON.stringify(e.response.body)) || null;
      console.error(
        "⚠️ Gagal refresh menu:",
        e && e.message ? e.message : "(tidak ada pesan error)",
        tgDetail ? `| detail Telegram: ${tgDetail}` : ""
      );
      return;
    }
  }

  if (data === "close_menu") {
    await bot.answerCallbackQuery(query.id, { text: "Menu ditutup" });
    try {
      return await bot.deleteMessage(chatId, query.message.message_id);
    } catch (e) {
      return;
    }
  }

  bot.answerCallbackQuery(query.id);
});

async function sendStats(chatId, chatType) {
  if (chatType !== "group" && chatType !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur statistik hanya berlaku di dalam grup.");
  }

  const stats = getChatStats(chatId);

  if (stats.totalMessages === 0) {
    return bot.sendMessage(
      chatId,
      "📊 Belum ada data statistik. Bot baru mulai mencatat aktivitas dari sekarang, coba lagi nanti."
    );
  }

  let memberCount = "-";
  try {
    memberCount = await bot.getChatMemberCount(chatId);
  } catch (e) {
    // abaikan kalau gagal ambil jumlah member
  }

  const topUsers = Object.values(stats.users)
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const busiestHour = stats.hourly.indexOf(Math.max(...stats.hourly));
  const todayKey = new Date().toISOString().slice(0, 10);
  const todayCount = stats.daily[todayKey] || 0;
  const medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"];

  let text = `📊 <b>STATISTIK GRUP</b>\n\n`;
  text += `👥 Jumlah member sekarang: <b>${memberCount}</b>\n`;
  text += `💬 Total pesan tercatat: <b>${stats.totalMessages}</b>\n`;
  text += `📅 Pesan hari ini: <b>${todayCount}</b>\n`;
  text += `🕒 Jam paling ramai: <b>${String(busiestHour).padStart(2, "0")}:00</b>\n`;
  text += `➕ Member masuk (tercatat): <b>${stats.joined}</b>\n`;
  text += `➖ Member keluar (tercatat): <b>${stats.left}</b>\n`;

  if (topUsers.length) {
    text += `\n🏆 <b>TOP MEMBER AKTIF</b>\n`;
    topUsers.forEach((u, i) => {
      text += `${medals[i] || i + 1 + "."} ${u.name} — ${u.count} pesan\n`;
    });
  }

  text += `\n<i>Dicatat sejak ${new Date(stats.startedAt).toLocaleDateString("id-ID")}</i>`;

  bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}

bot.onText(/^\/stats$/, async (msg) => {
  sendStats(msg.chat.id, msg.chat.type);
});

bot.onText(/^\/statsreset$/, async (msg) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }

  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa reset statistik.");
    }
  } catch (e) {
    console.error(e);
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  delete statsData[String(chatId)];
  statsDirty = true;
  saveStats();
  bot.sendMessage(chatId, "✅ Statistik grup ini sudah direset.");
});

// ================= MUTE / UNMUTE (khusus admin) =================
// Cara pakai: reply pesan user yang mau di-mute, lalu ketik /mute (opsional isi durasi menit).
// Contoh: /mute 60  -> mute 60 menit. Tanpa angka -> mute permanen sampai di-/unmute.
bot.onText(/^\/mute(?:\s+(\d+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }

  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa nge-mute member.");
    }
  } catch (e) {
    console.error(e);
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  if (!msg.reply_to_message) {
    return bot.sendMessage(chatId, "ℹ️ Reply pesan user yang ingin di-mute. Contoh: reply lalu ketik /mute atau /mute 60 (60 menit).");
  }

  const targetId = msg.reply_to_message.from.id;
  const targetName = msg.reply_to_message.from.first_name || msg.reply_to_message.from.username || "User";
  const mention = `<a href="tg://user?id=${targetId}">${targetName}</a>`;

  if (targetId === msg.from.id) {
    return bot.sendMessage(chatId, "🤔 Nggak bisa mute diri sendiri.");
  }

  try {
    const targetMember = await bot.getChatMember(chatId, targetId);
    if (["creator", "administrator"].includes(targetMember.status)) {
      return bot.sendMessage(chatId, "⚠️ Nggak bisa mute sesama admin/owner grup.");
    }
  } catch (e) {
    // lanjut aja kalau gagal cek, biar restrictChatMember di bawah yang nentuin
  }

  const durationMin = match[1] ? parseInt(match[1], 10) : null;

  try {
    const restrictOptions = {
      permissions: { can_send_messages: false },
    };
    if (durationMin) {
      restrictOptions.until_date = Math.floor(Date.now() / 1000) + durationMin * 60;
    }

    await bot.restrictChatMember(chatId, targetId, restrictOptions);

    const durasiText = durationMin ? `selama ${durationMin} menit` : "secara permanen (sampai di-/unmute)";
    bot.sendMessage(chatId, `🔇 ${mention} berhasil di-mute ${durasiText}.`, { parse_mode: "HTML" });
  } catch (e) {
    console.error("Gagal mute:", e.message);
    bot.sendMessage(
      chatId,
      "❌ Gagal mute user. Pastikan bot adalah admin grup dengan izin \"Restrict Members\"."
    );
  }
});

bot.onText(/^\/unmute$/, async (msg) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }

  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa nge-unmute member.");
    }
  } catch (e) {
    console.error(e);
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  if (!msg.reply_to_message) {
    return bot.sendMessage(chatId, "ℹ️ Reply pesan user yang ingin di-unmute, lalu ketik /unmute.");
  }

  const targetId = msg.reply_to_message.from.id;
  const targetName = msg.reply_to_message.from.first_name || msg.reply_to_message.from.username || "User";
  const mention = `<a href="tg://user?id=${targetId}">${targetName}</a>`;

  try {
    await bot.restrictChatMember(chatId, targetId, {
      permissions: {
        can_send_messages: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
      },
    });
    bot.sendMessage(chatId, `🔊 ${mention} berhasil di-unmute, sudah bisa chat lagi.`, { parse_mode: "HTML" });
  } catch (e) {
    console.error("Gagal unmute:", e.message);
    bot.sendMessage(
      chatId,
      "❌ Gagal unmute user. Pastikan bot adalah admin grup dengan izin \"Restrict Members\"."
    );
  }
});


bot.onText(/^\/warns$/, async (msg) => {
  const chatId = msg.chat.id;

  if (!msg.reply_to_message) {
    return bot.sendMessage(chatId, "ℹ️ Reply pesan user yang ingin dicek jumlah warning spam-nya.");
  }

  const targetId = msg.reply_to_message.from.id;
  const targetName = msg.reply_to_message.from.first_name || msg.reply_to_message.from.username || "User";
  const count = spamWarnings.get(spamKey(chatId, targetId)) || 0;

  bot.sendMessage(chatId, `⚠️ Warning spam ${targetName}: ${count}/${MAX_WARNING}`);
});

bot.onText(/^\/resetwarn$/, async (msg) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }

  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa reset warning.");
    }
  } catch (e) {
    console.error(e);
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  if (!msg.reply_to_message) {
    return bot.sendMessage(chatId, "ℹ️ Reply pesan user yang ingin direset warning-nya.");
  }

  const targetId = msg.reply_to_message.from.id;
  const key = spamKey(chatId, targetId);
  spamWarnings.set(key, 0);
  spamLog.set(key, []);

  bot.sendMessage(chatId, "✅ Warning spam user tersebut sudah direset.");
});

// ================= JADWAL SHOLAT (AUTO-POST) =================
// Pakai Aladhan API (gratis, tanpa API key), method 20 = Kemenag RI.
// Admin set kota grup sekali, bot auto-post jadwal tiap hari jam 00:05 WIB.
const sholatFile = path.join(__dirname, "sholat-settings.json");
let sholatSettings = {};
try {
  sholatSettings = JSON.parse(fs.readFileSync(sholatFile, "utf8"));
} catch (e) {
  sholatSettings = {};
}

function saveSholatSettings() {
  try {
    fs.writeFileSync(sholatFile, JSON.stringify(sholatSettings, null, 2));
  } catch (e) {
    console.error("⚠️ Gagal simpan sholat-settings.json:", e.message);
  }
}

async function getJadwalSholat(kota) {
  const url = `https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(
    kota
  )}&country=Indonesia&method=20`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  if (data.code !== 200 || !data.data || !data.data.timings) {
    throw new Error("Data jadwal sholat tidak ditemukan");
  }
  return data.data.timings;
}

function jadwalSholatText(kota, timings, tanggal) {
  return (
    `<b>🕌 JADWAL SHOLAT — ${kota.toUpperCase()}</b>\n` +
    `<i>${tanggal}</i>\n\n` +
    `🌅 Subuh: <b>${timings.Fajr}</b>\n` +
    `☀️ Dzuhur: <b>${timings.Dhuhr}</b>\n` +
    `🌤️ Ashar: <b>${timings.Asr}</b>\n` +
    `🌇 Maghrib: <b>${timings.Maghrib}</b>\n` +
    `🌃 Isya: <b>${timings.Isha}</b>`
  );
}

// Ambil tanggal & jam saat ini di zona waktu Jakarta (WIB), tidak bergantung timezone server.
function getJakartaParts() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const obj = {};
  parts.forEach((p) => (obj[p.type] = p.value));
  return { date: `${obj.year}-${obj.month}-${obj.day}`, time: `${obj.hour}:${obj.minute}` };
}

bot.onText(/^\/setsholat\s+(.+)$/, async (msg, match) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }

  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa atur jadwal sholat.");
    }
  } catch (e) {
    console.error(e);
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  const kota = match[1].trim();

  try {
    await getJadwalSholat(kota); // validasi dulu kota-nya ada datanya
  } catch (e) {
    return bot.sendMessage(
      chatId,
      `❌ Kota "${kota}" tidak ditemukan / gagal ambil data. Coba nama kota lain (contoh: Jakarta, Bandung, Surabaya).`
    );
  }

  sholatSettings[String(chatId)] = { kota, autoPost: true, lastPosted: null };
  saveSholatSettings();

  bot.sendMessage(
    chatId,
    `✅ Jadwal sholat grup ini di-set ke kota <b>${kota}</b>.\nBot bakal auto-post jadwal tiap hari jam <b>00:05 WIB</b>.\nKetik /jadwalsholat buat cek sekarang juga.`,
    { parse_mode: "HTML" }
  );
});

bot.onText(/^\/jadwalsholat(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const saved = sholatSettings[String(chatId)];
  const kota = (match[1] && match[1].trim()) || (saved && saved.kota);

  if (!kota) {
    return bot.sendMessage(
      chatId,
      "ℹ️ Kota belum di-set. Ketik <code>/setsholat Jakarta</code> dulu (admin), atau langsung <code>/jadwalsholat Jakarta</code> buat cek sekali aja.",
      { parse_mode: "HTML" }
    );
  }

  try {
    const timings = await getJadwalSholat(kota);
    const tanggal = new Date().toLocaleDateString("id-ID", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "Asia/Jakarta",
    });
    bot.sendMessage(chatId, jadwalSholatText(kota, timings, tanggal), { parse_mode: "HTML" });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Gagal ambil jadwal sholat untuk "${kota}". Coba lagi nanti atau cek nama kotanya.`);
  }
});

bot.onText(/^\/stopsholat$/, async (msg) => {
  const chatId = msg.chat.id;

  if (msg.chat.type !== "group" && msg.chat.type !== "supergroup") {
    return bot.sendMessage(chatId, "⚠️ Fitur ini hanya berlaku di dalam grup.");
  }

  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!["creator", "administrator"].includes(member.status)) {
      return bot.sendMessage(chatId, "⚠️ Hanya admin grup yang bisa matiin auto-post jadwal sholat.");
    }
  } catch (e) {
    console.error(e);
    return bot.sendMessage(chatId, "❌ Gagal mengecek status admin, coba lagi.");
  }

  if (sholatSettings[String(chatId)]) {
    sholatSettings[String(chatId)].autoPost = false;
    saveSholatSettings();
  }
  bot.sendMessage(chatId, "🔕 Auto-post jadwal sholat di grup ini sudah dimatikan (setting kota tetap tersimpan).");
});

// Cek tiap menit; kalau jam Jakarta pas 00:05 dan grup itu belum diposting hari ini -> auto-post
setInterval(async () => {
  const { date, time } = getJakartaParts();
  if (time !== "00:05") return;

  for (const chatId of Object.keys(sholatSettings)) {
    const setting = sholatSettings[chatId];
    if (!setting || !setting.autoPost) continue;
    if (setting.lastPosted === date) continue; // sudah diposting hari ini

    try {
      const timings = await getJadwalSholat(setting.kota);
      const tanggal = new Date().toLocaleDateString("id-ID", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "Asia/Jakarta",
      });
      await bot.sendMessage(chatId, jadwalSholatText(setting.kota, timings, tanggal), {
        parse_mode: "HTML",
      });
      setting.lastPosted = date;
      saveSholatSettings();
    } catch (e) {
      console.error(`⚠️ Gagal auto-post jadwal sholat untuk chat ${chatId}:`, e.message);
    }
  }
}, 60 * 1000);

// ================= NOTIF COMMAND SALAH / TIDAK DIKENALI =================
// Kalau user ngetik "/apaaja" yang bukan command asli bot, kasih tau dengan
// pesan bercanda biar user sadar salah ketik command.
// PENTING: kalau nambah command baru di atas, tambahin juga nama commandnya
// ke daftar KNOWN_COMMANDS di bawah ini biar tidak salah dianggap "command asing".
const KNOWN_COMMANDS = [
  "start", "ping", "stopping", "serverinfo", "tools",
  "tiktok", "image", "gif", "pinterest", "video", "anime", "episodes", "music",
  "jam", "stopjam",
  "ai",
  "ttt", "stopttt", "suit", "stopsuit",
  "stats", "statsreset",
  "warns", "resetwarn", "warnon", "warnoff", "mute", "unmute",
  "setsholat", "jadwalsholat", "stopsholat",
  "joke", "jokes",
  "setwelcome", "setgoodbye", "welcomeon", "welcomeoff", "cekwelcome",
  "rules", "setrules", "resetrules", "rulesnotifon", "rulesnotifoff",
  "antilinkon", "antilinkoff", "antilinkaksi", "antilinkwl",
  "translate",
  "setmp3", "setnamamp3", "setbanner",
  "testnotif",
  "kurs", "btc", "eth", "crypto", "market", "top",
];

bot.on("message", (msg) => {
  const text = msg.text;
  if (!text || text[0] !== "/") return; // bukan command, abaikan

  const match = /^\/([a-zA-Z0-9_]+)(?:@\w+)?/.exec(text);
  if (!match) return;

  const cmd = match[1].toLowerCase();
  if (KNOWN_COMMANDS.includes(cmd)) return; // command valid, biar ditangani handler masing-masing

  bot.sendMessage(
    msg.chat.id,
    "😤 Otak taro mana lu, command aja ngaco. Ketik /start biar nggak makin dongo."
  );
});

// ================= ERROR HANDLING GLOBAL =================
bot.on("polling_error", (err) => console.error("Polling error:", err.message));

// PENTING: tanpa ini, error kecil yang tidak tertangkap (misal callback query
// yang sudah kadaluarsa, gagal edit pesan, dsb) bisa membuat SELURUH proses
// bot mati total (Node.js default behavior: crash on unhandled rejection).
// Dengan handler ini, error cukup dicatat di log dan bot tetap jalan.
process.on("unhandledRejection", (reason) => {
  console.error("⚠️ Unhandled Rejection (bot tetap jalan):", reason);
  const msg = reason instanceof Error ? reason.message : String(reason);
  notifyOwner(
    `<b>⚠️ BOT ERROR (unhandled rejection)</b>\n\nBot tetap jalan, tapi ada error yang tidak tertangani:\n<code>${escapeHtml(
      msg
    ).slice(0, 500)}</code>`,
    "unhandled-rejection"
  );
});
process.on("uncaughtException", (err) => {
  console.error("⚠️ Uncaught Exception (bot tetap jalan):", err);
  notifyOwner(
    `<b>🚨 BOT ERROR (uncaught exception)</b>\n\nBot mencoba tetap jalan, tapi ini serius, cek log server:\n<code>${escapeHtml(
      err && err.message ? err.message : String(err)
    ).slice(0, 500)}</code>`,
    "uncaught-exception"
  );
});

// ================= NOTIF MAINTENANCE SAAT BOT DIMATIKAN =================
// Kirim pesan ke semua grup yang pernah aktif, ngasih tau bot lagi maintenance,
// sebelum proses bot bener-bener berhenti. Berlaku untuk Ctrl+C, kill, restart
// PM2/systemctl, dll (SIGINT/SIGTERM) — tapi TIDAK untuk crash mendadak
// (uncaughtException) karena kondisinya nggak terduga/error.
// Kirim pesan yang sama ke semua grup yang pernah tercatat aktivitasnya di stats.json
async function broadcastToGroups(text) {
  const chatIds = Object.keys(statsData);
  if (chatIds.length === 0) return;

  const sendWithTimeout = (chatId) =>
    Promise.race([
      bot.sendMessage(chatId, text, { parse_mode: "HTML" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
    ]).catch(() => {}); // abaikan kalau gagal kirim ke salah satu grup (misal bot udah dikick)

  await Promise.all(chatIds.map(sendWithTimeout));
}

async function notifyMaintenance() {
  await broadcastToGroups(
    `<b>🛠️ SERVER OFF</b>\n\n` + `Sedang ada maintenance.\n` + `Mohon tunggu sebentar 🙏`
  );
}

async function notifyOnline() {
  await broadcastToGroups(
    `<b>🟢 SERVER KEMBALI ONLINE</b>\n\n` + `Selamat mencoba fitur baru! 🎉`
  );
}

// Simpan statistik terakhir & kasih notif maintenance saat bot dimatikan (Ctrl+C / kill)
process.on("SIGINT", async () => {
  console.log("🛑 Bot dimatikan (SIGINT)... mengirim notif maintenance ke grup...");
  saveStats();
  await notifyMaintenance();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log("🛑 Bot dimatikan (SIGTERM)... mengirim notif maintenance ke grup...");
  saveStats();
  await notifyMaintenance();
  process.exit(0);
});

// ================= MENU TOOLS BOT (tombol ☰ di Telegram) =================
// Ini bikin daftar command muncul rapi pas user tap tombol menu di sebelah
// kolom chat / ketik "/" — persis kayak bot-bot official.
const publicBotCommands = [
    { command: "start", description: "🚀 Mulai / kenalan sama bot (buka menu utama)" },
    { command: "ping", description: "🏓 Cek kecepatan respon bot (live)" },
    { command: "stopping", description: "⏹️ Hentikan live ping" },
    { command: "serverinfo", description: "🖥️ Info server/device bot" },
    { command: "tools", description: "🛠️ Menu utility bot" },
    { command: "warnon", description: "🔔 Aktifkan warning anti-spam (admin)" },
    { command: "warnoff", description: "🔕 Matikan warning anti-spam (admin)" },
    { command: "mute", description: "🔇 Mute user, reply pesannya (admin)" },
    { command: "unmute", description: "🔊 Unmute user, reply pesannya (admin)" },
    { command: "setsholat", description: "🕌 Set kota jadwal sholat grup (admin)" },
    { command: "jadwalsholat", description: "🕌 Cek jadwal sholat hari ini" },
    { command: "stopsholat", description: "🔕 Matikan auto-post jadwal sholat (admin)" },
    { command: "setwelcome", description: "👋 Set pesan welcome custom (admin)" },
    { command: "setgoodbye", description: "😢 Set pesan goodbye custom (admin)" },
    { command: "welcomeon", description: "🟢 Aktifkan welcome/goodbye (admin)" },
    { command: "welcomeoff", description: "🔴 Matikan welcome/goodbye (admin)" },
    { command: "antilinkon", description: "🟢 Aktifkan anti-link grup (admin)" },
    { command: "antilinkoff", description: "🔴 Matikan anti-link grup (admin)" },
    { command: "antilinkaksi", description: "⚙️ Atur aksi anti-link: warn/mute/kick/delete (admin)" },
    { command: "antilinkwl", description: "📋 Atur whitelist domain anti-link (admin)" },
    { command: "cekwelcome", description: "⚙️ Lihat setting welcome/goodbye" },
    { command: "rules", description: "📜 Lihat aturan grup" },
    { command: "setrules", description: "✏️ Set aturan grup custom (admin)" },
    { command: "resetrules", description: "♻️ Kembalikan aturan ke default (admin)" },
    { command: "rulesnotifon", description: "🟢 Aktifkan notif rules ke member baru (admin)" },
    { command: "rulesnotifoff", description: "🔴 Matikan notif rules ke member baru (admin)" },
    { command: "translate", description: "🌐 Terjemahkan teks, contoh: /translate en teks" },
    { command: "setmp3", description: "🎧 Ganti lagu tema menu (admin, kirim/reply mp3)" },
    { command: "setnamamp3", description: "🏷️ Ganti nama/judul lagu tema menu (admin)" },
    { command: "setbanner", description: "🖼️ Ganti banner menu - gif/mp4/jpg (admin)" },
    { command: "tiktok", description: "🎵 Download video TikTok" },
    { command: "video", description: "🎬 Cari & download video" },
    { command: "music", description: "🎶 Cari & download musik" },
    { command: "image", description: "🖼️ Cari gambar" },
    { command: "gif", description: "🎞️ Cari GIF" },
    { command: "pinterest", description: "📌 Cari gambar dari Pinterest" },
    { command: "anime", description: "📺 Cari info anime" },
    { command: "episodes", description: "📅 Cek episode anime" },
    { command: "ai", description: "🤖 Ngobrol sama AI" },
    { command: "jam", description: "⏰ Mulai reminder jam" },
    { command: "stopjam", description: "⏹️ Stop reminder jam" },
    { command: "ttt", description: "❌⭕ Main Tic Tac Toe" },
    { command: "stopttt", description: "⏹️ Stop game Tic Tac Toe" },
    { command: "suit", description: "✊✋✌️ Main suit/gunting batu kertas" },
    { command: "stopsuit", description: "⏹️ Stop game suit" },
    { command: "stats", description: "📊 Liat statistik bot" },
    { command: "joke", description: "😹 Kasih lelucon/joke random" },
];

bot
  .setMyCommands(publicBotCommands)
  .then(() => console.log("✅ Menu command Telegram berhasil di-set"))
  .catch((err) => console.error("❌ Gagal set menu command:", err.message));

// ================= MENU COMMAND KHUSUS ADMIN (scope per-chat) =================
// /panel cuma didaftarkan ke chat pribadi masing2 admin (bukan default global),
// jadi command ini TIDAK muncul di menu "/" siapapun kecuali admin yang
// ID-nya ada di ADMIN_IDS/OWNER_CHAT_ID. User biasa tidak akan tahu command
// ini ada. Ini cuma soal tampilan menu -- proteksi SEBENARNYA tetap di
// isBotAdmin() pada handler /panel di atas, jadi tetap aman walau command
// diketik manual oleh non-admin.
if (ADMIN_IDS.length) {
  const adminBotCommands = [
    { command: "panel", description: "🛡️ Buka panel admin bot" },
    ...publicBotCommands,
  ];
  ADMIN_IDS.forEach((adminId) => {
    bot
      .setMyCommands(adminBotCommands, { scope: { type: "chat", chat_id: adminId } })
      .catch((err) =>
        console.error(`❌ Gagal set menu command admin untuk ${adminId}:`, err.message)
      );
  });
}

let dashboardApi;
try {
  dashboardApi = attachDashboard({
    bot,
    botId,
  startedAt: dashboardStartedAt,
  statsData,
  saveStats,
  welcomeSettings,
  saveWelcomeSettings,
  rulesSettings,
  saveRulesSettings,
  warnSettings,
  saveWarnSettings,
  antiSpamConfig,
  saveAntiSpamConfig,
  blacklistSettings,
  saveBlacklistSettings,
  sholatSettings,
  saveSholatSettings,
  DEFAULT_WELCOME,
  DEFAULT_GOODBYE,
  DEFAULT_RULES,
  getJadwalSholat,
  jadwalSholatText,
  getJakartaParts,
  spamWarnings,
  spamLog,
  spamKey,
  MAX_WARNING,
  getMenuSongTitle: () => menuSongTitle,
  setMenuSongTitle: (title) => {
    const clean = (title || "").trim();
    if (clean) {
      menuSongTitle = clean;
      cachedMenuSongFileId = null; // paksa upload ulang dari disk biar judul baru kepakai
      saveMenuCache();
    }
    return menuSongTitle;
  },
  clearBannerCache: () => {
    cachedBannerFileId = null;
    cachedBannerType = null;
    saveMenuCache();
  },
    clearMenuSongCache: () => {
      cachedMenuSongFileId = null;
      saveMenuCache();
    },
  });
  pushEvent = dashboardApi.pushEvent; // ganti stub di atas dengan pushEvent asli dari dashboard.js
  console.log("✅ Dashboard berhasil dijalankan.");
} catch (err) {
  console.error("❌ Dashboard GAGAL dijalankan:", err);
  notifyOwner(
    `<b>🚨 DASHBOARD GAGAL START</b>\n\nBot Telegram tetap jalan normal, tapi dashboard web-nya gagal nyala:\n<code>${escapeHtml(
      err && err.message ? err.message : String(err)
    ).slice(0, 500)}</code>\n\nCek log server (pm2 log / terminal Termux) buat detailnya.`,
    "dashboard-start-failed"
  );
}

console.log("🔖 VERSION CHECK: bot-3.js REV-2026-07-08-C (fitur dashboard: moderasi/warn/nama-lagu/cache-fix AKTIF)");
console.log("✅ BOT AKTIF...");

// Kasih tau semua grup kalau bot baru aja nyala/online lagi
notifyOnline();

// ================= HEALTH-CHECK DASHBOARD (deteksi down/hang) =================
// Dashboard jalan dalam proses Node yang sama dengan bot ini, jadi kalau
// prosesnya crash total, bot ini juga ikut mati (makanya ada notifyOwner di
// uncaughtException/unhandledRejection di atas buat kasus itu). Tapi ada
// skenario lain yang LEBIH sering kejadian: dashboard "hang" atau errornya
// cuma di route Express tertentu, sementara bot Telegram-nya sendiri masih
// hidup dan bisa kirim pesan -- baru di kondisi INI notif ini kepakai.
//
// Caranya: nge-ping diri sendiri (localhost) ke port dashboard tiap beberapa
// menit. Kalau gagal beberapa kali beruntun, kirim alert. Begitu nyala lagi,
// kirim notif "sudah pulih".
//
// PENTING: sesuaikan DASHBOARD_HEALTH_PORT di .env kalau port dashboard.js
// kamu BEDA dari PORT bot (kalau dashboard nge-listen di port terpisah,
// misal lewat app.listen(4000)). Kalau dashboard nempel di port yang sama
// dengan bot (PORT di atas), biarkan default saja.
const DASHBOARD_HEALTH_PORT = process.env.DASHBOARD_HEALTH_PORT || PORT;
const DASHBOARD_HEALTH_PATH = process.env.DASHBOARD_HEALTH_PATH || "/";
const HEALTH_CHECK_INTERVAL_MS = 3 * 60 * 1000; // cek tiap 3 menit
const HEALTH_FAIL_THRESHOLD = 2; // harus gagal 2x beruntun baru dianggap "down" (hindari false alarm)

let dashboardConsecutiveFails = 0;
let dashboardWasDown = false;

function checkDashboardHealth() {
  const req = http.get(
    {
      host: "127.0.0.1",
      port: DASHBOARD_HEALTH_PORT,
      path: DASHBOARD_HEALTH_PATH,
      timeout: 5000,
    },
    (res) => {
      res.resume(); // buang body, cuma butuh tau responsnya jalan
      // Anggap sehat kalau server merespon apapun status code-nya (yang penting
      // tidak timeout/connection refused -- itu tandanya proses masih hidup).
      if (dashboardWasDown) {
        dashboardWasDown = false;
        dashboardConsecutiveFails = 0;
        notifyOwner(
          "<b>🟢 DASHBOARD SUDAH NORMAL LAGI</b>\n\nDashboard web sudah bisa diakses lagi seperti biasa.",
          "dashboard-recovered"
        );
      } else {
        dashboardConsecutiveFails = 0;
      }
    }
  );

  req.on("timeout", () => {
    req.destroy();
    handleDashboardCheckFailure("timeout (tidak merespon dalam 5 detik)");
  });

  req.on("error", (e) => {
    handleDashboardCheckFailure(e.message);
  });
}

function handleDashboardCheckFailure(reason) {
  dashboardConsecutiveFails += 1;
  console.error(`⚠️ Health-check dashboard gagal (${dashboardConsecutiveFails}x): ${reason}`);

  if (dashboardConsecutiveFails >= HEALTH_FAIL_THRESHOLD && !dashboardWasDown) {
    dashboardWasDown = true;
    notifyOwner(
      `<b>🔴 DASHBOARD DOWN</b>\n\nDashboard web tidak merespon (${dashboardConsecutiveFails}x gagal berturut-turut).\nAlasan terakhir: <code>${escapeHtml(
        reason
      )}</code>\n\nBot Telegram utama masih jalan normal. Cek server/proses dashboard-nya ya.`,
      "dashboard-down"
    );
  }
}

if (OWNER_CHAT_ID) {
  setInterval(checkDashboardHealth, HEALTH_CHECK_INTERVAL_MS);
  console.log(
    `🔎 Health-check dashboard aktif (tiap ${HEALTH_CHECK_INTERVAL_MS / 60000} menit, target port ${DASHBOARD_HEALTH_PORT}).`
  );
} else {
  console.log("ℹ️ Health-check dashboard tidak aktif karena OWNER_CHAT_ID belum diisi di .env.");
}
