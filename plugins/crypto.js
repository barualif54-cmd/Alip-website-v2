// ================= plugins/crypto.js =================
// Fitur /btc /eth /crypto /market (harga crypto realtime via CoinGecko).
// sendTopCryptoMarket() di-expose lewat ctx.actions karena tombol menu
// utama (core, callback_data "run_market") manggil balik fungsi ini.
module.exports = function cryptoPlugin(ctx) {
  const { bot } = ctx;

const CRYPTO_ALIASES = {
  btc: "bitcoin", bitcoin: "bitcoin",
  eth: "ethereum", ethereum: "ethereum",
  bnb: "binancecoin", binance: "binancecoin",
  sol: "solana", solana: "solana",
  doge: "dogecoin", dogecoin: "dogecoin",
  xrp: "ripple", ripple: "ripple",
  ada: "cardano", cardano: "cardano",
  ltc: "litecoin", litecoin: "litecoin",
  usdt: "tether", tether: "tether",
  matic: "matic-network", polygon: "matic-network",
};

const CRYPTO_LABEL = {
  bitcoin: "Bitcoin (BTC)", ethereum: "Ethereum (ETH)", binancecoin: "BNB",
  solana: "Solana (SOL)", dogecoin: "Dogecoin (DOGE)", ripple: "XRP",
  cardano: "Cardano (ADA)", litecoin: "Litecoin (LTC)", tether: "Tether (USDT)",
  "matic-network": "Polygon (MATIC)",
};

async function getCryptoPrice(coinId) {
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}` +
    `&vs_currencies=usd,idr&include_24hr_change=true&include_market_cap=true` +
    `&include_24hr_vol=true&include_last_updated_at=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  const info = data[coinId];
  if (!info) throw new Error("koin tidak ditemukan");
  return info;
}

function formatCompactNumber(num) {
  if (num >= 1e12) return `$${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9) return `$${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `$${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `$${(num / 1e3).toFixed(2)}K`;
  return `$${num.toFixed(2)}`;
}

function buildTrendBar(change) {
  const magnitude = Math.min(Math.abs(change), 10); // cap di 10% biar bar gak overflow
  const filled = Math.max(1, Math.round((magnitude / 10) * 10));
  const empty = 10 - filled;
  const block = change >= 0 ? "▓" : "▓";
  return change >= 0
    ? "🟩".repeat(Math.min(filled, 10)) + "⬜".repeat(empty)
    : "🟥".repeat(Math.min(filled, 10)) + "⬜".repeat(empty);
}

function padRow(label, value, width = 24) {
  const text = `${label}`;
  const dots = ".".repeat(Math.max(1, width - text.length - value.length));
  return `${text}${dots}${value}`;
}

async function handleCryptoCommand(msg, coinId, label) {
  const chatId = msg.chat.id;
  try {
    const info = await getCryptoPrice(coinId);
    const change = info.usd_24h_change || 0;
    const changeIcon = change >= 0 ? "📈" : "📉";
    const changeText = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    const trendBar = buildTrendBar(change);
    const updatedTime = info.last_updated_at
      ? new Date(info.last_updated_at * 1000).toLocaleString("id-ID", {
          timeZone: "Asia/Jakarta",
          hour: "2-digit",
          minute: "2-digit",
          day: "2-digit",
          month: "short",
        })
      : "-";

    const usdStr = `$${info.usd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    const idrStr = `Rp${info.idr.toLocaleString("id-ID", { maximumFractionDigits: 0 })}`;
    const mcapStr = info.usd_market_cap ? formatCompactNumber(info.usd_market_cap) : "-";
    const volStr = info.usd_24h_vol ? formatCompactNumber(info.usd_24h_vol) : "-";

    const box =
      `┌─────────────────────────────┐\n` +
      `  🪙 ${label}\n` +
      `├─────────────────────────────┤\n` +
      `  ${padRow("USD", usdStr)}\n` +
      `  ${padRow("IDR", idrStr)}\n` +
      `  ${padRow("24h", `${changeIcon} ${changeText}`)}\n` +
      `  ${padRow("MCap", mcapStr)}\n` +
      `  ${padRow("Vol", volStr)}\n` +
      `├─────────────────────────────┤\n` +
      `  ${trendBar}\n` +
      `└─────────────────────────────┘\n` +
      `  Updated: ${updatedTime} WIB`;

    bot.sendMessage(chatId, `<pre>${box}</pre>`, { parse_mode: "HTML" });
  } catch (e) {
    console.error("⚠️ Gagal ambil harga crypto:", e.message);
    bot.sendMessage(chatId, `❌ Gagal ambil harga ${label}, coba lagi nanti.`);
  }
}

bot.onText(/^\/btc$/i, (msg) => handleCryptoCommand(msg, "bitcoin", CRYPTO_LABEL["bitcoin"]));
bot.onText(/^\/eth$/i, (msg) => handleCryptoCommand(msg, "ethereum", CRYPTO_LABEL["ethereum"]));

bot.onText(/^\/crypto(?:\s+(\S+))?$/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const input = match[1];

  if (!input) {
    return bot.sendMessage(
      chatId,
      `ℹ️ Format: <code>/crypto btc</code>, <code>/crypto eth</code>, <code>/crypto sol</code>\n` +
        `Kode umum: BTC, ETH, BNB, SOL, DOGE, XRP, ADA, LTC, USDT, MATIC`,
      { parse_mode: "HTML" }
    );
  }

  const lower = input.toLowerCase();
  const coinId = CRYPTO_ALIASES[lower] || lower;
  const label = CRYPTO_LABEL[coinId] || input.toUpperCase();

  await handleCryptoCommand(msg, coinId, label);
});

