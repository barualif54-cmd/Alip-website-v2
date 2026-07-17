# Sistem Plugin bot-3.js

File bot lama (1 file, 7.577 baris) sekarang dipecah jadi:

```
bot-3.js            <- "core": token/mode, moderasi (warn/blacklist/antilink),
                        welcome/goodbye, rules, stats, menu utama, /panel,
                        /tools, /mute /unmute, jadwal sholat, boot sequence,
                        wiring ke dashboard.js. Ini bagian yang SALING NEMPEL
                        erat & langsung terhubung ke dashboard, jadi sengaja
                        TIDAK dipisah lebih jauh (biar tidak berisiko rusak).
core/
  context.js        <- bikin objek "ctx" yang di-suntik ke semua plugin
  pluginLoader.js    <- baca folder plugins/ & pasang satu-satu ke bot
  utils.js           <- helper bersama (progress bar, retry Telegram, format)
plugins/
  ai.js, anime.js, crypto.js, episodes.js, gif.js, image.js, jam.js,
  joke.js, kurs.js, music.js, ping-serverinfo.js, pinterest.js, suit.js,
  tiktok.js, togif.js, translate.js, ttt.js, video.js
dashboard.js         <- TIDAK BERUBAH, taruh file dashboard.js kamu yang lama
                         persis di folder yang sama kayak sebelumnya
```

Total 18 fitur sekarang jadi file terpisah di `plugins/`. Sisanya (moderasi,
menu, panel admin, dashboard) tetap di `bot-3.js` karena semuanya saling
manggil & sama-sama nyambung ke dashboard — motong itu lebih jauh lagi
risikonya lebih gede daripada untungnya.

## Cara kerja singkat

1. `bot-3.js` bikin koneksi Telegram (`bot`), lalu bikin satu objek `ctx`
   (lewat `core/context.js`) yang isinya: `bot`, helper-helper umum
   (`escapeHtml`, `callTelegramWithRetry`, dll), state bersama
   (`activeClocks`, `activeGames`, dst), dan dua "papan pesan" kosong:
   `ctx.actions` dan `ctx.config`.
2. `core/pluginLoader.js` otomatis baca SEMUA file `.js` di folder
   `plugins/` dan manggil `require(file)(ctx)`.
3. Tiap file plugin daftarin command-nya sendiri (`bot.onText(...)`,
   `bot.on("message", ...)`, `bot.on("callback_query", ...)`) persis
   seperti kode aslinya — cuma sekarang dibungkus dalam
   `module.exports = function(ctx) { ... }`.

## "Actions bridge" — kalau core perlu manggil balik fungsi di plugin

Beberapa tombol menu utama (di `bot-3.js`) perlu MANGGIL fungsi yang
didefinisikan di dalam sebuah plugin (bukan cuma dengerin command).
Contoh: tombol "⏰ Jam Real-time" di menu utama manggil `startClock()`
yang aslinya ada di `plugins/jam.js`.

Solusinya: plugin yang bersangkutan nulis fungsinya ke `ctx.actions` di
baris paling bawah filenya:

```js
// di dalam plugins/jam.js
ctx.actions.startClock = startClock;
```

lalu `bot-3.js` manggilnya lewat `ctx.actions.startClock(chatId)` alih-alih
manggil `startClock(chatId)` langsung. Yang sudah pakai pola ini:

| Fungsi                  | Didefinisikan di            | Dipanggil dari core lewat         |
|--------------------------|------------------------------|-------------------------------------|
| `startClock`, `stopClock`| `plugins/jam.js`             | `ctx.actions.startClock/stopClock`  |
| `sendPing`               | `plugins/ping-serverinfo.js` | `ctx.actions.sendPing`              |
| `sendServerInfo`         | `plugins/ping-serverinfo.js` | `ctx.actions.sendServerInfo`        |
| `getRandomJoke`          | `plugins/joke.js`            | `ctx.actions.getRandomJoke`         |
| `sendTopCryptoMarket`    | `plugins/crypto.js`          | `ctx.actions.sendTopCryptoMarket`   |
| `searchAnime`            | `plugins/anime.js`           | dipakai `plugins/episodes.js`       |
| `MAX_TOGIF_DURATION_SECONDS` (angka, bukan fungsi) | `plugins/togif.js` | `ctx.config.MAX_TOGIF_DURATION_SECONDS` |

## Cara nambah plugin BARU

1. Bikin file baru di `plugins/`, misal `plugins/cuaca.js`:

```js
// plugins/cuaca.js
module.exports = function cuacaPlugin(ctx) {
  const { bot } = ctx; // ambil apa yang dibutuhin dari ctx

  bot.onText(/^\/cuaca (.+)/, async (msg, match) => {
    const kota = match[1];
    // ...logic kamu di sini...
    bot.sendMessage(msg.chat.id, `Cuaca di ${kota}: cerah ☀️`);
  });
};
```

2. Simpan filenya. **Selesai** — tidak perlu edit `bot-3.js` sama sekali,
   plugin loader otomatis nemuin & masangnya pas bot restart.
3. Kalau command barumu mau muncul juga di daftar `/` Telegram (menu
   command bawaan Telegram), tambahin satu baris di `bot-3.js` pada
   array `publicBotCommands` (cari lewat `Ctrl+F` "publicBotCommands").
   Ini satu-satunya bagian yang masih manual, sengaja dibiarin simpel
   biar tidak ada logic tambahan yang berisiko.

## Kalau plugin butuh sesuatu yang belum ada di `ctx`

Buka `core/context.js`, tambahin ke parameter `deps` dan ke objek `ctx`
yang di-return. Terus di `bot-3.js`, pas manggil `createContext({...})`,
sertain variabel itu juga.

## Kalau satu plugin error

Loader (`core/pluginLoader.js`) sengaja dibikin supaya **satu plugin yang
gagal dimuat TIDAK mematikan bot atau plugin lain** — cuma di-skip dan
dicatat di log (`❌ gagal muat plugin "xxx.js": <pesan error>`). Jadi kalau
kamu ngedit satu plugin dan salah ketik, fitur lain tetap jalan normal.

## Yang sudah ditest

Semua 18 file plugin sudah dicoba di-`require()` beneran (pakai stub
Telegram API, bukan API asli) dan berhasil ke-load semua tanpa error
("Plugin loader selesai: 18 dimuat, 0 gagal"). Yang **BELUM** bisa saya tes
di sini (karena container ini tidak ada akses internet & tidak ada
`node_modules`/token asli kamu): jalan-tidaknya tiap FITUR pas dipakai
beneran di Telegram (misal apakah `/tiktok` beneran berhasil download).
Jadi setelah kamu taruh di server/Termux kamu dan `npm install` seperti
biasa, **tolong dites satu-satu dulu** sebelum dipakai produksi, terutama
fitur yang sebelumnya sering dipakai.

## Cara pasang

1. Copot `bot-3.js` lama kamu, ganti dengan `bot-3.js` baru dari sini.
2. Taruh folder `core/` dan `plugins/` di folder yang sama (sejajar sama
   `bot-3.js`, `dashboard.js`, `.env`, `cookies.txt`, dst).
3. `dashboard.js`, `.env`, `package.json`, `node_modules/` — **tidak perlu
   diubah**, biarin persis seperti yang sudah ada.
4. Jalankan seperti biasa (`node bot-3.js` / pm2 / dst).
