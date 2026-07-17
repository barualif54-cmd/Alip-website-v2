// ================= plugins/kurs.js =================
// Fitur /kurs (cek kurs mata uang ke Rupiah).
module.exports = function kursPlugin(ctx) {
  const { bot } = ctx;

const KURS_ALIASES = {
  dolar: "USD", dollar: "USD", usd: "USD",
  euro: "EUR", eur: "EUR",
  yen: "JPY", jpy: "JPY",
  yuan: "CNY", cny: "CNY", rmb: "CNY",
  won: "KRW", krw: "KRW",
  ringgit: "MYR", myr: "MYR",
  riyal: "SAR", sar: "SAR", real: "SAR",
  poundsterling: "GBP", pound: "GBP", gbp: "GBP",
  sgd: "SGD", dolarsingapura: "SGD",
  aud: "AUD", dolarozstralia: "AUD", dolaraustralia: "AUD",
};

function resolveKursCode(input) {
  const lower = input.toLowerCase().replace(/\s+/g, "");
  return KURS_ALIASES[lower] || input.toUpperCase();
}

async function getKurs(fromCode) {
  const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(fromCode)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  if (data.result !== "success") throw new Error("kode mata uang tidak valid");
  const rate = data.rates.IDR;
  if (!rate) throw new Error("rate IDR tidak ditemukan");
  return { rate, updated: data.time_last_update_utc };
}

bot.onText(/^\/kurs(?:\s+(\S+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1];

  if (!input) {
    return bot.sendMessage(
      chatId,
      `ℹ️ Format: <code>/kurs usd</code>, <code>/kurs euro</code>, <code>/kurs yen</code>\n` +
        `Kode umum: USD, EUR, JPY, CNY, KRW, MYR, SAR, GBP, SGD, AUD`,
      { parse_mode: "HTML" }
    );
  }

  const code = resolveKursCode(input);

  try {
    const { rate, updated } = await getKurs(code);
    const updatedTime = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    });
    const rateStr = `Rp${rate.toLocaleString("id-ID", { maximumFractionDigits: 2 })}`;

    const box =
      `┌─────────────────────────────┐\n` +
      `  💱 KURS ${code} ➜ IDR\n` +
      `├─────────────────────────────┤\n` +
      `  ${padRow("1 " + code, rateStr)}\n` +
      `├─────────────────────────────┤\n` +
      `  Updated: ${updatedTime} WIB\n` +
      `└─────────────────────────────┘`;

    bot.sendMessage(chatId, `<pre>${box}</pre>`, { parse_mode: "HTML" });
  } catch (e) {
    console.error("⚠️ Gagal ambil kurs:", e.message);
    bot.sendMessage(chatId, `❌ Gagal ambil kurs untuk "${input}". Cek lagi kode mata uangnya.`);
  }
});

};
