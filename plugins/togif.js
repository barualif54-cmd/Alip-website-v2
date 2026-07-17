// ================= plugins/togif.js =================
// Fitur /togif dan /tovideo (convert video/animasi jadi GIF atau video ringan).
// Sengaja digabung satu file karena keduanya berbagi banyak helper (queue
// ffmpeg, deteksi sumber video, dsb) persis seperti versi asli.
//
// "actions bridge": MAX_TOGIF_DURATION_SECONDS dipakai juga oleh core (teks
// bantuan tombol menu utama /togif /tovideo), makanya di-expose lewat
// ctx.config di baris paling bawah file ini.
module.exports = function togifPlugin(ctx) {
  const {
    bot, fs, path, os, spawn, tempDir,
    callTelegramWithRetry, createProgressUpdater, simulateProgress,
  } = ctx;

const TOGIF_COMMAND_REGEX = /^\/togif(?:@\w+)?(?:\s+(\d+))?(?:\s+(\d+))?\s*$/i;
const TOVIDEO_COMMAND_REGEX = /^\/tovideo(?:@\w+)?(?:\s+(\d+))?(?:\s+(\d+))?\s*$/i;

const MAX_TOGIF_DURATION_SECONDS = 30; // dinaikkan lagi ke 30s sesuai permintaan -- video 20-30s tetap otomatis dibatasi ke kualitas paling ringan (lihat getSafeGifSettings) biar HP tidak berat
const DEFAULT_GIF_FPS = 24;
const DEFAULT_GIF_WIDTH = 640;
const MIN_GIF_FPS = 15;
const MAX_GIF_FPS = 30; // diturunkan dari 60 -- 60fps di GIF format sendiri banyak yang tidak render mulus, tapi bebannya besar
const MIN_GIF_WIDTH = 120;
const MAX_GIF_WIDTH = 854; // diturunkan dari 1920 -- HD penuh + filter kualitas tinggi = boros RAM di HP

// Batas keras TOTAL frame yang boleh dirender, independen dari kombinasi fps/durasi
// manapun yang dipilih. Ini mencegah kombinasi "fps sedang + durasi sedang" pun
// tetap kelewat berat -- yang jadi penyebab utama force-close sebelumnya.
const MAX_GIF_TOTAL_FRAMES = 450;

// GIF hasil kualitas tinggi ukurannya bisa besar. Kalau hasil akhir kelewat
// limit upload Telegram, bot otomatis nurunin fps/lebar sedikit demi sedikit
// dan render ulang, alih-alih langsung gagal total.
const TELEGRAM_ANIMATION_MAX_BYTES = 50 * 1024 * 1024; // 50MB, limit sendAnimation Bot API
const MAX_GIF_RENDER_ATTEMPTS = 3;

// Filter palette (palettegen+paletteuse) menghasilkan warna GIF jauh lebih
// bagus, TAPI mode "diff"-nya perlu nyimpen statistik lintas-frame di memori
// -- ini boros RAM terutama di resolusi besar, dan diduga jadi biang force-
// close di HP. Makanya filter berat ini HANYA dipakai kalau beban kerja
// (fps × lebar × durasi) masih kecil; selain itu pakai filter ringan biasa
// yang jauh lebih hemat memori (kualitas warna sedikit lebih sederhana,
// tapi jauh lebih aman buat HP).
const HIGH_QUALITY_WORKLOAD_LIMIT = 24 * 480 * 6; // ~setara 24fps, 480px, 6 detik

// Batasi jumlah thread yang dipakai ffmpeg. Kalau dibiarkan default, ffmpeg
// bisa memakai SEMUA core CPU sekaligus -- di HP ini bikin sistem Android
// kehabisan resource buat proses lain (termasuk UI-nya sendiri), yang
// akhirnya kelihatan sebagai "HP hang" atau Termux di-force-close oleh OS.
// Sisakan minimal 1 core buat sistem, dan jangan lebih dari 2 thread.
const FFMPEG_MAX_THREADS = Math.max(1, Math.min(2, os.cpus().length - 1));

// Batas waktu render. Kalau proses ffmpeg berjalan kelamaan (video berat/
// setting kualitas tinggi di HP low-end), lebih baik dihentikan otomatis
// daripada dibiarkan menggantung terus-menerus menghabiskan CPU.
const TOGIF_FFMPEG_TIMEOUT_MS = 3 * 60 * 1000; // 3 menit

// Antrian global: paksa konversi GIF berjalan SATU per satu di seluruh bot.
// Kalau beberapa user pakai /togif hampir bersamaan, tanpa antrian ini
// beberapa proses ffmpeg berat bisa jalan BARENGAN dan gabungan pemakaian
// CPU/RAM-nya bisa bikin HP hang/force-close. Dengan antrian, request kedua
// dst menunggu giliran dulu -- lebih lambat tapi jauh lebih aman buat HP.
// PENTING: antrian ini sengaja dibikin GLOBAL (dipakai bareng oleh /togif,
// /tovideo, TikTok downloader, dan download musik/video YouTube via yt-dlp),
// BUKAN antrian terpisah per fitur. Sebelumnya tiap fitur "berat" jalan
// bebas tanpa saling kenal, jadi kalau ada yang minta /music BARENGAN sama
// orang lain kirim link TikTok dan orang lain lagi pakai /togif, bisa 3
// proses berat (ffmpeg/yt-dlp) jalan BERSAMAAN. Di HP/Termux atau VPS
// spek kecil ini yang bikin bot kerasa lag/delay/"ping" tinggi ke SEMUA
// orang, bukan cuma yang minta fitur berat itu -- karena CPU & bandwidth
// abis dipakai proses background, event loop Node juga ikut ketahan.
let heavyJobQueueTail = Promise.resolve();
let heavyJobQueueWaiting = 0;

function runHeavyJobQueued(jobFn) {
  const wasWaiting = heavyJobQueueWaiting;
  heavyJobQueueWaiting++;
  const resultPromise = heavyJobQueueTail.then(() => {
    heavyJobQueueWaiting--;
    return jobFn();
  });
  // Lanjutkan antrian apapun hasil job sebelumnya (sukses/gagal), supaya
  // satu request yang error tidak membuat semua antrian setelahnya macet.
  heavyJobQueueTail = resultPromise.catch(() => {});
  return { resultPromise, queuePosition: wasWaiting };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// Bulatkan ke bilangan genap terdekat (ke bawah). Dipakai untuk lebar GIF,
// karena lebar ganjil juga bisa memicu bug yang sama seperti tinggi ganjil
// (lihat komentar di buildGifFilter): Telegram transcode GIF->MP4 (H.264)
// butuh dimensi genap, kalau tidak hasilnya solid-color di app Telegram.
function toEven(n) {
  return n % 2 === 0 ? n : n - 1;
}

// Beban kerja ffmpeg kira-kira sebanding dengan fps × lebar × durasi. Video
// panjang + setting kualitas maksimal sekaligus adalah kombinasi yang paling
// sering bikin HP hang/force-close, karena totalnya bisa berkali-kali lipat
// lebih berat dari video pendek. Makanya durasi lebih panjang otomatis
// dibatasi ke fps/lebar yang lebih aman, SEBELUM render dimulai (bukan cuma
// diperbaiki setelah gagal/kegedean). Ditambah batas keras total frame, dan
// keputusan otomatis pakai filter premium (berat) atau ringan (hemat memori).
function getSafeGifSettings(requestedFps, requestedWidth, durationSeconds) {
  const d = durationSeconds || 10; // durasi tak diketahui (dokumen) -> asumsikan sedang
  let maxFps = MAX_GIF_FPS;
  let maxWidth = MAX_GIF_WIDTH;

  if (d > 20) {
    maxFps = 15; // dinaikkan dari 12 -- selaras dengan MIN_GIF_FPS baru (15)
    maxWidth = 300; // lebar diturunkan sedikit buat kompensasi fps yang naik, biar HP tetap aman
  } else if (d > 12) {
    maxFps = 15;
    maxWidth = 480;
  } else if (d > 6) {
    maxFps = 20;
    maxWidth = 540;
  }
  // durasi <= 6 detik -> boleh sampai batas global (30fps/854px)

  let fps = Math.min(requestedFps, maxFps);
  let width = toEven(Math.min(requestedWidth, maxWidth));

  // Batas keras total frame, independen dari tier durasi di atas -- video
  // pendek dengan fps tinggi pun tetap bisa kelewat berat kalau lebarnya besar.
  if (fps * d > MAX_GIF_TOTAL_FRAMES) {
    fps = Math.max(MIN_GIF_FPS, Math.floor(MAX_GIF_TOTAL_FRAMES / d));
  }

  const workload = fps * width * d;
  const highQuality = workload <= HIGH_QUALITY_WORKLOAD_LIMIT;

  return {
    fps,
    width,
    highQuality,
    wasCapped: fps < requestedFps || width < requestedWidth,
  };
}



// Ambil info video/animasi dari sebuah pesan (video biasa, animasi/gif, video note,
// atau dokumen yang mime-type-nya video). Return null kalau tidak ada media video.
function getVideoSourceFromMessage(msg) {
  if (!msg) return null;
  if (msg.video) {
    return { file_id: msg.video.file_id, duration: msg.video.duration };
  }
  if (msg.animation) {
    return { file_id: msg.animation.file_id, duration: msg.animation.duration };
  }
  if (msg.video_note) {
    return { file_id: msg.video_note.file_id, duration: msg.video_note.duration };
  }
  if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith("video/")) {
    return { file_id: msg.document.file_id, duration: undefined };
  }
  return null;
}

// Filter render video H.264 (dipakai sebagai "GIF" -- video tanpa suara, loop).
//
// PENTING KENAPA GANTI DARI .gif KE .mp4:
// Sebelumnya bot mengirim file .gif mentah (hasil palettegen+paletteuse) lewat
// sendAnimation. Ternyata itu penyebab bug "hasil jadi blok warna solid
// (hijau/oranye) di Telegram, tapi normal di galeri HP": Telegram MEN-
// TRANSCODE ULANG file .gif yang diterima menjadi MP4 di SERVER MEREKA
// SENDIRI supaya bisa diputar mulus di app. Proses transcode internal itu
// kadang gagal/corrupt untuk video tertentu (ini bug yang sudah dikenal luas
// di ekosistem bot Telegram), dan hasil gagalnya tampil sebagai satu warna
// solid penuh layar. File .gif aslinya tetap valid, makanya kalau dibuka di
// galeri HP (yang memutar file GIF mentah, bukan versi olahan Telegram)
// hasilnya normal.
//
// Fix permanen: bot ENCODE SENDIRI ke MP4 (H.264, yuv420p, tanpa audio,
// faststart) dan kirim MP4 itu langsung ke sendAnimation. Telegram Bot API
// memang menerima animasi dalam bentuk "video H.264/MPEG-4 AVC tanpa suara"
// -- dengan begini transcoder internal Telegram yang buggy itu SAMA SEKALI
// tidak dilewati/dipakai lagi, karena kita sudah kasih format akhir yang
// mereka butuhkan.
function buildVideoFilter(fps, width) {
  // "-2" (bukan "-1") memaksa tinggi selalu genap -- H.264 mewajibkan
  // lebar & tinggi kelipatan 2, dimensi ganjil juga bisa memicu masalah
  // serupa pada sebagian decoder/player.
  return `fps=${fps},scale=${width}:-2:flags=lanczos`;
}

// Konversi file video jadi MP4 silent (dipakai sebagai "GIF") pakai ffmpeg.
// Kalau totalDurationSeconds diketahui, onProgress(percent 0-100) dipanggil
// berdasarkan waktu render asli dari ffmpeg (di-parsing dari baris
// "time=00:00:03.45" di stderr). Kalau tidak diketahui, onProgress tidak
// dipanggil (biar dipanggil pemanggil pakai simulateProgress).
function convertVideoToGif(inputPath, outputPath, { fps, width, totalDurationSeconds, highQuality, keepAudio }, onProgress) {
  return new Promise((resolve, reject) => {
    // highQuality (workload kecil) -> preset lebih lambat/kualitas lebih
    // bagus karena CPU tidak terlalu terbebani. Workload besar -> preset
    // cepat & CRF lebih tinggi (kompresi lebih agresif) biar tetap ringan
    // buat HP, sama seperti filosofi mode "ringan" versi GIF sebelumnya.
    const preset = highQuality ? "medium" : "veryfast";
    const crf = highQuality ? "20" : "26";

    const args = [
      "-y",
      "-threads", String(FFMPEG_MAX_THREADS),
      "-i", inputPath,
    ];

    if (keepAudio) {
      // Ambil video stream pertama + audio stream pertama (kalau ada).
      // "?" di akhir map bikin ffmpeg tidak error kalau videonya ternyata
      // tidak punya audio track sama sekali.
      args.push("-map", "0:v:0", "-map", "0:a:0?");
      args.push("-vf", buildVideoFilter(fps, width));
      args.push("-c:a", "aac", "-b:a", "128k");
    } else {
      // Ambil HANYA video stream pertama, abaikan semua audio/subtitle track apapun
      args.push("-map", "0:v:0");
      args.push("-vf", buildVideoFilter(fps, width));
      args.push("-an"); // animasi harus tanpa suara (double safety bareng -map di atas)
    }

    args.push(
      "-c:v", "libx264",
      "-preset", preset,
      "-crf", crf,
      "-pix_fmt", "yuv420p", // WAJIB: format warna paling kompatibel, ini yang mencegah bug blok warna solid
      "-movflags", "+faststart", // biar bisa langsung diputar/di-loop tanpa nunggu seluruh file
      outputPath
    );

    let proc;
    let timedOut = false;
    try {
      proc = spawn("ffmpeg", args);
    } catch (e) {
      return reject(new Error("ffmpeg belum terinstall. Jalankan: pkg install ffmpeg"));
    }

    // Turunkan prioritas proses ffmpeg (nilai nice 19 = paling rendah di Linux/
    // Android/Termux). Ini bikin sistem tetap responsif (tidak hang) karena
    // ffmpeg "mengalah" duluan kalau CPU sedang diperlukan proses lain,
    // dibanding berebut penuh dan bikin seluruh HP macet.
    try {
      os.setPriority(proc.pid, 19);
    } catch (e) {
      // abaikan kalau platform tidak mengizinkan (misal bukan Linux/Termux)
    }

    // Safety net: kalau render kelamaan (video berat/kompleks di HP), matikan
    // proses paksa alih-alih membiarkan CPU terus terkuras tanpa kepastian.
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, TOGIF_FFMPEG_TIMEOUT_MS);

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      const str = chunk.toString();
      stderr += str;

      if (totalDurationSeconds && onProgress) {
        const m = str.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (m) {
          const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
          const pct = Math.min(99, (seconds / totalDurationSeconds) * 100);
          onProgress(pct);
        }
      }
    });

    proc.on("error", () => {
      clearTimeout(timeoutTimer);
      reject(new Error("ffmpeg belum terinstall. Jalankan: pkg install ffmpeg"));
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutTimer);
      if (timedOut) {
        return reject(
          new Error(
            "Konversi dibatalkan otomatis karena kelamaan/terlalu berat untuk HP ini. Coba turunkan fps/lebar atau pakai video yang lebih pendek."
          )
        );
      }
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        reject(new Error(stderr.trim().split("\n").pop() || `ffmpeg gagal (kode ${code})`));
      }
    });
  });
}

