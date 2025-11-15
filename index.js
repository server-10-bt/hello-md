// index.js — Believer MD (CommonJS, advanced, stable for Replit/Termux)
// Features: auto-owner, public/private mode, master switch, toggles, reply-save, view-once saver,
// sticker maker (wa-sticker-formatter), QR PNG generator, menu, anti-delete (basic), search (DDG),
// robust error handling, config persistence.

const baileys = require("@whiskeysockets/baileys");
const makeWASocket = baileys.default || baileys; // compatibility
const {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  downloadContentFromMessage,
  jidNormalizedUser
} = baileys;
const P = require("pino");
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode");
const { Sticker, StickerTypes } = require("wa-sticker-formatter");
const fetch = require("node-fetch"); // v2 compatible

// Config files
const AUTH_DIR = "./auth";
const CONFIG_FILE = "./config.json";
const QR_FILE = "./whatsapp-qr.png";

// Ensure config exists
const defaultConfig = {
  master: true,
  publicMode: false,
  features: {
    status: true,
    autosave: false,
    viewonce: true,
    bulk: false,
    search: true,
    ai: false,
    group: true,
    media: true,
    security: true
  }
};
if (!fs.existsSync(CONFIG_FILE)) fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultConfig, null, 2));
let config = JSON.parse(fs.readFileSync(CONFIG_FILE));

// Commands registry used by .menu
const commands = {
  // system
  menu: "Show this menu",
  ping: "Check bot latency",
  runtime: "Show bot uptime",

  // owner/mode
  owner: "Show owner JID",
  setmode: "Set mode: .setmode public|private (owner only)",
  mode: "Show current mode",
  master: "Master on/off (owner only)",

  // toggles (owner only)
  "toggle status": "Turn status saver on/off",
  "toggle viewonce": "Turn view-once feature on/off",
  "toggle autosave": "Turn autosave on/off",

  // media
  save: "Reply to media + .save → saves replied media to owner DM",
  viewonce: "Reply to view-once + .viewonce → save to owner DM",
  sticker: "Reply to image/video + .sticker → makes sticker",
  qr: "Generate a PNG QR from text: .qr <text>",

  // utility
  search: "Search the web (duckduckgo): .search <query>",
  menu_short: "Alias: .menu"
};

// runtime
const START_TS = Date.now();

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// helper: stream -> buffer
async function streamToBuffer(stream) {
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer;
}

// save quoted media to buffer and metadata
async function saveQuotedMediaToBuffer(quotedMessage) {
  // determine message type
  const msg = quotedMessage;
  let mType = null;
  if (msg.imageMessage) mType = "image";
  else if (msg.videoMessage) mType = "video";
  else if (msg.documentMessage) mType = "document";
  else if (msg.audioMessage) mType = "audio";
  else if (msg.stickerMessage) mType = "sticker";

  if (!mType) throw new Error("Quoted message has no downloadable media.");

  const stream = await downloadContentFromMessage(quotedMessage, mType);
  const buffer = await streamToBuffer(stream);

  let ext = "bin";
  const mimetype =
    (msg.imageMessage && msg.imageMessage.mimetype) ||
    (msg.videoMessage && msg.videoMessage.mimetype) ||
    (msg.audioMessage && msg.audioMessage.mimetype) ||
    (msg.documentMessage && msg.documentMessage.mimetype);

  if (mimetype) ext = mimetype.split("/")[1] || ext;
  if (mType === "sticker") ext = "webp";

  return { buffer, ext, type: mType, mimetype };
}

async function sendBufferToOwner(sock, ownerJid, buffObj, caption = "") {
  if (!ownerJid) throw new Error("Owner JID not set.");
  const { buffer, ext, type, mimetype } = buffObj;

  if (type === "image") {
    await sock.sendMessage(ownerJid, { image: buffer, caption });
  } else if (type === "video") {
    await sock.sendMessage(ownerJid, { video: buffer, caption });
  } else if (type === "audio") {
    await sock.sendMessage(ownerJid, { audio: buffer, ptt: false });
  } else if (type === "sticker") {
    await sock.sendMessage(ownerJid, { sticker: buffer });
  } else {
    await sock.sendMessage(ownerJid, { document: buffer, fileName: `file.${ext}`, mimetype: mimetype || "application/octet-stream", caption });
  }
}

