const nodejs = require('@whiskeysockets/baileys');
const fs = require('fs');
const pino = require('pino');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');
const readline = require('readline');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode-terminal');
const { toBuffer } = require('qrcode');
const { parsePhoneNumber } = require('awesome-phonenumber');
const { default: WAConnection, useMultiFileAuthState, Browsers, DisconnectReason, makeInMemoryStore, makeCacheableSignalKeyStore, fetchLatestBaileysVersion, proto, jidNormalizedUser, getAggregateVotesInPollMessage, makeWASocket, downloadMediaMessage } = require('@whiskeysockets/baileys');

const { app, server, PORT } = require('./lib/server');
const { dataBase } = require('./lib/database');
const db = require('./lib/db');
const handleMessage = require('./lib/handler');
const groupParticipantsUpdate = require('./lib/group-participants');
const antiCallHandler = require('./lib/anticall');
const { watchAll } = require('./watcher');

watchAll([
  path.join(__dirname, './index.js'),
  path.join(__dirname, './lib'),
  path.join(__dirname, './commands'),
  path.join(__dirname, './settings.js'),
  path.join(__dirname, './database')
]);

global.plugins = [];

function loadCommands(dir = path.join(__dirname, './commands')) {
  global.plugins = [];
  const walk = (folder) => {
    fs.readdirSync(folder).forEach(file => {
      let filepath = path.join(folder, file);
      if (fs.lstatSync(filepath).isDirectory()) {
        walk(filepath);
      } else if (file.endsWith('.js')) {
        try {
          delete require.cache[require.resolve(filepath)];
          let cmd = require(filepath);
          if (cmd.handler && typeof cmd.handler === 'function' && (Array.isArray(cmd.command) || cmd.command instanceof RegExp)) {
            global.plugins.push(cmd);
            console.log(`✅ Loaded: ${path.relative(dir, filepath)}`);
          } else {
            console.error(`❌ Plugin ${filepath} tidak memiliki handler atau command yang valid`);
          }
        } catch (e) {
          console.error(`❌ Error load plugin ${filepath}:`, e);
        }
      }
    });
  };
  walk(dir);
}