// Gabungkan 1 gambar cover (statis) + 1 file audio jadi 1 video, biar Telegram
// nampilin sebagai SATU bubble (cover besar + player + progress bar), bukan
// foto & audio terpisah kayak sendPhoto+sendAudio. Frame rate output sengaja
// dibikin serendah mungkin (-r 1, cuma 1 fps) karena gambarnya statis/tidak
// pernah berubah -- render 25fps standar cuma buang-buang CPU & ukuran file
// tanpa nambah kualitas visual apa pun.
function convertImageAudioToVideo(imagePath, audioPath, outputPath, { totalDurationSeconds } = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-threads", String(FFMPEG_MAX_THREADS),
      "-loop", "1",
      "-i", imagePath,
      "-i", audioPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      // Crop+pad ke kotak 640x640 (dimensi genap wajib, lihat catatan toEven())
      // biar cover selalu rasio 1:1 rapi kayak Spotify, apa pun rasio thumbnail aslinya.
      "-vf",
      "scale=640:640:force_original_aspect_ratio=decrease,pad=640:640:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p",
      "-r", "1",
      "-c:v", "libx264",
      "-tune", "stillimage",
      "-preset", "veryfast",
      "-crf", "28",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "128k",
      "-shortest",
      "-movflags", "+faststart",
      outputPath,
    ];

    let proc;
    let timedOut = false;
    try {
      proc = spawn("ffmpeg", args);
    } catch (e) {
      return reject(new Error("ffmpeg belum terinstall. Jalankan: pkg install ffmpeg"));
    }

    try {
      os.setPriority(proc.pid, 19);
    } catch (e) {
      // abaikan kalau platform tidak mengizinkan
    }

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, TOGIF_FFMPEG_TIMEOUT_MS);

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      const str = chunk.toString();
      stderr += str;

      if (totalDurationSeconds && onProgress) {
        const match = str.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (match) {
          const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          const pct = Math.min(99, (seconds / totalDurationSeconds) * 100);
          onProgress(pct);
        }
      }
    });

    proc.on("error", () => {
      clearTimeout(timeoutTimer);
      reject(new Error("ffmpeg belum terinstall. Jalankan: pkg install ffmpeg"));
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutTimer);
      if (timedOut) {
        return reject(new Error("Konversi gambar+audio ke video dibatalkan otomatis karena kelamaan."));
      }
      if (code === 0 && fs.existsSync(outputPath)) {
        resolve();
      } else {
        reject(new Error(stderr.trim().split("\n").pop() || `ffmpeg gagal (kode ${code})`));
      }
    });
  });
}