// main
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    logger: P({ level: "silent" })
  });

  // global owner JID (will be auto-set)
  let OWNER_JID = null;

  // connection updates
  sock.ev.on("connection.update", async (update) => {
    const { qr, connection, lastDisconnect } = update;

    if (qr) {
      try {
        await qrcode.toFile(QR_FILE, qr, { margin: 1 });
        console.log("🔸 QR saved to", QR_FILE, "- open and scan (or view terminal ASCII if printed).");
      } catch (e) {
        console.warn("Could not write QR PNG:", e);
      }
      // also print small ascii for quick scanning in terminal if available
      try {
        const qrcodeTerminal = require("qrcode-terminal");
        qrcodeTerminal.generate(qr, { small: true });
      } catch (e) {}
    }

    if (connection === "open") {
      console.log("✅ Connected to WhatsApp!");
      try {
        const baseUser = sock.user?.id?.split(":")?.[0];
        if (baseUser) {
          OWNER_JID = `${baseUser}@s.whatsapp.net`;
          console.log("👑 Owner automatically set to:", OWNER_JID);
        }
      } catch (e) {
        console.warn("Could not auto-set owner:", e);
      }
    }

    if (connection === "close") {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log("🔐 Logged out. Delete auth folder to relink.");
      } else {
        console.log("🔁 Connection closed, reconnecting...");
        setTimeout(() => startBot(), 2000);
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // basic anti-delete: store last messages in memory (simple)
  const recentMessages = new Map(); // key => serialized message
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const m = messages[0];
      if (!m.message) return;
      const keyId = m.key?.id || Date.now().toString();
      recentMessages.set(keyId, m);

      // prune map occasionally
      if (recentMessages.size > 1000) {
        const keys = Array.from(recentMessages.keys());
        recentMessages.delete(keys[0]);
      }
    } catch (e) {
      console.error("recent store error:", e);
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    try {
      for (const upd of updates) {
        if (upd.message === null && config.features.security) {
          // message deleted; try to notify owner (best-effort)
          const key = upd.key;
          const chat = key.remoteJid;
          try {
            await sock.sendMessage(chat, { text: "⚠️ Anti-delete: a message was deleted." });
          } catch (e) {}
        }
      }
    } catch (e) {
      console.error("messages.update handler error:", e);
    }
  });

  // CORE message handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const m = messages[0];
      if (!m.message) return;
      if (m.key.remoteJid === "status@broadcast") return; // ignore status
      if (m.key.fromMe) return; // ignore our own

      const from = m.key.remoteJid;
      const participant = m.key.participant || from;
      // get text from various message types
      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        m.message.videoMessage?.caption ||
        m.message.documentMessage?.fileName ||
        "";

      if (!text || !text.startsWith(".")) {
        // not a command; we could implement autorespond or autosave but skip
        return;
      }

      const raw = text.slice(1).trim();
      const args = raw.split(/\s+/);
      const command = args.shift().toLowerCase();

      const isOwner = OWNER_JID && participant === OWNER_JID;
      // master switch
      if (!config.master && !(command === "master" && isOwner)) {
        await sock.sendMessage(from, { text: "⚠️ Master is OFF — only owner can enable (.master on)" });
        return;
      }
      // private mode check
      if (!config.publicMode && !isOwner && command !== "help" && command !== "menu" && command !== "mode") {
        await sock.sendMessage(from, { text: "🚫 Bot is in private mode. Only owner can use commands." });
        return;
      }

      // ---------- COMMANDS ----------
      if (command === "menu" || command === "help") {
        let menuText = "*📜 BELIEVER MD — MENU*\n\n";
        for (const k in commands) {
          menuText += `• .${k} — ${commands[k]}\n`;
        }
        await sock.sendMessage(from, { text: menuText });
        return;
      }

      if (command === "ping") {
        await sock.sendMessage(from, { text: "🏓 Pong!" });
        return;
      }

      if (command === "runtime") {
        const diff = Date.now() - START_TS;
        const hrs = Math.floor(diff / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        await sock.sendMessage(from, { text: `⏱ Uptime: ${hrs}h ${mins}m ${secs}s` });
        return;
      }

      // owner / mode commands
      if (command === "owner") {
        await sock.sendMessage(from, { text: `👑 Owner: ${OWNER_JID || "not set yet"}` });
        return;
      }

      if (command === "setmode") {
        if (!isOwner) return;
        const m = args[0] && args[0].toLowerCase();
        if (m === "public") config.publicMode = true;
        else if (m === "private") config.publicMode = false;
        saveConfig();
        await sock.sendMessage(from, { text: `Mode set to ${config.publicMode ? "public" : "private"}` });
        return;
      }

      if (command === "mode") {
        await sock.sendMessage(from, { text: `Mode: ${config.publicMode ? "public" : "private"}` });
        return;
      }

      // master on/off (owner only)
      if (command === "master") {
        if (!isOwner) return;
        const v = args[0] && args[0].toLowerCase();
        if (v === "on") config.master = true;
        if (v === "off") config.master = false;
        saveConfig();
        await sock.sendMessage(from, { text: `Master set to ${config.master}` });
        return;
      }

      // toggle feature (owner only) e.g. .toggle viewonce on/off or .viewonce on/off
      const toggleTargets = ["status", "autosave", "viewonce", "bulk", "search", "ai", "group", "media", "security"];
      if (command === "toggle" && isOwner) {
        const key = args[0];
        const flag = args[1] && args[1].toLowerCase();
        if (!key || !toggleTargets.includes(key)) return await sock.sendMessage(from, { text: "Usage: .toggle <feature> on|off" });
        config.features[key] = flag === "on";
        saveConfig();
        await sock.sendMessage(from, { text: `${key} set to ${config.features[key]}` });
        return;
      }

      // shorthand toggles: e.g. .viewonce on/off
      if (toggleTargets.includes(command) && isOwner) {
        const flag = args[0] && args[0].toLowerCase();
        config.features[command] = flag === "on";
        saveConfig();
        await sock.sendMessage(from, { text: `${command} set to ${config.features[command]}` });
        return;
      }

      // SAVE -> reply to media with .save
      if (command === "save") {
        const ctx = m.message.extendedTextMessage?.contextInfo;
        const quoted = ctx?.quotedMessage;
        if (!quoted) return await sock.sendMessage(from, { text: "Reply to a media message with .save" });
        try {
          const buffObj = await saveQuotedMediaToBuffer(quoted);
          if (OWNER_JID) {
            await sendBufferToOwner(sock, OWNER_JID, buffObj, `Saved via .save from ${from}`);
            await sock.sendMessage(from, { text: "Saved and sent to owner DM." });
          } else {
            await sock.sendMessage(from, { text: "Owner not set yet — cannot deliver saved media." });
          }
        } catch (e) {
          console.error(".save error", e);
          await sock.sendMessage(from, { text: "Failed to save replied media." });
        }
        return;
      }

      // VIEWONCE -> reply to quoted view-once
      if (command === "viewonce") {
        if (!config.features.viewonce) return await sock.sendMessage(from, { text: "Feature .viewonce is disabled." });
        const ctx = m.message.extendedTextMessage?.contextInfo;
        const quoted = ctx?.quotedMessage;
        if (!quoted) return await sock.sendMessage(from, { text: "Reply to a view-once message with .viewonce" });
        try {
          const buffObj = await saveQuotedMediaToBuffer(quoted);
          if (OWNER_JID) {
            await sendBufferToOwner(sock, OWNER_JID, buffObj, `View-once saved from ${from}`);
            await sock.sendMessage(from, { text: "View-once saved and sent to owner DM." });
          } else {
            await sock.sendMessage(from, { text: "Owner not set yet — cannot deliver saved media." });
          }
        } catch (e) {
          console.error(".viewonce error", e);
          await sock.sendMessage(from, { text: "Failed to save view-once media." });
        }
        return;
      }

      // STICKER -> reply to media
      if (command === "sticker") {
        const ctx = m.message.extendedTextMessage?.contextInfo;
        const quoted = ctx?.quotedMessage;
        if (!quoted) return await sock.sendMessage(from, { text: "Reply to an image/video with .sticker" });
        try {
          const buffObj = await saveQuotedMediaToBuffer(quoted);
          const buf = buffObj.buffer;
          // wa-sticker-formatter handles webp creation internally
          const sticker = new Sticker(buf, {
            pack: "BelieverMD",
            author: "Pecs",
            type: StickerTypes.FULL,
            quality: 70
          });
          const outBuf = await sticker.toBuffer();
          await sock.sendMessage(from, { sticker: outBuf });
        } catch (e) {
          console.error("sticker error", e);
          await sock.sendMessage(from, { text: "Sticker failed. Media may be too large or unsupported." });
        }
        return;
      }

      // QR: .qr some text -> send png image of QR
      if (command === "qr") {
        const textForQr = args.join(" ");
        if (!textForQr) return await sock.sendMessage(from, { text: "Usage: .qr <text>" });
        try {
          const outPath = path.join(".", `qr_${Date.now()}.png`);
          await qrcode.toFile(outPath, textForQr, { margin: 1 });
          const imageBuffer = fs.readFileSync(outPath);
          await sock.sendMessage(from, { image: imageBuffer, caption: `QR for: ${textForQr}` });
          fs.unlinkSync(outPath);
        } catch (e) {
          console.error("qr error", e);
          await sock.sendMessage(from, { text: "Failed to generate QR." });
        }
        return;
      }

      // SEARCH: .search query -> DuckDuckGo Instant Answer
      if (command === "search") {
        if (!config.features.search) return await sock.sendMessage(from, { text: "Search disabled." });
        const q = args.join(" ");
        if (!q) return await sock.sendMessage(from, { text: "Usage: .search <query>" });
        try {
          const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_html=1&skip_disambig=1`;
          const res = await fetch(url).then(r => r.json());
          const related = res.RelatedTopics || [];
          const lines = [];
          for (let i = 0; i < Math.min(5, related.length); i++) {
            const item = related[i];
            if (item.Text && item.FirstURL) lines.push(`${item.Text}\n${item.FirstURL}`);
            else if (item.Topics && item.Topics[0]) lines.push(`${item.Topics[0].Text}\n${item.Topics[0].FirstURL}`);
          }
          const replyText = lines.length ? lines.join("\n\n") : "No instant results — try another query.";
          await sock.sendMessage(from, { text: `🔎 Results for "${q}":\n\n${replyText}` });
        } catch (e) {
          console.error("search error", e);
          await sock.sendMessage(from, { text: "Search failed." });
        }
        return;
      }

      // fallback
      await sock.sendMessage(from, { text: "❓ Unknown command. Use .menu to see commands." });
    } catch (err) {
      console.error("handler error", err);
    }
  });

  console.log("Bot started (waiting for QR or connection) ...");
}

startBot().catch(e => console.error("startBot failure", e));
