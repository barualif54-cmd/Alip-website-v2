// ================= plugins/pinterest.js =================
// Fitur /pinterest -- sebenarnya bukan API Pinterest asli (Pinterest tidak
// punya API publik gratis), tapi gabungan Wallhaven + Safebooru yang
// hasilnya mirip (galeri wallpaper/gambar anime). Nama command tetap
// dipertahankan "/pinterest" persis seperti bot lama biar tidak bingungin user.
module.exports = function pinterestPlugin(ctx) {
  const { bot, createProgressUpdater, simulateProgress } = ctx;


// Pinterest tidak menyediakan API publik gratis dan memblokir scraping ke
// endpoint internalnya. Sebagai gantinya kita pakai Wallhaven (situs
// wallpaper umum & anime, API resmi & gratis, tidak wajib API key untuk
// hasil SFW) sebagai sumber utama, ditambah Safebooru khusus untuk
// pencarian nama karakter anime yang tidak terjangkau Wallhaven.

// Kata-kata umum yang tidak berguna buat scoring relevansi (stopwords ID/EN sederhana)
const RELEVANCE_STOPWORDS = new Set([
  "yang", "dan", "di", "ke", "dari", "untuk", "dengan", "the", "a", "an", "of", "in", "on",
]);

// Mengembalikan skor DAN rasio kata kunci yang benar-benar match ke tag.
// Rasio ini yang dipakai untuk menentukan tier relevansi (STRONG/WEAK),
// bukan skor mentah — supaya query beberapa kata (mis. "kucing lucu tidur")
// tidak dianggap "match kuat" cuma karena SATU kata ("kucing") nyambung,
// sementara kata lain ("lucu", "tidur") sama sekali tidak ada di tag.
function relevanceScore(query, tags) {
  const queryWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !RELEVANCE_STOPWORDS.has(w));
  const tagWords = (tags || "").toLowerCase().replace(/_/g, " ");

  if (!queryWords.length) return { score: 0, ratio: 0 };

  let score = 0;
  let matchedWords = 0;
  for (const w of queryWords) {
    // exact word match dihitung lebih tinggi daripada cuma substring
    const wordBoundary = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (wordBoundary.test(tagWords)) {
      score += 2;
      matchedWords += 1;
    } else if (tagWords.includes(w)) {
      score += 1;
      matchedWords += 0.5; // substring dihitung setengah untuk rasio
    }
  }
  return { score, ratio: matchedWords / queryWords.length };
}

// Ubah hasil array dari 1 sumber jadi list dengan skor "rank".
// PENTING: kecocokan kata kunci (bonus) dijadikan faktor UTAMA, sedangkan
// urutan asli dari API cuma dipakai sebagai tie-breaker kecil. Sebelumnya
// urutan asli API yang dominan, akibatnya gambar yang sama sekali tidak
// nyambung dengan kata kunci bisa naik ke atas cuma karena kebetulan jadi
// hasil ke-1/ke-2 dari salah satu sumber (apalagi kalau sumber itu cuma
// punya sedikit hasil). Sekarang rank asli dari API cuma nambah skor kecil
// (0..1) sebagai pembeda tipis antar gambar yang relevansinya sama.
function withRankScore(items) {
  const n = items.length;
  return items.map((item, i) => ({
    ...item,
    // bonus (kecocokan kata kunci) dikali besar supaya jadi faktor dominan,
    // rank asli dari API cuma nambah skor kecil (0..1) sebagai tie-breaker
    score: (item.bonus || 0) * 10 + (n ? (n - i) / n : 0),
  }));
}

// STRONG = mayoritas kata kunci (>=60%) benar-benar ada di tag gambar.
// Angka ini yang menentukan apakah sebuah gambar dianggap "cocok" atau tidak.
const STRONG_MATCH_RATIO = 0.6;