// Render GIF, lalu cek ukuran file hasil. Kalau kelewat limit upload
// Telegram, otomatis turunkan fps & lebar (dan render ulang) sampai muat,
// maksimal MAX_GIF_RENDER_ATTEMPTS kali. Mengembalikan fps/width/size final
// yang benar-benar dipakai, supaya caption ke user akurat kalau ada penurunan.
async function renderGifWithFallback(inputPath, outputPath, { fps, width, totalDurationSeconds, highQuality, keepAudio }, progress) {
  let currentFps = fps;
  let currentWidth = width;
  // Kalau harus retry karena kegedean, langsung pakai filter ringan (bukan
  // cuma turun fps/lebar) -- filter premium lebih boros memori & biasanya
  // bukan alasan utama kegedean, jadi tidak perlu dipertahankan di retry.
  let currentHighQuality = highQuality;

  for (let attempt = 0; attempt < MAX_GIF_RENDER_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      currentFps = Math.max(MIN_GIF_FPS, Math.round(currentFps * 0.7));
      currentWidth = toEven(Math.max(MIN_GIF_WIDTH, Math.round(currentWidth * 0.8)));
      currentHighQuality = false;
      await progress.update(
        50,
        `File kelewat besar, menurunkan kualitas ke ${currentFps}fps/${currentWidth}px & render ulang...`
      );
    }

    if (totalDurationSeconds) {
      await convertVideoToGif(
        inputPath,
        outputPath,
        { fps: currentFps, width: currentWidth, totalDurationSeconds, highQuality: currentHighQuality, keepAudio },
        (pctOfConversion) => progress.update(48 + (pctOfConversion / 100) * 47, "Merender...")
      );
    } else {
      const stopSim = simulateProgress(progress, { max: 95, stepMs: 400 });
      try {
        await convertVideoToGif(inputPath, outputPath, {
          fps: currentFps,
          width: currentWidth,
          highQuality: currentHighQuality,
          keepAudio,
        });
      } finally {
        stopSim();
      }
    }

    const size = fs.statSync(outputPath).size;
    if (size <= TELEGRAM_ANIMATION_MAX_BYTES || (currentFps <= MIN_GIF_FPS && currentWidth <= MIN_GIF_WIDTH)) {
      return { fps: currentFps, width: currentWidth, size };
    }
  }

  const stat = fs.statSync(outputPath);
  return { fps: currentFps, width: currentWidth, size: stat.size };
}

