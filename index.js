const { Telegraf } = require('telegraf')
const fitur = require('./yuss')
const config = require('./config')
const fs = require('fs')
const readline = require('readline-sync')
const { exec } = require('child_process')

const bot = new Telegraf(config.token)

const sempak = 'WXVzc1h5MDE='
const FILE = '.micbrew'

const clear = () => process.stdout.write('\x1Bc')

function decode(data) {
  return Buffer.from(data, 'base64').toString('utf-8')
}

function bukaWA() {
  const url = 'https://wa.me/6283183469343?text=Min%20minta%20pw%20untuk%20bot%20telegram%20v1%20dong'
  exec(`xdg-open ${url}`)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function loading(text) {
  const frames = ['.', '..', '...']
  for (let i = 0; i < 6; i++) {
    process.stdout.write('\r' + text + frames[i % frames.length])
    await sleep(300)
  }
  console.log('')
}

    console.log(`
˃͈◡˂͈  𝗕𝗼𝘁 𝘀𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹𝗹𝘆 𝗲𝘅𝗲𝗰𝘂𝘁𝗲𝗱

♕ Owner info
➬ Owner Name: YussXy
➬ Tiktok : yuss_xy (yuss x nano)
➬ Telegram: t.me/YussXy

Note:
𝙹𝚒𝚔𝚊 𝚖𝚎𝚗𝚐𝚊𝚕𝚊𝚖𝚒 𝚎𝚛𝚛𝚘𝚛 𝚖𝚘𝚑𝚘𝚗 𝚜𝚎𝚐𝚎𝚛𝚊 𝚑𝚞𝚋𝚞𝚗𝚐𝚒 𝚘𝚠𝚗𝚎𝚛, 𝚍𝚊𝚗 𝚓𝚊𝚗𝚐𝚊𝚗 𝚕𝚞𝚙𝚊 𝚒𝚔𝚞𝚝𝚒 𝚜𝚊𝚕𝚞𝚛𝚊𝚗 𝚊𝚐𝚊𝚛 𝚐𝚊𝚔 𝚔𝚎𝚝𝚒𝚗𝚐𝚐𝚊𝚕𝚊𝚗 𝚞𝚙𝚍𝚊𝚝𝚎 𝚞𝚙𝚍𝚊𝚝𝚎 𝚍𝚊𝚛𝚒 𝚋𝚘𝚝 𝚒𝚗𝚒. 𝚃𝚎𝚛𝚒𝚖𝚊𝚔𝚊𝚜𝚒𝚑

𖥃 Dukung Saya
https://saweria.co/yussxy
`)
  }, 2100)

})()

process.once('SIGINT', () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))
