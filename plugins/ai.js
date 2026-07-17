// ================= plugins/ai.js =================
// Fitur /ai (nyambung ke Google Gemini API, gratis).
// escapeHtml() didefinisikan LOKAL di sini (persis lokasi aslinya di
// bot-3.js lama), BUKAN dari ctx.escapeHtml -- keduanya isinya identik,
// cuma dijaga di sini biar file ini tetap bisa ditest berdiri sendiri.
module.exports = function aiPlugin(ctx) {
  const { bot, geminiApiKey, createProgressUpdater, simulateProgress } = ctx;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Escape dulu, baru convert markdown dasar (**bold**, *italic*, `code`) ke tag HTML Telegram
function formatAiReplyForTelegram(text) {
  let out = escapeHtml(text);
  out = out
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|\s)\*(?!\*)([^*\n]+?)\*(?=\s|$)/g, "$1<i>$2</i>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
  return out;
}

// Panggil Google Gemini API (gratis, tanpa kartu kredit)
async function askAI(question) {
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY_MISSING");
  }

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": geminiApiKey,
    },
    body: JSON.stringify({
      system_instruction: {
        parts: [
          {
            text: "Kamu adalah asisten AI di dalam bot Telegram. Jawab singkat, jelas, dan ramah. Gunakan Bahasa Indonesia kecuali user bertanya dalam bahasa lain.",
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text: question }] }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    console.error(`Gemini API error ${res.status}:`, errBody.slice(0, 300));
    throw new Error(`GEMINI_API_ERROR_${res.status}`);
  }

  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  const parts = candidate && candidate.content && candidate.content.parts;
  const text = (parts || [])
    .map((p) => p.text || "")
    .join("\n\n")
    .trim();

  // Kalau jawaban kosong, biasanya karena kena filter keamanan Gemini
  if (!text) {
    const reason = candidate && candidate.finishReason;
    if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT") {
      return "(Maaf, pertanyaan ini diblokir oleh filter keamanan Gemini. Coba pertanyaan lain.)";
    }
    return "(AI tidak memberikan jawaban teks)";
  }

  return text;
}

// Garis pembatas biar tampilan AI rapi tanpa bikin pesan kepanjangan
const AI_DIVIDER = "┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄";

function buildAiResultText(question, answer) {
  return (
    `🤖 <b>AI ASSISTANT</b>\n` +
    `${AI_DIVIDER}\n` +
    `❔ <b>Pertanyaan:</b>\n${escapeHtml(question)}\n\n` +
    `💬 <b>Jawaban:</b>\n${formatAiReplyForTelegram(answer)}\n` +
    `${AI_DIVIDER}\n` +
    `<i>⚡ Dijawab oleh Google Gemini</i>`
  );
}

bot.onText(/^\/ai (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const question = match[1];

  await bot.sendChatAction(chatId, "typing");

  // Kirim notif progress 1-100% dulu, nanti pesan ini di-edit jadi hasil akhir.
  // Karena manggil Gemini cuma 1x request tanpa progress asli, persennya
  // disimulasikan naik bertahap sambil nunggu jawaban selesai disusun.
  const progress = createProgressUpdater(chatId, "Sedang mencari jawaban...");
  let hasProgress = true;
  try {
    await progress.start(0, `Pertanyaan: ${question}`);
  } catch (e) {
    hasProgress = false;
    console.error("Gagal kirim notif pencarian AI:", e.message);
  }
  const stopSim = hasProgress ? simulateProgress(progress, { max: 90, stepMs: 500 }) : () => {};

  try {
    const answer = await askAI(question);
    stopSim();

    const text = buildAiResultText(question, answer);

    if (hasProgress) {
      await progress.remove();
    }
    await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch (e) {
    stopSim();
    console.error("AI error:", e.message);

    let errText = "❌ AI error, coba lagi.";
    if (e.message === "GEMINI_API_KEY_MISSING") {
      errText =
        "❌ Fitur AI belum aktif. Tambahkan <code>GEMINI_API_KEY=xxxx</code> di file .env lalu restart bot.\n\nAmbil API key GRATIS di https://aistudio.google.com/apikey";
    } else if (e.message.startsWith("GEMINI_API_ERROR_400") || e.message.startsWith("GEMINI_API_ERROR_403")) {
      errText = "❌ API key Gemini tidak valid / tidak punya akses. Cek lagi GEMINI_API_KEY di .env.";
    } else if (e.message.startsWith("GEMINI_API_ERROR_429")) {
      errText = "⏳ Kena limit gratis Gemini (request per menit/hari). Coba lagi sebentar lagi.";
    }

    if (hasProgress) {
      await progress.replaceWith(errText).catch(() => bot.sendMessage(chatId, errText, { parse_mode: "HTML" }));
    } else {
      await bot.sendMessage(chatId, errText, { parse_mode: "HTML" });
    }
  }
});

  bot.onText(/^\/ai$/, (msg) =>
    bot.sendMessage(msg.chat.id, "⚠️ Format: <code>/ai pertanyaan kamu</code>", { parse_mode: "HTML" })
  );
};
