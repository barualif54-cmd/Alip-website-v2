// ================= plugins/music.js =================
// Fitur /music (download audio dari YouTube jadi file MP3, + cover art
// ala Spotify pakai Jimp kalau tersedia).
module.exports = function musicPlugin(ctx) {
  const {
    bot, fs, path, https, spawn, Jimp, escapeHtml, tempDir, cookiesPath,
    MAX_DURATION_SECONDS, callTelegramWithRetry, createProgressUpdater,
  } = ctx;

bot.onText(/^\/music (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  let progress;

  try {
    await bot.sendChatAction(chatId, "typing");
    const r = await ytSearch(query);

    if (!r.videos.length) {
      return bot.sendMessage(chatId, "❌ Musik tidak ditemukan untuk: " + query);
    }

    const m = r.videos[0];

    // Cek durasi, tolak kalau kepanjangan biar file tidak kegedean
    if (m.seconds && m.seconds > MAX_DURATION_SECONDS) {
      return bot.sendMessage(
        chatId,
        `⚠️ Lagu "${m.title}" terlalu panjang (${m.timestamp}). Maksimal ${MAX_DURATION_SECONDS / 60} menit.`
      );
    }

    progress = createProgressUpdater(chatId, `Mengunduh: ${m.title}`);
    const queueNote =
      heavyJobQueueWaiting > 0
        ? `Ada ${heavyJobQueueWaiting} proses berat lain di antrian, menunggu giliran dulu. `
        : "";
    await progress.start(0, (queueNote + "Menyiapkan unduhan...").trim());
    await bot.sendChatAction(chatId, "upload_voice");

    const baseName = `${Date.now()}_${m.videoId}`;
    const outputTemplate = path.join(tempDir, `${baseName}.%(ext)s`);
    const outputPath = path.join(tempDir, `${baseName}.mp3`);

    // downloadAsMp3 melapor persen asli dari output yt-dlp (0-100%, di mana
    // 100% dari yt-dlp = selesai download, sebelum proses convert ke mp3).
    // Sisakan sedikit ruang (max 92%) buat proses convert & kirim file.
    // Diantri bareng /togif, /tovideo, dan TikTok downloader supaya tidak
    // ada beberapa proses berat (yt-dlp/ffmpeg) jalan bersamaan.
    const { resultPromise } = runHeavyJobQueued(() =>
      downloadAsMp3(m.url, outputTemplate, (pct, speedText) => {
        progress.update(Math.min(92, pct), undefined, speedText).catch(() => {});
      })
    );
    await resultPromise;
    await progress.update(95, "Mengirim file audio...");

    const fileSizeMb = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
    const requester = msg.from?.first_name || msg.from?.username || "Seseorang";
    const authorLine = m.author?.name ? `👤 ${escapeHtml(m.author.name)}\n` : "";
    const viewsText =
      typeof m.views === "number" ? `  ·  👁️ ${m.views.toLocaleString("id-ID")}x ditonton` : "";

    const caption =
      `🎵 <b>${escapeHtml(m.title)}</b>\n` +
      authorLine +
      `⏱️ ${m.timestamp}${viewsText}\n` +
      `🎧 128kbps MP3 · ${fileSizeMb}MB\n` +
      `📥 diminta oleh ${escapeHtml(requester)}`;

    // ================= COVER ART ALA SPOTIFY =================
    // Telegram nampilin kotak thumbnail kecil di sebelah player audio kalau
    // parameter `thumb` diisi -- ini yang bikin tampilannya jadi mirip
    // Spotify/media player (ada cover art), bukan cuma teks polos kayak
    // sebelumnya. Ambil thumbnail dari hasil pencarian yt-search, download
    // dulu ke file lokal (Telegram tidak terima URL langsung buat `thumb`).
    let thumbPath = null;
    const thumbUrl = m.thumbnail || m.image;
    if (thumbUrl) {
      try {
        thumbPath = path.join(tempDir, `${baseName}_thumb.jpg`);
        await downloadUrlToFile(thumbUrl, thumbPath);

        // Telegram mensyaratkan thumbnail: JPEG, max sisi 320px, ukuran file < 200KB.
        // Kalau lolos batas ini Telegram bisa nolak/abaikan thumbnail-nya.
        // jimp v1.x memvalidasi argumen pakai Zod dan ternyata signature resize()/quality()
        // beda-beda antar versi (kadang minta object {w,h}, kadang dua angka). Daripada
        // nebak satu bentuk, coba beberapa bentuk berurutan sampai salah satu berhasil.
        const tryCalls = async (fns) => {
          for (const fn of fns) {
            try {
              await fn();
              return true;
            } catch (e) {
              // lanjut coba bentuk berikutnya
            }
          }
          return false;
        };

        if (Jimp) {
          const img = await Jimp.read(thumbPath);
          const bmp = img.bitmap || img;
          const curW = bmp.width || img.width;
          const curH = bmp.height || img.height;

          if (curW && curH && typeof img.resize === "function") {
            const maxSide = 320;
            const scale = Math.min(1, maxSide / Math.max(curW, curH));
            const targetW = Math.max(1, Math.round(curW * scale));
            const targetH = Math.max(1, Math.round(curH * scale));
            const resized = await tryCalls([
              () => img.resize({ w: targetW, h: targetH }),
              () => img.resize(targetW, targetH),
              () => img.resize({ width: targetW, height: targetH }),
            ]);
            if (!resized) {
              console.error("⚠️ Semua bentuk resize() gagal, thumbnail dipakai ukuran asli.");
            }
          }

          const setQuality = async (q) => {
            if (typeof img.quality !== "function") return false;
            return tryCalls([
              () => img.quality(q),
              () => img.quality({ quality: q }),
            ]);
          };

          const saveImage = async () => {
            if (typeof img.writeAsync === "function") await img.writeAsync(thumbPath);
            else if (typeof img.write === "function") await img.write(thumbPath);
          };

          await setQuality(80);
          await saveImage();

          // Kalau masih di atas 200KB setelah resize, turunkan kualitas bertahap.
          let q = 80;
          while (
            fs.existsSync(thumbPath) &&
            fs.statSync(thumbPath).size > 200 * 1024 &&
            q > 20
          ) {
            q -= 15;
            const ok = await setQuality(q);
            if (!ok) break;
            await saveImage();
          }
        } else {
          console.error("⚠️ Jimp tidak tersedia, thumbnail dipakai apa adanya (mungkin ditolak Telegram kalau kegedean).");
        }
      } catch (e) {
        console.error("⚠️ Gagal download/proses thumbnail cover musik (lanjut tanpa cover):", e.message);
        thumbPath = null;
      }
    }

    // ================= COVER (FOTO) DULU, LALU AUDIO ASLI MP3 (2 BUBBLE) =================
    // Balik ke pendekatan foto+audio terpisah -- file yang dikirim tetap MP3 asli
    // (bukan video), dengan konsekuensi cover & player jadi 2 pesan terpisah
    // (batasan Telegram, sendAudio tidak bisa nampilin cover besar).
    if (thumbPath) {
      await bot.sendChatAction(chatId, "upload_photo");
      try {
        await callTelegramWithRetry(
          () =>
            bot.sendPhoto(chatId, fs.createReadStream(thumbPath), {
              caption,
              parse_mode: "HTML",
            }),
          { label: "music sendPhoto (cover)", maxRetries: 2 }
        );
      } catch (e) {
        console.error("⚠️ Gagal kirim foto cover (lanjut kirim audio tanpa foto cover):", e.message);
      }
    }

    await bot.sendChatAction(chatId, "upload_voice");
    // PENTING: dibungkus retry -- kalau Telegram lagi rate-limit (429),
    // proses download yt-dlp yang sudah selesai (butuh waktu & CPU) jangan
    // sampai kebuang percuma cuma karena gagal di langkah TERAKHIR (kirim
    // file). callTelegramWithRetry otomatis nunggu sesuai retry_after lalu
    // coba kirim ulang.
    await callTelegramWithRetry(
      () =>
        bot.sendAudio(
          chatId,
          fs.createReadStream(outputPath),
          {
            title: m.title,
            performer: m.author?.name || "Unknown",
            duration: m.seconds || undefined,
            // Caption sudah ditampilkan di pesan foto cover di atas (kalau ada),
            // jadi di sini nggak usah diulang -- biar nggak dobel teks yang sama.
            ...(thumbPath ? {} : { caption, parse_mode: "HTML" }),
            ...(thumbPath ? { thumb: thumbPath } : {}),
          },
          { filename: `${m.title}.mp3`.replace(/[\\/:*?"<>|]/g, "") }
        ),
      { label: "music sendAudio", maxRetries: 3 }
    );

    await progress.remove();

    // Bersihkan file sementara.
    fs.unlink(outputPath, () => {});
    if (thumbPath) fs.unlink(thumbPath, () => {});
    if (videoPath) fs.unlink(videoPath, () => {});
  } catch (e) {
    console.error(e);
    const detail = (e && e.message ? e.message : String(e)).slice(0, 300);
    const errText = `❌ Gagal mengunduh lagu.\n\n<b>Detail error:</b>\n<code>${detail.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]))}</code>`;
    if (progress && progress.messageId) {
      await progress.replaceWith(errText);
    } else {
      bot.sendMessage(chatId, errText, { parse_mode: "HTML" });
    }
  }
});

// ================= DOWNLOAD THUMBNAIL/COVER (buat tampilan ala Spotify) =================
// Telegram TIDAK bisa pakai URL langsung buat parameter `thumb` di sendAudio
// (beda dengan sendPhoto) -- filenya WAJIB diupload sebagai file lokal/multipart.
// Makanya thumbnail cover harus didownload dulu ke file sementara sebelum dipakai.
// Support redirect (banyak CDN thumbnail YouTube/ytimg pakai redirect 301/302).
function downloadUrlToFile(url, destPath, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https:") ? https : http;
    const req = client.get(url, (res) => {
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        res.resume(); // buang body redirect biar koneksi lama tidak nyangkut
        return resolve(downloadUrlToFile(res.headers.location, destPath, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`Gagal download thumbnail, status ${res.statusCode}`));
      }
      const fileStream = fs.createWriteStream(destPath);
      res.pipe(fileStream);
      fileStream.on("finish", () => fileStream.close((err) => (err ? reject(err) : resolve(destPath))));
      fileStream.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout download thumbnail")));
  });
}

// Download audio dari YouTube lalu convert ke mp3 pakai yt-dlp (lebih tahan deteksi bot YouTube)
// onProgress(percent, speedText) dipanggil setiap yt-dlp melaporkan progress terbaru,
// diambil dengan mem-parsing baris "[download]  45.2% ... at 1.20MiB/s ..." dari stdout/stderr yt-dlp.
function downloadAsMp3(youtubeUrl, outputTemplate, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      "-x",
      "--audio-format", "mp3",
      "--audio-quality", "128K",
      "--no-playlist",
      "--js-runtimes", "node",
      "--remote-components", "ejs:github",
      "--newline", // paksa tiap update progress jadi baris baru, lebih gampang di-parse
      // Tanam cover art (thumbnail) langsung ke dalam file mp3 (ID3 APIC tag)
      // pakai ffmpeg -- biar kalau file mp3-nya dibuka di player lain (bukan cuma
      // di Telegram) tetap muncul cover-nya, gaya kayak Spotify/media player biasa.
      "--embed-thumbnail",
      "--convert-thumbnails", "jpg", // beberapa thumbnail asli webp, ID3 lebih aman kalau jpg
      "--add-metadata",
      "-o", outputTemplate,
    ];

    if (fs.existsSync(cookiesPath)) {
      args.push("--cookies", cookiesPath);
    }

    args.push(youtubeUrl);

    const proc = spawn("yt-dlp", args);

    // Sama seperti ffmpeg: turunkan prioritas proses yt-dlp (nice 19) biar
    // sistem/HP tetap responsif walau lagi download, tidak ikut berebut
    // CPU penuh sama proses lain.
    try {
      os.setPriority(proc.pid, 19);
    } catch (e) {
      // abaikan kalau platform tidak mengizinkan (misal bukan Linux/Termux)
    }

    let stderr = "";
    let leftover = "";

    const parseProgress = (chunkStr) => {
      leftover += chunkStr;
      const lines = leftover.split(/\r|\n/);
      leftover = lines.pop() || ""; // sisa baris yang belum lengkap, simpan buat chunk berikutnya
      for (const line of lines) {
        const match = line.match(/\[download\]\s+([\d.]+)%(?:.*?at\s+([\d.]+\w+\/s))?/);
        if (match && onProgress) {
          const pct = parseFloat(match[1]);
          if (!Number.isNaN(pct)) onProgress(pct, match[2] || null);
        }
      }
    };

    proc.stdout.on("data", (chunk) => parseProgress(chunk.toString()));
    proc.stderr.on("data", (chunk) => {
      const str = chunk.toString();
      stderr += str;
      parseProgress(str); // yt-dlp kadang nulis progress ke stderr juga
    });

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("yt-dlp belum terinstall. Jalankan: pkg install yt-dlp"));
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        if (onProgress) onProgress(100);
        resolve();
      } else {
        reject(new Error(stderr.trim().split("\n").pop() || `yt-dlp gagal (kode ${code})`));
      }
    });
  });
}