// Tag/koleksi di Wallhaven & Safebooru mayoritas bahasa Inggris, walaupun
// user mencari pakai kata Indonesia. Kalau query Indonesia dipakai apa
// adanya, pencarian bisa nihil hasil. Makanya query diterjemahkan dulu ke
// Inggris pakai MyMemory (API gratis, tanpa API key) sebagai query
// CADANGAN kalau pencarian dengan query asli tidak membuahkan hasil.
// Kalau terjemahan gagal, cukup lanjut pakai query asli saja.
async function translateToEnglish(query) {
  try {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
      query
    )}&langpair=id|en`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const translated = json?.responseData?.translatedText;
    if (!translated) return null;
    // MyMemory kadang balikin pesan error/limit sebagai "translatedText"
    if (/MYMEMORY WARNING|INVALID|QUERY LENGTH LIMIT/i.test(translated)) return null;
    return translated;
  } catch (e) {
    console.error("Translate error:", e.message);
    return null;
  }
}

// Wallhaven API: tidak wajib API key untuk hasil SFW (kalau ada, pasang di
// .env sebagai WALLHAVEN_API_KEY untuk kuota lebih tinggi & personalisasi).
// purity=100 artinya SFW-only (sfw=1, sketchy=0, nsfw=0) — WAJIB, supaya
// bot tidak pernah kirim konten dewasa. categories=111 artinya cari di
// ketiga kategori (general, anime, people) sekaligus.
const WALLHAVEN_API_KEY = process.env.WALLHAVEN_API_KEY;

async function fetchWallhaven(q) {
  const url =
    `https://wallhaven.cc/api/v1/search?q=${encodeURIComponent(q)}` +
    `&categories=111&purity=100&sorting=relevance&per_page=50` +
    (WALLHAVEN_API_KEY ? `&apikey=${encodeURIComponent(WALLHAVEN_API_KEY)}` : "");

  const res = await fetch(url);
  console.log("[Wallhaven DEBUG] status:", res.status, "query:", q);
  if (!res.ok) return [];

  let json;
  try {
    json = await res.json();
  } catch (e) {
    return [];
  }
  return Array.isArray(json.data) ? json.data : [];
}

async function searchWallhaven(query) {
  // Coba pakai query ASLI dulu (Wallhaven cukup sering nyambung ke istilah
  // umum/nama karakter walau ditulis campur bahasa). Kalau nihil, baru
  // coba pakai hasil terjemahan Inggris sebagai cadangan.
  let hits = await fetchWallhaven(query);
  console.log("[Wallhaven DEBUG] jumlah hasil (query asli):", hits.length);

  if (!hits.length) {
    const translatedQuery = await translateToEnglish(query);
    if (translatedQuery && translatedQuery.toLowerCase() !== query.toLowerCase()) {
      hits = await fetchWallhaven(translatedQuery);
      console.log("[Wallhaven DEBUG] jumlah hasil (query terjemahan):", hits.length);
    }
  }

  // PENTING: Wallhaven TIDAK mengembalikan daftar tag di endpoint search
  // (tag lengkap cuma bisa diambil per-gambar lewat request terpisah, dan
  // itu boros quota/rate-limit). Jadi kita tidak bisa menghitung rasio kata
  // kunci sendiri seperti di Pixabay/Safebooru — kita percayakan relevansi
  // ke mesin pencari Wallhaven sendiri (parameter sorting=relevance di
  // atas), dan kasih ratio tinggi supaya lolos filter tier di bawah.
  const items = hits
    .map((h, i) => ({
      url: h.path,
      title: `wallhaven-${h.id}`,
      source: "wallhaven",
      bonus: 20,
      // ratio dibuat menurun tipis berdasar urutan, biar tetap ke-anggap
      // STRONG (>=0.6) tapi urutan asli dari Wallhaven tetap kepakai
      ratio: Math.max(0.6, 1 - i * 0.005),
    }))
    .filter((p) => p.url);

  return withRankScore(items);
}

