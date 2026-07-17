// ================= plugins/tiktok.js =================
// Fitur download TikTok tanpa watermark (command /tiktok DAN auto-detect
// link TikTok yang dikirim langsung tanpa command). Auto-detect di sini
// didaftarkan lewat bot.on("message") TERPISAH dari listener utama di core --
// ini AMAN karena node-telegram-bot-api adalah EventEmitter biasa, semua
// listener "message" tetap dipanggil semuanya, tidak saling menimpa.
module.exports = function tiktokPlugin(ctx) {
  const {
    bot, fs, path, https, notifyOwner, tempDir,
    callTelegramWithRetry, createProgressUpdater, simulateProgress,
    trackDownloadSpeed, formatElapsed, formatEta, formatSpeed,
  } = ctx;

const TIKTOK_URL_REGEX = /https?:\/\/(?:www\.|vt\.|vm\.|m\.)?tiktok\.com\/\S+/i;

// Fetch dengan timeout, biar kalau server tikwm/CDN macet, request di-abort
// otomatis dan error dilempar, bukan menggantung tanpa batas waktu.
async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === "AbortError") {
      throw new Error("Timeout: server tidak merespons dalam waktu yang wajar.");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// reader.read() versi stream TikTok tidak punya timeout bawaan. Kalau CDN
// macet di tengah download (koneksi masih "terbuka" tapi tidak ada data baru
// yang mengalir), reader.read() bisa menggantung selamanya -> progress bar
// nyangkut di persentase terakhir tanpa pernah error/selesai (ini penyebab
// bug "stuck di 60%"). Fungsi ini membatasi tiap pembacaan chunk dengan
// timeout, supaya stall bisa dideteksi dan di-retry/gagal dengan jelas.
function readChunkWithTimeout(reader, timeoutMs = 15000) {
  return Promise.race([
    reader.read(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("STALL: tidak ada data baru dari server (macet).")), timeoutMs)
    ),
  ]);
}