async function handleToGifRequest(msg, source, opts = {}) {
  return handleConvertRequest(msg, source, opts, { keepAudio: false });
}

async function handleToVideoRequest(msg, source, opts = {}) {
  return handleConvertRequest(msg, source, opts, { keepAudio: true });
}

async function handleConvertRequest(msg, source, opts = {}, { keepAudio }) {
  const chatId = msg.chat.id;
  let progress;
  let inputPath;
  let outputPath;
  let stopSim = null;

  const requestedFps = clamp(opts.fps || DEFAULT_GIF_FPS, MIN_GIF_FPS, MAX_GIF_FPS);
  const requestedWidth = clamp(opts.width || DEFAULT_GIF_WIDTH, MIN_GIF_WIDTH, MAX_GIF_WIDTH);
  const label = keepAudio ? "video (dengan suara)" : "GIF";
  const commandName = keepAudio ? "/tovideo" : "/togif";

  try {
    if (source.duration && source.duration > MAX_TOGIF_DURATION_SECONDS) {
      return bot.sendMessage(
        chatId,
        `⚠️ Video terlalu panjang (${source.duration}s). Maksimal ${MAX_TOGIF_DURATION_SECONDS} detik untuk dikonversi ke ${label}.`
      );
    }

    const safe = getSafeGifSettings(requestedFps, requestedWidth, source.duration);
    const fps = safe.fps;
    const width = safe.width;

    await callTelegramWithRetry(() => bot.sendChatAction(chatId, "typing"), { label: "convert sendChatAction" });
    progress = createProgressUpdater(chatId, `Mengonversi video ke ${label}...`);

    let startNote = "";
    if (heavyJobQueueWaiting > 0) {
      startNote += `Ada ${heavyJobQueueWaiting} proses berat lain di antrian (termasuk TikTok/musik/video), menunggu giliran dulu. `;
    }
    if (safe.wasCapped) {
      startNote += `Video ${source.duration}s cukup panjang, kualitas otomatis diset ke ${fps}fps/${width}px biar aman buat HP. `;
    }
    await progress.start(0, startNote.trim() || "Mengunduh video...");

    // Download video dari Telegram. Progress fase ini disimulasikan karena
    // node-telegram-bot-api tidak expose progress asli untuk downloadFile().
    stopSim = simulateProgress(progress, { max: 45, stepMs: 350 });
    try {
      inputPath = await callTelegramWithRetry(() => bot.downloadFile(source.file_id, tempDir), {
        label: "convert downloadFile",
      });
    } finally {
      if (stopSim) stopSim();
      stopSim = null;
    }

    await progress.update(48, "Video terunduh, memulai konversi...");
    await callTelegramWithRetry(() => bot.sendChatAction(chatId, "upload_video"), {
      label: "convert sendChatAction upload",
    });

    outputPath = path.join(tempDir, `${keepAudio ? "tovideo" : "togif"}_${Date.now()}.mp4`);

    // Antri, biar tidak ada beberapa ffmpeg berat jalan bersamaan yang bisa
    // bikin HP hang. Kalau sedang ada proses lain, tunggu giliran dulu.
    const { resultPromise } = runHeavyJobQueued(() =>
      renderGifWithFallback(
        inputPath,
        outputPath,
        { fps, width, totalDurationSeconds: source.duration, highQuality: safe.highQuality, keepAudio },
        progress
      )
    );
    const result = await resultPromise;

    if (result.size > TELEGRAM_ANIMATION_MAX_BYTES) {
      const sizeMb = (result.size / (1024 * 1024)).toFixed(1);
      throw new Error(
        `Hasil ${label} tetap ${sizeMb}MB (>50MB) walau kualitas sudah diturunkan ke ${result.fps}fps/${result.width}px. ` +
          `Coba pakai video yang lebih pendek, atau atur manual: ${commandName} <fps> <lebar> dengan nilai lebih kecil.`
      );
    }

    await progress.update(97, "Mengirim...");

    const sizeMb = (result.size / (1024 * 1024)).toFixed(1);

    if (keepAudio) {
      await callTelegramWithRetry(
        () =>
          bot.sendVideo(
            chatId,
            fs.createReadStream(outputPath),
            {
              caption: `🎬 <b>Video (dengan suara)</b>\n⚙️ ${result.fps}fps · lebar ${result.width}px · ${sizeMb}MB`,
              parse_mode: "HTML",
              support_streaming: true,
            },
            { filename: path.basename(outputPath), contentType: "video/mp4" }
          ),
        { label: "tovideo sendVideo", maxRetries: 3 }
      );
    } else {
      await callTelegramWithRetry(
        () =>
          bot.sendAnimation(
            chatId,
            fs.createReadStream(outputPath),
            {
              caption: `🎞️ <b>Video → GIF</b>\n⚙️ ${result.fps}fps · lebar ${result.width}px · ${sizeMb}MB`,
              parse_mode: "HTML",
            },
            // fileOptions: pastikan Telegram terima ini sebagai MP4 (bukan
            // ditebak dari isi/ekstensi), biar tidak lagi lewat transcoder
            // internal Telegram yang jadi biang bug blok warna solid.
            { filename: path.basename(outputPath), contentType: "video/mp4" }
          ),
        { label: "togif sendAnimation", maxRetries: 3 }
      );
    }

    await progress.remove();
  } catch (e) {
    console.error(`Gagal konversi video ke ${label}:`, e.message);
    const retryAfter = getTelegramRetryAfterSeconds(e);
    const detail = (e.message || "unknown error").slice(0, 300).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    const errText =
      retryAfter !== null
        ? `⏳ Bot kena rate limit dari Telegram (terlalu banyak request). Coba lagi dalam ~${retryAfter} detik.`
        : `❌ Gagal mengonversi video ke ${label}.\n\n<b>Detail:</b> <code>${detail}</code>`;

    if (progress && progress.messageId) {
      await progress.replaceWith(errText);
    } else {
      bot.sendMessage(chatId, errText, { parse_mode: "HTML" });
    }
  } finally {
    if (stopSim) stopSim();
    if (inputPath) fs.unlink(inputPath, () => {});
    if (outputPath) fs.unlink(outputPath, () => {});
  }
}