// ================= TOP CRYPTO MARKET =================
const TOP_CRYPTO_LIST = [
  { id: "bitcoin", symbol: "BTC" },
  { id: "ethereum", symbol: "ETH" },
  { id: "solana", symbol: "SOL" },
  { id: "binancecoin", symbol: "BNB" },
  { id: "ripple", symbol: "XRP" },
];

async function getTopCryptoPrices(coinList) {
  const ids = coinList.map((c) => c.id).join(",");
  const url =
    `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}` +
    `&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

function formatUsdShort(value) {
  if (value >= 1000) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
  }
  if (value >= 1) {
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return value.toFixed(4);
}

function padMarketRow(symbol, priceStr, changeStr) {
  const symbolCol = symbol.padEnd(6);
  const priceCol = `$${priceStr}`.padEnd(11);
  return `  ${symbolCol}${priceCol}${changeStr}`;
}

async function sendTopCryptoMarket(chatId) {
  try {
    const data = await getTopCryptoPrices(TOP_CRYPTO_LIST);

    const rows = TOP_CRYPTO_LIST.map(({ id, symbol }) => {
      const info = data[id];
      if (!info) return `  ${symbol.padEnd(6)}n/a`;
      const change = info.usd_24h_change || 0;
      const icon = change >= 0 ? "📈" : "📉";
      const changeStr = `${icon} ${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
      return padMarketRow(symbol, formatUsdShort(info.usd), changeStr);
    }).join("\n");

    const updatedTime = new Date().toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "short",
    });

    const box =
      `┌─────────────────────────────┐\n` +
      `  📊 TOP CRYPTO\n` +
      `├─────────────────────────────┤\n` +
      `${rows}\n` +
      `├─────────────────────────────┤\n` +
      `  Updated: ${updatedTime} WIB\n` +
      `└─────────────────────────────┘`;

    bot.sendMessage(chatId, `<pre>${box}</pre>`, { parse_mode: "HTML" });
  } catch (e) {
    console.error("⚠️ Gagal ambil top crypto:", e.message);
    bot.sendMessage(chatId, "❌ Gagal ambil data top crypto, coba lagi nanti.");
  }
}

bot.onText(/^\/(market|top)$/i, (msg) => sendTopCryptoMarket(msg.chat.id));


  // actions bridge: dipanggil dari core saat tombol menu utama "run_market" ditekan
  ctx.actions.sendTopCryptoMarket = sendTopCryptoMarket;
};