async function fetchTiktokNoWatermark(tiktokUrl) {
  const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(tiktokUrl)}`;
  const res = await fetchWithTimeout(apiUrl, {}, 15000);

  if (!res.ok) {
    throw new Error(`API TikTok error (HTTP ${res.status})`);
  }

  const json = await res.json();

  if (!json || json.code !== 0 || !json.data) {
    throw new Error((json && json.msg) || "Gagal mengambil data video TikTok (link salah / video privat).");
  }

  return json.data; // { play: url tanpa watermark, hdplay, title, author, ... }
}

// Download video jadi buffer, dengan deteksi stall (macet) per-chunk.
// Kalau macet, lempar error supaya caller bisa retry/fallback ke URL lain,
// alih-alih menggantung selamanya di suatu persentase.
async function downloadVideoToBuffer(videoUrl, onProgress) {
  const videoRes = await fetchWithTimeout(videoUrl, {}, 20000);
  if (!videoRes.ok) {
    throw new Error(`Gagal mengunduh file video (HTTP ${videoRes.status})`);
  }

  const totalBytes = Number(videoRes.headers.get("content-length")) || 0;
  const chunks = [];
  let received = 0;

  if (videoRes.body && typeof videoRes.body.getReader === "function") {
    const reader = videoRes.body.getReader();
    try {
      while (true) {
        const { done, value } = await readChunkWithTimeout(reader, 15000);
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (totalBytes > 0 && onProgress) {
          await onProgress(received, totalBytes);
        }
      }
    } catch (e) {
      await reader.cancel().catch(() => {});
      throw e;
    }
  } else {
    chunks.push(Buffer.from(await videoRes.arrayBuffer()));
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

async function handleTiktokLink(msg, tiktokUrl) {
  const chatId = msg.chat.id;
  let progress;
  let filePath;

  try {
    await bot.sendChatAction(chatId, "typing");
    progress = createProgressUpdater(chatId, "Mengunduh video TikTok (tanpa watermark)...");

    const queueNote =
      heavyJobQueueWaiting > 0
        ? `Ada ${heavyJobQueueWaiting} proses berat lain di antrian, menunggu giliran dulu. `
        : "";
    await progress.start(0, (queueNote + "Mengambil data video...").trim());

    // Antri bareng /togif, /tovideo, dan download musik/video YouTube --
    // biar tidak ada beberapa download/convert berat jalan bersamaan yang
    // bikin bot lag/delay ke semua orang (lihat komentar di runHeavyJobQueued).
    const { resultPromise } = runHeavyJobQueued(async () => {
      const data = await fetchTiktokNoWatermark(tiktokUrl);
    const hdUrl = data.hdplay;
    const sdUrl = data.play;
    const videoUrl = hdUrl || sdUrl;

    if (!videoUrl) {
      throw new Error("Link video tidak ditemukan, mungkin video privat/sudah dihapus.");
    }
    await progress.update(15, "Mulai mengunduh file video...");

    await bot.sendChatAction(chatId, "upload_video");

    const speedTracker = trackDownloadSpeed();
    const onProgress = async (received, totalBytes) => {
      const pct = 15 + (received / totalBytes) * 75; // sisakan 15-90% buat download
      await progress.update(pct, "Mengunduh file video...", speedTracker(received));
    };

    let buffer;
    try {
      // Coba versi HD dulu (kalau ada)
      buffer = await downloadVideoToBuffer(videoUrl, onProgress);
    } catch (e) {
      // Kalau macet/gagal (misal timeout/stall) dan masih ada alternatif URL
      // SD yang belum dicoba, fallback otomatis ke situ alih-alih bikin user
      // nunggu tanpa kepastian atau langsung error total.
      if (hdUrl && sdUrl && videoUrl === hdUrl && sdUrl !== hdUrl) {
        console.warn("HD download macet/gagal, fallback ke versi SD:", e.message);
        await progress.update(15, "Versi HD gagal, mencoba versi biasa...");
        buffer = await downloadVideoToBuffer(sdUrl, onProgress);
      } else {
        throw e;
      }
    }
    await progress.update(90, "Menyimpan file...");

    filePath = path.join(tempDir, `tiktok_${Date.now()}.mp4`);
    fs.writeFileSync(filePath, buffer);
    await progress.update(97, "Mengirim video...");

    const title = (data.title || "Video TikTok").slice(0, 900);
    const author = data.author?.nickname || data.author?.unique_id || "-";
    const caption = `🎬 <b>${title}</b>\n👤 ${author}\n✅ Tanpa watermark`;

    await callTelegramWithRetry(
      () =>
        bot.sendVideo(chatId, fs.createReadStream(filePath), {
          caption,
          parse_mode: "HTML",
        }),
      { label: "sendVideo tiktok", maxRetries: 3 }
    );
    }); // tutup job yang diantri (runHeavyJobQueued)

    await resultPromise;
    await progress.remove();
  } catch (e) {
    console.error("Gagal download TikTok:", e.message);
    const retryAfter = getTelegramRetryAfterSeconds(e);
    const detail = (e.message || "unknown error").slice(0, 300).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    const errText =
      retryAfter !== null
        ? `⏳ Bot kena rate limit dari Telegram (terlalu banyak request). Coba lagi dalam ~${retryAfter} detik.`
        : `❌ Gagal mengunduh video TikTok.\n\n<b>Detail:</b> <code>${detail}</code>`;

    if (progress && progress.messageId) {
      await progress.replaceWith(errText);
    } else {
      bot.sendMessage(chatId, errText, { parse_mode: "HTML" });
    }
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
}

// Command /tiktok <link> sebagai alternatif, kalau user lebih suka pakai command
bot.onText(/^\/tiktok (.+)/, (msg, match) => {
  const url = match[1].trim();
  if (!TIKTOK_URL_REGEX.test(url)) {
    return bot.sendMessage(msg.chat.id, "⚠️ Itu bukan link TikTok yang valid.");
  }
  handleTiktokLink(msg, url);
});

bot.onText(/^\/tiktok$/, (msg) =>
  bot.sendMessage(msg.chat.id, "⚠️ Format: <code>/tiktok https://vt.tiktok.com/xxxx</code>\n\nAtau kirim langsung link TikTok-nya, bot otomatis download.", {
    parse_mode: "HTML",
  })
);


  // Auto-download kalau user kirim link TikTok langsung (tanpa command)
  bot.on("message", (msg) => {
    if (msg.text && !msg.text.startsWith("/")) {
      const tiktokMatch = msg.text.match(TIKTOK_URL_REGEX);
      if (tiktokMatch) {
        handleTiktokLink(msg, tiktokMatch[0]);
      }
    }
  });
};