// Command "/togif" dipakai sebagai reply ke video/animasi
bot.onText(TOGIF_COMMAND_REGEX, async (msg, match) => {
  const chatId = msg.chat.id;

  // Kalau dikirim sebagai caption di media, sudah ditangani di handler "message" umum
  if (msg.caption) return;

  const source = getVideoSourceFromMessage(msg.reply_to_message) || getVideoSourceFromMessage(msg);

  if (!source) {
    return bot.sendMessage(
      chatId,
      "⚠️ Reply ke video/animasi dengan <code>/togif</code>, atau kirim video dengan caption <code>/togif</code>.\n\n" +
        `Opsional atur kualitas: <code>/togif &lt;fps&gt; &lt;lebar&gt;</code> (default ${DEFAULT_GIF_FPS}fps, ${DEFAULT_GIF_WIDTH}px)\n` +
        `Maksimal ${MAX_GIF_FPS}fps, ${MAX_GIF_WIDTH}px, ${MAX_TOGIF_DURATION_SECONDS}s. Video panjang otomatis dikonversi dengan kualitas lebih rendah biar HP tidak berat/force-close.`,
      { parse_mode: "HTML" }
    );
  }

  handleToGifRequest(msg, source, {
    fps: match[1] ? parseInt(match[1], 10) : undefined,
    width: match[2] ? parseInt(match[2], 10) : undefined,
  });
});