// ================= SUMBER TAMBAHAN: SAFEBOORU (khusus anime/karakter) =================
// Pixabay itu stock foto & ilustrasi umum — dia TIDAK punya data nama
// karakter anime/fandom sama sekali (mis. "alya", "zenitsu", dsb). Kalau
// user cari nama karakter, Pixabay cuma bisa nyambung ke kata umum seperti
// "anime" dan mengabaikan nama karakternya, jadi hasilnya ngasal.
// Safebooru adalah situs khusus gambar anime dengan API gratis (tanpa API
// key) yang tag-nya memang berisi nama-nama karakter, dan sudah otomatis
// SFW-only (beda dari Danbooru/Gelbooru yang bisa NSFW).
const SAFEBOORU_GENERIC_WORDS = new Set([
  "anime", "gambar", "foto", "pinterest", "wallpaper", "hd", "aesthetic", "art",
]);

async function searchSafebooru(query) {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !RELEVANCE_STOPWORDS.has(w));

  // Kata-kata generik (mis. "anime") dibuang dulu dari tag pencarian karena
  // Safebooru memang isinya anime semua — pakai kata itu sebagai tag cuma
  // bikin hasil melebar, bukan makin presisi. Kalau semua kata ternyata
  // generik (tidak ada nama spesifik tersisa), fitur ini dilewati saja.
  const specificWords = words.filter((w) => !SAFEBOORU_GENERIC_WORDS.has(w));
  if (!specificWords.length) return [];

  // "*" di tiap kata bikin Safebooru mencari tag yang MENGANDUNG kata itu,
  // bukan cuma yang PERSIS sama — penting karena tag karakter biasanya
  // gabungan nama, mis. "kujou_alya", bukan cuma "alya".
  const tags = specificWords.map((w) => `${encodeURIComponent(w)}*`).join("+");
  const url =
    `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1` +
    `&limit=50&tags=${tags}`;

  let hits;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const text = await res.text();
    // Safebooru kadang balikin string kosong (bukan JSON valid) kalau hasil nihil
    hits = text ? JSON.parse(text) : [];
  } catch (e) {
    console.error("Safebooru error:", e.message);
    return [];
  }

  if (!Array.isArray(hits)) return [];
  console.log("[Safebooru DEBUG] jumlah hasil ditemukan:", hits.length);

  const items = hits
    .map((h) => {
      const fileUrl =
        h.file_url || (h.directory && h.image ? `https://safebooru.org/images/${h.directory}/${h.image}` : null);
      const { score, ratio } = relevanceScore(query, h.tags);
      return {
        url: fileUrl,
        title: h.tags || "",
        source: "safebooru",
        bonus: score,
        ratio,
      };
    })
    .filter((p) => p.url);

  return withRankScore(items);
}

async function searchPinterest(query) {
  const [wallhavenResults, safebooruResults] = await Promise.all([
    searchWallhaven(query).catch((e) => {
      console.error("Wallhaven error:", e.message);
      return [];
    }),
    searchSafebooru(query).catch((e) => {
      console.error("Safebooru error:", e.message);
      return [];
    }),
  ]);

  console.log(`[Search] Wallhaven: ${wallhavenResults.length}, Safebooru: ${safebooruResults.length}`);

  // Urutkan berdasarkan skor (kecocokan kata kunci sebagai faktor utama,
  // rank asli dari API masing-masing cuma jadi tie-breaker kecil).
  const combined = [...wallhavenResults, ...safebooruResults];
  combined.sort((a, b) => b.score - a.score);

  const unique = Array.from(new Map(combined.map((p) => [p.url, p])).values());

  if (!unique.length) {
    throw new Error("Tidak ada hasil untuk kata kunci tersebut.");
  }

  // Filter berbasis RASIO kata kunci yang match ke tag (bukan cuma skor
  // mentah), supaya gambar yang cuma nyambung ke 1 dari beberapa kata tidak
  // ikut lolos sebagai "cocok". PENTING: sudah tidak ada lagi fallback ke
  // "semua hasil tanpa filter" — kalau memang tidak ada gambar yang cukup
  // relevan, bot lebih baik bilang "tidak ditemukan" daripada kirim gambar
  // yang tidak nyambung ke kata kunci.
  const strong = unique.filter((p) => (p.ratio || 0) >= STRONG_MATCH_RATIO);
  const weak = unique.filter((p) => (p.ratio || 0) > 0);
  const finalResults = strong.length ? strong : weak;

  if (!finalResults.length) {
    throw new Error("Tidak ada gambar yang cukup relevan dengan kata kunci tersebut.");
  }

  return finalResults;
}

