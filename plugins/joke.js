// ================= plugins/joke.js =================
// Fitur /joke (lelucon receh random, data lokal bukan dari API).
// getRandomJoke() di-expose lewat ctx.actions karena tombol menu utama
// (core) manggil balik fungsi ini lewat callback_data "run_joke".
module.exports = function jokePlugin(ctx) {
  const { bot } = ctx;

const JOKES = [
  "Kenapa komputer nggak pernah kedinginan? Soalnya dia punya banyak Windows. 🪟",
  "Ada anak nanya ke ayahnya, \"Yah, kenapa laut asin?\" Ayahnya jawab, \"Karena ikannya nggak pernah bilang permisi.\" 🐟",
  "Kenapa programmer nggak suka alam? Soalnya di alam banyak bug tapi susah di-debug. 🐛",
  "Apa bedanya kamu sama wifi? Wifi ada password-nya, kalau kamu nggak ada yang minta. 📶😹",
  "Kenapa ayam nyebrang jalan? Soalnya di HP-nya nongol notif \"tempat parkir kosong\" di seberang. 🐔",
  "Kenapa hantu nggak suka hujan? Takut luntur, soalnya dia putih doang, bukan waterproof. 👻",
  "Ada apa antara semut sama gula? Ya deket, soalnya semut nggak pernah diet. 🐜",
  "Kenapa HP nggak pernah bohong? Soalnya kalau baterainya abis, langsung mati beneran. 🔋",
  "Kenapa kamu nggak bisa jadi kalender? Soalnya nggak ada yang mau nempelin kamu di dinding tiap tahun. 📅",
  "Apa bedanya kamu sama tukang parkir? Tukang parkir nyariin tempat, kalau kamu nyariin alasan. 🚗",
  "Kenapa ikan nggak pernah bayar listrik? Soalnya dia tinggal di dalam air, bukan di dalam rumah. 🐠",
  "Kenapa laptop nggak pernah dimarahin guru? Soalnya dia selalu punya banyak folder rapi. 💻",
  "Ada 2 semut ketemu di jalan, yang satu nanya, \"Lo abis dari mana?\" Yang satu jawab, \"Abis dari gula, situ manis banget bikin macet.\" 🍬",
  "Kenapa kucing nggak pernah stress? Soalnya kerjaannya cuma tidur, makan, terus pura-pura nggak butuh kamu. 🐱",
  "Kenapa printer nggak pernah galau? Soalnya kalau ada masalah, dia tinggal bilang \"paper jam\" terus orang lain yang panik. 🖨️",
  "Apa makanan favorit hantu? Yang penting nggak pedes, soalnya dia nggak punya lidah. 👻🌶️",
  "Kenapa awan nggak pernah minta maaf? Soalnya dia udah biasa disalahin kalau hujan turun. ☁️",
  "Kenapa sinyal HP suka ilang pas penting? Soalnya dia juga butuh me time. 📵",
  "Apa bedanya kamu sama baterai low battery? Baterai low battery masih ngasih peringatan dulu, kalau kamu ngilang aja tiba-tiba. 🔋",
  "Kenapa nyamuk nggak pernah sepi kerjaan? Soalnya dia kerja pas orang lagi istirahat, sistemnya WFH (Work From Hidung). 🦟",
];

let lastJokeByChat = {};

function getRandomJoke(chatId) {
  if (JOKES.length === 1) return JOKES[0];
  let idx;
  do {
    idx = Math.floor(Math.random() * JOKES.length);
  } while (idx === lastJokeByChat[chatId]);
  lastJokeByChat[chatId] = idx;
  return JOKES[idx];
}

bot.onText(/^\/joke(s)?$/i, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, `😹 <b>JOKE RANDOM</b>\n\n${getRandomJoke(chatId)}`, {
    parse_mode: "HTML",
  });
});

  // actions bridge: dipanggil dari core saat tombol menu utama "run_joke" ditekan
  ctx.actions.getRandomJoke = getRandomJoke;
};