// Download video dari YouTube langsung jadi file .mp4 (video+audio digabung) pakai yt-dlp.
// Dipakai buat trailer anime (/anime) dan bisa dipakai ulang untuk fitur download video lain.
// onProgress(percent) dipanggil setiap yt-dlp melaporkan persentase download terbaru.
function downloadAsMp4(youtubeUrl, outputTemplate, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      // Batasi max 720p biar file tidak kegedean & lebih cepat, fallback ke "best" kalau kombinasi ini tidak ada
      "-f", "bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4]/best",
      "--merge-output-format", "mp4",
      "--no-playlist",
      "--js-runtimes", "node",
      "--remote-components", "ejs:github",
      "--newline", // paksa tiap update progress jadi baris baru, lebih gampang di-parse
      "-o", outputTemplate,
    ];

    if (fs.existsSync(cookiesPath)) {
      args.push("--cookies", cookiesPath);
    }

    args.push(youtubeUrl);

    const proc = spawn("yt-dlp", args);

    // Sama seperti ffmpeg: turunkan prioritas proses yt-dlp (nice 19) biar
    // sistem/HP tetap responsif walau lagi download, tidak ikut berebut
    // CPU penuh sama proses lain.
    try {
      os.setPriority(proc.pid, 19);
    } catch (e) {
      // abaikan kalau platform tidak mengizinkan (misal bukan Linux/Termux)
    }

    let stderr = "";
    let leftover = "";

    const parseProgress = (chunkStr) => {
      leftover += chunkStr;
      const lines = leftover.split(/\r|\n/);
      leftover = lines.pop() || "";
      for (const line of lines) {
        const match = line.match(/\[download\]\s+([\d.]+)%(?:.*?at\s+([\d.]+\w+\/s))?/);
        if (match && onProgress) {
          const pct = parseFloat(match[1]);
          if (!Number.isNaN(pct)) onProgress(pct, match[2] || null);
        }
      }
    };

    proc.stdout.on("data", (chunk) => parseProgress(chunk.toString()));
    proc.stderr.on("data", (chunk) => {
      const str = chunk.toString();
      stderr += str;
      parseProgress(str);
    });

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("yt-dlp belum terinstall. Jalankan: pkg install yt-dlp"));
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      if (code === 0) {
        if (onProgress) onProgress(100);
        resolve();
      } else {
        reject(new Error(stderr.trim().split("\n").pop() || `yt-dlp gagal (kode ${code})`));
      }
    });
  });
}

// Cari file hasil download yt-dlp berdasarkan base name (ekstensi bisa beda-beda
// tergantung format akhir yang dipilih yt-dlp, biasanya .mp4 tapi jaga-jaga).
function findDownloadedFile(baseName) {
  const candidates = fs.readdirSync(tempDir).filter((f) => f.startsWith(baseName + "."));
  if (!candidates.length) return null;
  // Prioritaskan .mp4 kalau ada beberapa hasil
  candidates.sort((a, b) => (a.endsWith(".mp4") ? -1 : 1) - (b.endsWith(".mp4") ? -1 : 1));
  return path.join(tempDir, candidates[0]);
}


  bot.onText(/^\/music$/, (msg) =>
    bot.sendMessage(msg.chat.id, "⚠️ Format: <code>/music lofi hip hop</code>", { parse_mode: "HTML" })
  );
};
