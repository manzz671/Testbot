const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

// File untuk menyimpan data db secara persisten
const DB_FILE = path.join(__dirname, 'database.json');

// Fungsi untuk memuat db dari file
function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(chalk.redBright(`❌ Gagal memuat database: ${err.message}`));
  }
  // Default db jika file tidak ada
  return { users: {}, hit: {}, set: {}, cmd: {}, store: {}, game: {}, groups: {}, database: {}, premium: [], sewa: [] };
}

// Fungsi untuk menyimpan db ke file
function saveDb(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error(chalk.redBright(`❌ Gagal menyimpan database: ${err.message}`));
  }
}

// Inisialisasi db dengan metode list
const db = loadDb();
db.list = () => db; // Metode list mengembalikan objek db itu sendiri

function safeFindPlugin(pluginsList, command, options = {}) {
  const { noPrefix = false, reaction = false } = options;
  return pluginsList.find(p => {
    if (p.noPrefix !== noPrefix || p.reaction !== reaction) return false;
    if (p.command instanceof RegExp) return p.command.test(command);
    if (Array.isArray(p.command)) return p.command.includes(command);
    return false;
  });
}

async function handleMessage(m, { conn }) {
  try {
    if (!m.message) return;
    if (m.key.fromMe) return; // Jangan proses pesan dari bot sendiri
    if (!m.text) return;

    const isGroup = m.chat.endsWith('@g.us');
    const isBotAdmin = isGroup ? (await conn.groupMetadata(m.chat)).participants.find(p => p.id === conn.user.id)?.admin != null : false;
    const isAdmin = isGroup ? (await conn.groupMetadata(m.chat)).participants.find(p => p.id === m.sender)?.admin != null : false;
    const pluginsList = global.plugins || [];

    let command = m.text.toLowerCase().trim();
    let args = m.text.trim().split(/\s+/).slice(1);
    let usedPrefix = '';

    // Deteksi prefix untuk command di folder commands
    const prefixes = ['.', '#', '!'];
    const prefixMatch = m.text.match(/^([.#%!])(.+)/i);
    if (prefixMatch && prefixes.includes(prefixMatch[1])) {
      usedPrefix = prefixMatch[1];
      command = prefixMatch[2].toLowerCase().trim().split(/\s+/)[0];
      args = prefixMatch[2].trim().split(/\s+/).slice(1);
    }

    // Handle reaksi
    const isReaction = m.message?.reactionMessage && m.message.reactionMessage.text;
    if (isReaction) {
      command = m.message.reactionMessage.text.toLowerCase();
      console.log(chalk.cyanBright(`Debug: Mendeteksi reaksi: ${command}`));

      const plugin = safeFindPlugin(pluginsList, command, { reaction: true });
      if (!plugin) {
        console.log(chalk.yellowBright(`Debug: Plugin tidak ditemukan untuk reaksi: ${command}`));
        return;
      }

      console.log(chalk.greenBright(`Debug: Menjalankan plugin reaksi: ${plugin.category}/${command}`));
      await plugin.handler(m, {
        conn,
        args,
        usedPrefix: '',
        command,
        db,
        isBotAdmin,
        isAdmin,
        text: m.text
      });
      return;
    }

    // Handle command tanpa prefix (folder defaults)
    if (!usedPrefix) {
      const plugin = safeFindPlugin(pluginsList, command, { noPrefix: true });
      if (plugin) {
        console.log(chalk.greenBright(`Debug: Menjalankan plugin tanpa prefix: ${plugin.category}/${command}`));
        await plugin.handler(m, {
          conn,
          args,
          usedPrefix: '',
          command,
          db,
          isBotAdmin,
          isAdmin,
          text: m.text
        });
        // Tambah hitungan penggunaan command
        db.cmd[command] = (db.cmd[command] || 0) + 1;
        saveDb(db);
        return;
      }
    }

    // Handle command dengan prefix (folder commands)
    if (usedPrefix) {
      const plugin = safeFindPlugin(pluginsList, command, { noPrefix: false, reaction: false });
      if (!plugin) {
        console.log(chalk.yellowBright(`Debug: Plugin tidak ditemukan untuk command: ${usedPrefix}${command}`));
        return;
      }

      // Cek limit (jika ada sistem limit)
      if (plugin.limit && db.users[m.sender]?.limit <= 0) {
        await conn.sendMessage(m.chat, {
          text: '❌ *Limit harianmu habis!* Silakan tunggu reset atau upgrade ke premium.',
          contextInfo: {
            mentionedJid: [m.sender]
          }
        }, { quoted: m });
        await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        return;
      }

      // Cek owner
      if (plugin.owner && m.sender !== '62882010519985@s.whatsapp.net') {
        await conn.sendMessage(m.chat, {
          text: '❌ *Perintah ini hanya untuk owner!*',
          contextInfo: {
            mentionedJid: [m.sender]
          }
        }, { quoted: m });
        await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        return;
      }

      // Cek grup
      if (plugin.group && !isGroup) {
        await conn.sendMessage(m.chat, {
          text: '❌ *Perintah ini hanya bisa digunakan di grup!*',
          contextInfo: {
            mentionedJid: [m.sender]
          }
        }, { quoted: m });
        await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        return;
      }

      console.log(chalk.greenBright(`Debug: Menjalankan plugin dengan prefix: ${plugin.category}/${command}`));
      await plugin.handler(m, {
        conn,
        args,
        usedPrefix,
        command,
        db,
        isBotAdmin,
        isAdmin,
        text: m.text
      });

      // Tambah hitungan penggunaan command
      db.cmd[command] = (db.cmd[command] || 0) + 1;
      saveDb(db);

      // Kurangi limit (jika ada sistem limit)
      if (plugin.limit && db.users[m.sender]) {
        db.users[m.sender].limit = (db.users[m.sender].limit || 10) - 1;
        console.log(chalk.cyanBright(`Debug: Limit ${m.sender} tersisa: ${db.users[m.sender].limit}`));
        saveDb(db);
      }
    }
  } catch (err) {
    console.error(chalk.redBright(`❌ Error di handleMessage: ${err.stack}`));
    await conn.sendMessage(m.chat, {
      text: '⚠️ *Terjadi kesalahan saat memproses perintah. Coba lagi nanti.*',
      contextInfo: {
        mentionedJid: [m.sender]
      }
    }, { quoted: m });
    await conn.sendMessage('62882010519985@s.whatsapp.net', {
      text: `Error di handleMessage: ${err.message}`,
      contextInfo: { quotedMessage: m.message }
    }, { quoted: m });
    await conn.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
  }
}

module.exports = handleMessage;