function watchCommands(dir = path.join(__dirname, './commands')) {
  fs.watch(dir, { recursive: true }, (event, filename) => {
    if (!filename.endsWith('.js')) return;
    console.log(`♻️ Plugin ${filename} changed, reloading...`);
    loadCommands(dir);
  });
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version, isLatest } = await fetchLatestBaileysVersion();

  const conn = makeWASocket({
    printQRInTerminal: true,
    syncFullHistory: true,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 0,
    keepAliveIntervalMs: 10000,
    generateHighQualityLinkPreview: true,
    patchMessageBeforeSending: (message) => {
      const requiresPatch = !!(
        message.buttonsMessage ||
        message.templateMessage ||
        message.listMessage
      );
      if (requiresPatch) {
        message = {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadataVersion: 2,
                deviceListMetadata: {},
              },
              ...message,
            },
          },
        };
      }
      return message;
    },
    version,
    browser: Browsers.windows('Chrome'),
    logger: pino({ level: 'fatal' }),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    }
  });

  const usePairingCode = process.argv.includes('--pairing-code');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (text) => new Promise((resolve) => rl.question(text, resolve));

  conn.decodeJid = (jid) => {
    if (!jid) return jid;
    if (/:\d+@/gi.test(jid)) {
      let decode = nodejs.jidDecode(jid) || {};
      return decode.user && decode.server ? decode.user + '@' + decode.server : jid;
    }
    return jid;
  };

  loadCommands();
  watchCommands();

  conn.ev.on('messages.upsert', async ({ messages }) => {
    let raw = messages[0];
    if (!raw.message) return;

    // Normalisasi pesan
    raw.message = (Object.keys(raw.message)[0] === 'ephemeralMessage' || Object.keys(raw.message)[0] === 'viewOnceMessage')
      ? raw.message[Object.keys(raw.message)[0]].message
      : raw.message;

    raw.chat = raw.key.remoteJid;
    raw.sender = raw.key.fromMe ? conn.user.id : (raw.key.participant || raw.key.remoteJid);
    raw.isGroup = raw.chat.endsWith('@g.us');
    raw.pushName = raw.pushName || 'User';
    raw.text =
      raw.message.conversation ||
      raw.message.extendedTextMessage?.text ||
      raw.message.imageMessage?.caption ||
      raw.message.videoMessage?.caption ||
      raw.message.buttonsResponseMessage?.selectedButtonId ||
      (raw.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ?
        JSON.parse(raw.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id : '') ||
      (raw.message.interactiveResponseMessage?.singleSelectReply?.selectedRowId || '');

    // Handle quoted
    if (raw?.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      const ctx = raw.message.extendedTextMessage.contextInfo;
      const quoted = ctx.quotedMessage;
      const type = Object.keys(quoted)[0];
      const msg = quoted[type];

      raw.quoted = {
        key: {
          remoteJid: ctx.remoteJid || raw.chat,
          fromMe: ctx.participant ? jidNormalizedUser(ctx.participant) === jidNormalizedUser(conn.user.id) : false,
          id: ctx.stanzaId,
          participant: ctx.participant,
        },
        message: quoted,
        type,
        msg,
        text:
          msg?.text ||
          msg?.conversation ||
          msg?.caption ||
          msg?.contentText ||
          msg?.selectedDisplayText ||
          msg?.title ||
          (typeof msg === 'string' ? msg : '') ||
          '',
        isMedia: !!(msg?.mimetype || msg?.thumbnailDirectPath),
        download: () => downloadMediaMessage({ message: quoted }, 'buffer', {}, { logger: console, reuploadRequest: conn.updateMediaMessage }),
      };
    }

    raw.reply = (txt) => conn.sendMessage(raw.chat, { text: txt }, { quoted: raw });

    if (raw.isGroup) {
      let metadata = await conn.groupMetadata(raw.chat);
      raw.isAdmin = metadata.participants.find(p => p.id === raw.sender)?.admin != null;
      raw.isBotAdmin = metadata.participants.find(p => p.id === conn.user.id)?.admin != null;
    }

    try {
      await handleMessage(raw, { conn });
    } catch (e) {
      console.error('Error in handleMessage:', e);
    }
  });

  conn.ev.on('group-participants.update', async (update) => {
    try {
      await groupParticipantsUpdate(conn, update);
    } catch (e) {
      console.error('Error group-participants.update:', e);
    }
  });

  conn.ev.on('call', async (call) => {
    try {
      await antiCallHandler(conn, call);
    } catch (e) {
      console.error('Error antiCall:', e);
    }
  });

  conn.ev.on('creds.update', saveCreds);

  conn.ev.on('connection.update', async (update) => {
    const { qr, connection, lastDisconnect, isNewLogin } = update;
    try {
      const loadData = await dataBase('database1.json').read();
      const storeLoadData = await dataBase('baileys_store.json').read();
      global.db = loadData || { hit: {}, set: {}, cmd: {}, store: {}, users: {}, game: {}, groups: {}, database: {}, premium: [], sewa: [] };
      global.store = storeLoadData || { contacts: {}, presences: {}, messages: {}, groupMetadata: {} };
      setInterval(async () => {
        if (global.db) await dataBase('database1.json').write(global.db);
        if (global.store) await dataBase('baileys_store.json').write(global.store);
      }, 30 * 1000);
    } catch (e) {
      console.error('Error loading database:', e);
      process.exit(1);
    }

    if (connection === 'close') {
      const reason = new Boom(lastDisconnect?.error)?.output.statusCode;
      console.log(`Disconnect Reason: ${reason}`);
      if (reason === DisconnectReason.connectionLost || reason === DisconnectReason.connectionClosed || reason === DisconnectReason.timedOut) {
        console.log('Reconnecting...');
        setTimeout(start, 3000);
      } else if (reason === DisconnectReason.connectionReplaced) {
        console.log('Another session is active. Waiting to reconnect...');
        setTimeout(start, 5000);
      } else if (reason === DisconnectReason.loggedOut || reason === DisconnectReason.forbidden || reason === DisconnectReason.multideviceMismatch) {
        console.log('Session invalid, please scan QR or use pairing code again...');
        process.exit(1);
      } else if (reason === DisconnectReason.restartRequired) {
        console.log('Restart required...');
        start();
      } else {
        console.error(`Unknown DisconnectReason: ${reason}|${connection}`);
        process.exit(1);
      }
    } else if (connection === 'open') {
      console.log('Connected to: ' + JSON.stringify(conn.user, null, 2));
    } else if (qr && !usePairingCode) {
      qrcode.generate(qr, { small: true });
      app.use('/qr', async (req, res) => {
        res.setHeader('content-type', 'image/png');
        res.end(await toBuffer(qr));
      });
    } else if (usePairingCode && !conn.authState.creds.registered) {
      setTimeout(async () => {
        const phoneNumber = await question(chalk.green('> Masukan Nomer Aktif (Awali dengan 62): '));
        try {
          const code = await conn.requestPairingCode(phoneNumber, 'NDIKZONE');
          console.log(chalk.green(`Kode Pairing: ${chalk.bold.white(code?.match(/.{1,4}/g)?.join('-') || code)}`));
        } catch (error) {
          console.error(chalk.red(`Gagal meminta kode pairing: ${error.message}`));
          process.exit(1);
        }
      }, 3000);
    }
  });

  conn.ev.on('contacts.update', update => {
    for (let contact of update) {
      let id = conn.decodeJid(contact.id);
      if (store && store.contacts) store.contacts[id] = { id, name: contact.notify };
    }
  });
}

start();