// Command "/tovideo" -- sama seperti /togif tapi HASILNYA TETAP ADA SUARA
// dan dikirim sebagai video biasa (bukan animasi), karena tipe "animation"
// Telegram secara definisi memang tanpa suara (suara akan di-strip Telegram
// apapun yang kita kirim kalau lewat sendAnimation).
bot.onText(TOVIDEO_COMMAND_REGEX, async (msg, match) => {
  const chatId = msg.chat.id;

  // Kalau dikirim sebagai caption di media, sudah ditangani di handler "message" umum
  if (msg.caption) return;

  const source = getVideoSourceFromMessage(msg.reply_to_message) || getVideoSourceFromMessage(msg);

  if (!source) {
    return bot.sendMessage(
      chatId,
      "⚠️ Reply ke video/animasi dengan <code>/tovideo</code>, atau kirim video dengan caption <code>/tovideo</code>.\n\n" +
        `Opsional atur kualitas: <code>/tovideo &lt;fps&gt; &lt;lebar&gt;</code> (default ${DEFAULT_GIF_FPS}fps, ${DEFAULT_GIF_WIDTH}px)\n` +
        `Maksimal ${MAX_GIF_FPS}fps, ${MAX_GIF_WIDTH}px, ${MAX_TOGIF_DURATION_SECONDS}s. Hasil TETAP ADA SUARA dan dikirim sebagai video biasa (tap-to-play, bukan auto-loop seperti GIF).`,
      { parse_mode: "HTML" }
    );
  }

  handleToVideoRequest(msg, source, {
    fps: match[1] ? parseInt(match[1], 10) : undefined,
    width: match[2] ? parseInt(match[2], 10) : undefined,
  });
});


  // "actions bridge": dipakai listener message di plugin lain (tidak ada saat
  // ini) dan dibaca core lewat ctx.config untuk teks bantuan menu utama.
  ctx.config.MAX_TOGIF_DURATION_SECONDS = MAX_TOGIF_DURATION_SECONDS;

  // Kirim video/animasi dengan caption "/togif" atau "/tovideo" -> auto convert
  // (alternatif dari reply command ke media, biar tidak perlu 2 langkah).
  bot.on("message", (msg) => {
    if (!msg.caption) return;

    const togifMatch = msg.caption.match(TOGIF_COMMAND_REGEX);
    if (togifMatch) {
      const source = getVideoSourceFromMessage(msg);
      if (source) {
        handleToGifRequest(msg, source, {
          fps: togifMatch[1] ? parseInt(togifMatch[1], 10) : undefined,
          width: togifMatch[2] ? parseInt(togifMatch[2], 10) : undefined,
        });
      }
    }

    const tovideoMatch = msg.caption.match(TOVIDEO_COMMAND_REGEX);
    if (tovideoMatch) {
      const source = getVideoSourceFromMessage(msg);
      if (source) {
        handleToVideoRequest(msg, source, {
          fps: tovideoMatch[1] ? parseInt(tovideoMatch[1], 10) : undefined,
          width: tovideoMatch[2] ? parseInt(tovideoMatch[2], 10) : undefined,
        });
      }
    }
  });
};