bot.onText(/^\/pinterest (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const query = match[1];

  await bot.sendChatAction(chatId, "upload_photo");

  // Kirim notif progress 1-100% dulu, biar user tahu bot lagi proses.
  // Karena pencarian ini gabungan beberapa API (Wallhaven + Safebooru) tanpa
  // ukuran total yang pasti, persennya disimulasikan naik bertahap sambil nunggu.
  let searchingMsg;
  let stopSim = () => {};
  try {
    searchingMsg = createProgressUpdater(chatId, `Mencari gambar untuk "${query}"...`);
    await searchingMsg.start(0);
    stopSim = simulateProgress(searchingMsg, { max: 90, stepMs: 400 });
  } catch (e) {
    // kalau gagal kirim notif, lanjut aja tanpa notif
  }

  try {
    const results = await searchPinterest(query);
    stopSim();

    if (!results.length) {
      if (searchingMsg) {
        await searchingMsg.remove();
      }
      return bot.sendMessage(chatId, "❌ Gambar tidak ditemukan untuk: " + query);
    }
    if (searchingMsg) await searchingMsg.update(95, "Mengirim hasil...");

    // Kirim maksimal 10 gambar sekaligus sebagai album (batas Telegram untuk media group)
    const chosen = results.slice(0, 10);
    const media = chosen.map((item, i) => ({
      type: "photo",
      media: item.url,
      ...(i === 0
        ? {
            caption: `🖼️ <b>Hasil pencarian:</b> ${query}`,
            parse_mode: "HTML",
          }
        : {}),
    }));

    await bot.sendChatAction(chatId, "upload_photo");

    try {
      await bot.sendMediaGroup(chatId, media);
    } catch (err) {
      // Kalau ada URL yang mati dan bikin album gagal total, coba buang satu-satu
      // gambar yang bermasalah lalu kirim ulang sebagai album (bukan kirim satuan)
      console.error("sendMediaGroup gagal, coba kirim ulang tanpa gambar bermasalah:", err.message);

      let sentViaGroup = false;
      // Coba kirim album dengan jumlah gambar yang dikurangi bertahap
      for (let n = chosen.length - 1; n >= 2; n--) {
        try {
          await bot.sendMediaGroup(chatId, media.slice(0, n));
          sentViaGroup = true;
          break;
        } catch (e2) {
          continue;
        }
      }

      // Kalau tetap gagal walau sudah dikurangi, baru fallback kirim satuan
      if (!sentViaGroup) {
        let sentAny = false;
        for (const item of chosen) {
          try {
            await bot.sendPhoto(chatId, item.url, {
              caption: `🖼️ <b>Hasil pencarian:</b> ${query}`,
              parse_mode: "HTML",
            });
            sentAny = true;
          } catch (e2) {
            continue;
          }
        }
        if (!sentAny) throw err;
      }
    }

    if (searchingMsg) {
      await searchingMsg.update(100);
    }
  } catch (e) {
    console.error(e);
    stopSim();
    if (searchingMsg) {
      await searchingMsg.remove();
    }
    if (e.message && e.message.includes("Tidak ada hasil")) {
      bot.sendMessage(chatId, `❌ Gambar tidak ditemukan untuk: ${query}`);
    } else if (e.message && e.message.includes("cukup relevan")) {
      bot.sendMessage(
        chatId,
        `❌ Tidak ada gambar yang cukup cocok dengan "${query}". Coba kata kunci yang lebih umum atau pakai bahasa Inggris.`
      );
    } else {
      bot.sendMessage(
        chatId,
        "❌ Terjadi error saat mencari gambar. Coba kata kunci lain atau coba lagi nanti."
      );
    }
  }
});

bot.onText(/^\/pinterest$/, (msg) =>
  bot.sendMessage(msg.chat.id, "📌 Ketik: <code>/pinterest anime</code>", {
    parse_mode: "HTML",
  })
);

};
