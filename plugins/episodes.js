// ================= plugins/episodes.js =================
// Fitur /episodes (daftar episode + tanggal tayang + link nonton resmi).
// Butuh searchAnime() dari plugins/anime.js -- diakses lewat ctx.actions
// (lihat "actions bridge" di core/context.js) supaya plugin ini tidak perlu
// require file plugin lain secara langsung.
module.exports = function episodesPlugin(ctx) {
  const { bot, escapeHtml, createProgressUpdater, simulateProgress } = ctx;

  // Alias lokal, dipanggil di dalam handler (bukan saat plugin ini dimuat)
  // supaya urutan file plugin ke-load tidak masalah.
  function searchAnime(query) {
    return ctx.actions.searchAnime(query);
  }

async function getAnimeEpisodesPage(kitsuId, offset = 0, limit = 20, retries = 3) {
  const url = `https://kitsu.io/api/edge/anime/${kitsuId}/episodes?page[limit]=${limit}&page[offset]=${offset}&sort=number`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchWithTimeout(url, { headers: { Accept: "application/vnd.api+json" } }, 20000);

    if (res.status === 429) {
      if (attempt < retries) {
        console.warn(`[episodes] kena rate limit 429 (percobaan ${attempt + 1}/${retries + 1}), mencoba lagi...`);
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error("Kitsu API sedang rate limit (429) setelah beberapa kali percobaan.");
    }
    if (res.status === 404) {
      return { data: [], hasNextPage: false };
    }
    if ([502, 503, 504].includes(res.status)) {
      if (attempt < retries) {
        console.warn(`[episodes] Kitsu API status ${res.status} (percobaan ${attempt + 1}/${retries + 1}), mencoba lagi...`);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw new Error(`Kitsu API sedang down/lemot (status ${res.status}) setelah ${retries + 1} percobaan. Coba lagi beberapa menit lagi.`);
    }
    if (!res.ok) {
      throw new Error(`Kitsu API error: status ${res.status}`);
    }

    return await res.json().then((json) => ({
      data: (json.data || []).map((ep) => ({
        number: ep.attributes?.number,
        title: ep.attributes?.canonicalTitle || ep.attributes?.titles?.en_jp || null,
        aired: ep.attributes?.airdate || null,
      })),
      hasNextPage: !!json.links?.next,
    }));
  }
}

// Ambil episode bernomor `start` sampai `end` (Kitsu paginasi via offset/limit)
async function getAnimeEpisodesRange(kitsuId, start, end) {
  const collected = [];
  const pageSize = 20;
  let offset = Math.floor((start - 1) / pageSize) * pageSize;

  while (collected.length < end - start + 1) {
    const { data, hasNextPage } = await getAnimeEpisodesPage(kitsuId, offset, pageSize);
    if (!data.length) break;

    for (const ep of data) {
      if (ep.number != null && ep.number >= start && ep.number <= end) collected.push(ep);
    }

    if (!hasNextPage) break;
    offset += pageSize;
    if (offset > end) break;
  }

  return collected.sort((a, b) => a.number - b.number);
}

// Link "cari di platform resmi" — bukan link langsung ke episode (karena bot
// tidak tahu ketersediaan lisensi tiap platform per judul/wilayah), tapi cukup
// buat user tinggal klik lalu pilih episodenya di sana.
function buildLegalWatchLinks(title) {
  const q = encodeURIComponent(title);
  return (
    `🔗 <b>Nonton resmi (cari judul ini):</b>\n` +
    `• Crunchyroll: https://www.crunchyroll.com/search?q=${q}\n` +
    `• Muse Indonesia (YouTube): https://www.youtube.com/@MUSEIndonesia/search?query=${q}\n` +
    `• Netflix: https://www.netflix.com/search?q=${q}\n` +
    `• Vidio: https://www.vidio.com/search?q=${q}`
  );
}

bot.onText(/^\/episodes (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1].trim();

  // Format: "/episodes naruto 1-3" atau "/episodes naruto" (default 1-3)
  const rangeMatch = input.match(/(\d+)\s*-\s*(\d+)\s*$/);
  let query = input;
  let start = 1;
  let end = 3;

  if (rangeMatch) {
    start = parseInt(rangeMatch[1], 10);
    end = parseInt(rangeMatch[2], 10);
    query = input.slice(0, rangeMatch.index).trim();
  }

  if (!query) {
    return bot.sendMessage(chatId, "⚠️ Format: <code>/episodes naruto 1-3</code>", { parse_mode: "HTML" });
  }
  if (end < start) [start, end] = [end, start];
  if (end - start + 1 > 20) {
    return bot.sendMessage(chatId, "⚠️ Maksimal 20 episode sekali cek, biar tidak kena rate limit API.");
  }

  await bot.sendChatAction(chatId, "typing");
  const progress = createProgressUpdater(chatId, `Mencari episode "${query}"...`);
  await progress.start(0);
  const stopSim = simulateProgress(progress, { max: 85, stepMs: 350 });

  try {
    const results = await searchAnime(query);
    if (!results.length) {
      stopSim();
      await progress.remove();
      return bot.sendMessage(chatId, "❌ Anime tidak ditemukan untuk: " + query);
    }

    const anime = results[0];
    const title = anime.title_english || anime.title;

    await progress.update(50, "Mengambil daftar episode...");
    const episodes = await getAnimeEpisodesRange(anime.id, start, end);
    stopSim();
    await progress.remove();

    if (!episodes.length) {
      return bot.sendMessage(
        chatId,
        `❌ Data episode ${start}-${end} untuk <b>${escapeHtml(title)}</b> tidak tersedia di Kitsu.`,
        { parse_mode: "HTML" }
      );
    }

    let text = `🎌 <b>${escapeHtml(title)}</b>\n📚 <b>Episode ${start}-${end}</b>\n\n`;
    for (const ep of episodes) {
      const epTitle = ep.title || "(judul belum tersedia)";
      const aired = ep.aired ? moment(ep.aired).format("D MMM YYYY") : "-";
      text += `<b>Eps ${ep.number}:</b> ${escapeHtml(epTitle)}\n🗓️ ${aired}\n\n`;
    }
    text += buildLegalWatchLinks(title);
    text += `\n\n<i>Catatan: bot ini tidak mengirim file video episode (hak cipta), hanya info & link nonton resmi.</i>`;

    await bot.sendMessage(chatId, text, { parse_mode: "HTML", disable_web_page_preview: true });
  } catch (e) {
    console.error(`Gagal ambil episode anime (query: "${query}"):`, e.message);
    stopSim();
    await progress.remove();
    const detail = (e && e.message ? e.message : String(e)).slice(0, 300);
    const safeDetail = detail.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
    bot.sendMessage(
      chatId,
      `❌ Terjadi error saat mengambil daftar episode.\n\n<b>Detail:</b>\n<code>${safeDetail}</code>\n\nCoba lagi nanti.`,
      { parse_mode: "HTML" }
    );
  }
});

bot.onText(/^\/episodes$/, (msg) =>
  bot.sendMessage(msg.chat.id, "⚠️ Format: <code>/episodes naruto 1-3</code>", { parse_mode: "HTML" })
);
};
