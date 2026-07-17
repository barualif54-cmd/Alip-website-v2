// ================= plugins/anime.js =================
// Fitur /anime (cari info anime + trailer via Kitsu API, gratis tanpa API key).
// searchAnime() di-expose lewat ctx.actions supaya plugins/episodes.js bisa
// ikut makai (fitur /episodes butuh cari ID Kitsu dulu dari judul anime).
module.exports = function animePlugin(ctx) {
  const {
    bot, escapeHtml, tempDir,
    callTelegramWithRetry, createProgressUpdater, simulateProgress,
  } = ctx;


function mapKitsuStatus(status) {
  const map = {
    current: "Sedang Tayang",
    finished: "Selesai Tayang",
    tba: "Belum Ada Jadwal",
    unreleased: "Belum Rilis",
    upcoming: "Akan Tayang",
  };
  return map[status] || status || "-";
}

async function searchAnime(query, retries = 3) {
  const url = `https://kitsu.io/api/edge/anime?filter[text]=${encodeURIComponent(
    query
  )}&page[limit]=5&include=genres`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      // Pakai fetchWithTimeout (bukan fetch polos) supaya kalau Kitsu API
      // macet/lemot, request di-abort otomatis alih-alih menggantung sampai
      // Telegram/proses lain ikut ketunda.
      res = await fetchWithTimeout(url, { headers: { Accept: "application/vnd.api+json" } }, 20000);
    } catch (e) {
      // Kalau ini percobaan terakhir, lempar error aslinya biar kelihatan
      // di log & bisa ditampilkan ke user (timeout, DNS gagal, dst).
      if (attempt === retries) throw e;
      console.warn(`[anime] fetch gagal (percobaan ${attempt + 1}/${retries + 1}): ${e.message}, mencoba lagi...`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }

    if (res.status === 429) {
      if (attempt < retries) {
        console.warn(`[anime] kena rate limit 429 (percobaan ${attempt + 1}/${retries + 1}), mencoba lagi...`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error("Kitsu API sedang rate limit (429) setelah beberapa kali percobaan.");
    }

    // 502/503/504 = error di sisi server Kitsu sendiri (gateway/upstream
    // timeout), biasanya sementara. Retry dulu sebelum dianggap gagal permanen.
    if ([502, 503, 504].includes(res.status)) {
      if (attempt < retries) {
        console.warn(`[anime] Kitsu API status ${res.status} (percobaan ${attempt + 1}/${retries + 1}), mencoba lagi...`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw new Error(`Kitsu API sedang down/lemot (status ${res.status}) setelah ${retries + 1} percobaan. Coba lagi beberapa menit lagi.`);
    }

    if (!res.ok) {
      throw new Error(`Kitsu API error: status ${res.status}`);
    }

    const json = await res.json();
    const included = json.included || [];
    const genresById = new Map(
      included.filter((i) => i.type === "genres").map((g) => [g.id, g.attributes?.name])
    );

    return (json.data || []).map((item) => normalizeKitsuAnime(item, genresById));
  }

  return [];
}

// Ubah bentuk respons Kitsu jadi objek internal yang sederhana & konsisten,
// dipakai di seluruh fitur /anime dan /episodes.
function normalizeKitsuAnime(item, genresById) {
  const a = item.attributes || {};
  const genreIds = (item.relationships?.genres?.data || []).map((g) => g.id);
  const genres = genreIds.map((id) => genresById.get(id)).filter(Boolean);

  const titleRomaji = a.canonicalTitle || a.titles?.en_jp || "-";
  const titleEnglish = a.titles?.en || null;
  const titleJapanese = a.titles?.ja_jp || null;

  const typeMap = { TV: "TV", movie: "Movie", OVA: "OVA", ONA: "ONA", special: "Special", music: "Music" };
  const type = typeMap[a.subtype] || a.subtype || "-";

  const score = a.averageRating ? (parseFloat(a.averageRating) / 10).toFixed(2) : null;
  const year = a.startDate ? a.startDate.slice(0, 4) : "-";

  const posterUrl = a.posterImage?.large || a.posterImage?.medium || a.posterImage?.original || null;

  const trailerUrl = a.youtubeVideoId ? `https://www.youtube.com/watch?v=${a.youtubeVideoId}` : null;

  return {
    id: item.id, // Kitsu ID, dipakai buat ambil daftar episode
    title: titleRomaji,
    title_english: titleEnglish,
    title_japanese: titleJapanese,
    type,
    episodes: a.episodeCount != null ? a.episodeCount : "?",
    status: mapKitsuStatus(a.status),
    score,
    year,
    genres,
    synopsis: a.synopsis,
    trailer: trailerUrl ? { url: trailerUrl, youtube_id: a.youtubeVideoId } : null,
    images: { jpg: { large_image_url: posterUrl, image_url: posterUrl } },
    url: a.slug ? `https://kitsu.io/anime/${a.slug}` : "-",
  };
}

function formatAnimeGenres(anime) {
  const genres = anime.genres || [];
  return genres.length ? genres.join(", ") : "-";
}

function buildAnimeCaption(anime) {
  const title = anime.title_english || anime.title || "-";
  const altTitle = anime.title_japanese ? `\n🈯 <i>${escapeHtml(anime.title_japanese)}</i>` : "";
  const type = anime.type || "-";
  const episodes = anime.episodes != null ? anime.episodes : "?";
  const status = anime.status || "-";
  const score = anime.score != null ? `⭐ ${anime.score}` : "⭐ -";
  const year = anime.year || "-";
  const genres = formatAnimeGenres(anime);

  // Sinopsis dipotong biar caption tidak kelewat batas 1024 karakter punya Telegram
  let synopsis = (anime.synopsis || "Sinopsis tidak tersedia.").trim();
  if (synopsis.length > 380) synopsis = synopsis.slice(0, 380).trim() + "...";

  const trailerUrl = anime.trailer?.url;

  let text =
    `🎌 <b>${escapeHtml(title)}</b>${altTitle}\n\n` +
    `📺 <b>Tipe:</b> ${escapeHtml(type)}  |  🎞️ <b>Episode:</b> ${episodes}\n` +
    `📊 <b>Status:</b> ${escapeHtml(status)}  |  📅 <b>Tahun:</b> ${year}\n` +
    `${score}  |  🏷️ <b>Genre:</b> ${escapeHtml(genres)}\n\n` +
    `📝 <b>Sinopsis:</b>\n${escapeHtml(synopsis)}\n\n`;

  text += trailerUrl
    ? `▶️ <b>Trailer:</b> ${trailerUrl}\n`
    : `▶️ <i>Trailer tidak tersedia untuk anime ini.</i>\n`;

  text += `🔗 <b>Kitsu:</b> ${anime.url || "-"}`;

  return text;
}

bot.onText(/^\/anime (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  await bot.sendChatAction(chatId, "typing");

  const progress = createProgressUpdater(chatId, `Mencari anime untuk "${query}"...`);
  await progress.start(0);
  const stopSim = simulateProgress(progress, { max: 85, stepMs: 350 });

  try {
    const results = await searchAnime(query);
    stopSim();

    if (!results.length) {
      await progress.remove();
      return bot.sendMessage(chatId, "❌ Anime tidak ditemukan untuk: " + query);
    }

    const anime = results[0];
    await progress.update(95, "Menyiapkan hasil...");

    const caption = buildAnimeCaption(anime);
    const posterUrl = anime.images?.jpg?.large_image_url || anime.images?.jpg?.image_url;

    await progress.remove();

    if (posterUrl) {
      try {
        await bot.sendPhoto(chatId, posterUrl, { caption, parse_mode: "HTML" });
      } catch (e) {
        // Fallback ke pesan teks biasa kalau kirim foto gagal (mis. caption ketolak)
        await bot.sendMessage(chatId, caption, { parse_mode: "HTML", disable_web_page_preview: false });
      }
    } else {
      await bot.sendMessage(chatId, caption, { parse_mode: "HTML", disable_web_page_preview: false });
    }

    // ===== Download trailer jadi file .mp4 & kirim langsung, bukan cuma link =====
    let trailerUrl = anime.trailer?.url;

    // Fallback: kalau Kitsu tidak punya data trailer sama sekali (sering
    // terjadi walau animenya populer), cari manual di YouTube pakai judulnya
    // biar tetap bisa kirim mp4, bukan cuma pesan "trailer tidak tersedia".
    if (!trailerUrl) {
      try {
        const searchTitle = anime.title_english || anime.title;
        const ytResult = await ytSearch(searchTitle + " official trailer");
        if (ytResult.videos.length) {
          trailerUrl = ytResult.videos[0].url;
        }
      } catch (e) {
        console.error("Gagal fallback cari trailer via yt-search:", e.message);
      }
    }

    if (trailerUrl) {
      const dlProgress = createProgressUpdater(chatId, `Mengunduh trailer: ${anime.title_english || anime.title}`);
      await dlProgress.start(0, "Menyiapkan unduhan...");

      const baseName = `anime_${Date.now()}_${anime.id}`;
      const outputTemplate = path.join(tempDir, `${baseName}.%(ext)s`);

      try {
        await bot.sendChatAction(chatId, "upload_video");

        // yt-dlp lapor 0-100% untuk proses download; sisakan sedikit ruang
        // (max 92%) buat proses merge & kirim file ke Telegram.
        // Diantri bareng /togif, /tovideo, TikTok downloader, dan /music
        // supaya tidak ada beberapa proses berat jalan bersamaan.
        const { resultPromise } = runHeavyJobQueued(() =>
          downloadAsMp4(trailerUrl, outputTemplate, (pct, speedText) => {
            dlProgress.update(Math.min(92, pct), undefined, speedText).catch(() => {});
          })
        );
        await resultPromise;

        const filePath = findDownloadedFile(baseName);
        if (!filePath) throw new Error("File hasil download trailer tidak ditemukan.");

        await dlProgress.update(95, "Mengirim video...");
        await bot.sendChatAction(chatId, "upload_video");
        await callTelegramWithRetry(
          () =>
            bot.sendVideo(
              chatId,
              fs.createReadStream(filePath),
              {
                caption: `🎬 <b>Trailer:</b> ${escapeHtml(anime.title_english || anime.title)}`,
                parse_mode: "HTML",
                supports_streaming: true,
              },
              { filename: `${(anime.title_english || anime.title || "trailer")}.mp4`.replace(/[\\/:*?"<>|]/g, "") }
            ),
          { label: "anime sendVideo", maxRetries: 3 }
        );

        await dlProgress.update(100);
        fs.unlink(filePath, () => {});
        await dlProgress.remove();
      } catch (e) {
        console.error("Gagal download trailer anime:", e.message);
        // Kalau download mp4 gagal (mis. yt-dlp belum terinstall / video dibatasi),
        // fallback tetap kasih link trailer biar user masih bisa nonton manual.
        // Detail error asli ikut ditampilkan ke chat (bukan cuma console) biar
        // gampang di-diagnosa tanpa harus buka terminal server.
        const detail = (e && e.message ? e.message : String(e)).slice(0, 300);
        const safeDetail = detail.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
        await dlProgress.replaceWith(
          `⚠️ Gagal mengunduh trailer sebagai mp4.\n\n<b>Detail error:</b>\n<code>${safeDetail}</code>\n\nLink trailer: ${trailerUrl}`,
          { parse_mode: "HTML" }
        );
      }
    }

    // Kasih tahu kalau ada hasil lain yang mirip, biar user bisa cari lebih spesifik
    if (results.length > 1) {
      const others = results
        .slice(1, 5)
        .map((a) => `• ${a.title_english || a.title}`)
        .join("\n");
      await bot.sendMessage(
        chatId,
        `ℹ️ <b>Hasil lain yang mirip:</b>\n${escapeHtml(others)}\n\n<i>Coba ketik judul lebih spesifik kalau bukan ini yang dimaksud.</i>`,
        { parse_mode: "HTML" }
      );
    }
  } catch (e) {
    console.error(`Gagal cari anime (query: "${query}"):`, e.message);
    stopSim();
    await progress.remove();
    const detail = (e && e.message ? e.message : String(e)).slice(0, 300);
    const safeDetail = detail.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    bot.sendMessage(
      chatId,
      `❌ Terjadi error saat mencari anime.\n\n<b>Detail:</b>\n<code>${safeDetail}</code>\n\nCoba lagi nanti.`,
      { parse_mode: "HTML" }
    );
  }
});


// ================= DAFTAR EPISODE ANIME (Kitsu API) =================

  bot.onText(/^\/anime$/, (msg) =>
    bot.sendMessage(msg.chat.id, "⚠️ Format: <code>/anime naruto</code>", { parse_mode: "HTML" })
  );

  // actions bridge: dipakai plugins/episodes.js buat cari ID Kitsu dari judul
  ctx.actions.searchAnime = searchAnime;
};
