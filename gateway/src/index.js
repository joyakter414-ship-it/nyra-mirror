// Nyra Mirror — Dual WhatsApp Cloud Gateway (Seamless 24/7 Cloud Engine)
// Zero-Quota Exhaustion Mode: Event-Driven Outbound Dispatching & Credential Safety

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidDecode,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
  isJidGroup,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import qrTerminal from "qrcode-terminal";
import { getOutbound, recordMessage, updateStatus, uploadMedia } from "./brain.js";
import { backupNow, getAuthDir, restoreSession, scheduleBackup } from "./session-store.js";

const log = pino({ level: process.env.LOG_LEVEL || "info" });
const waLog = log.child({ module: "baileys" }, { level: process.env.BAILEYS_LOG_LEVEL || "warn" });

class WhatsAppAccountManager {
  constructor(accountId, label) {
    this.accountId = accountId;
    this.label = label;
    this.sock = null;
    this.state = "starting";
    this.me = null;
    this.reconnectAttempts = 0;
    this.restartTimer = null;
    this.contacts = new Map();
  }

  async start() {
    clearTimeout(this.restartTimer);
    log.info(`[${this.accountId}] 🚀 Starting ${this.label}...`);

    // 1. Restore encrypted session from Cloudflare R2 if not present locally
    await restoreSession(this.accountId, log);

    const authDir = getAuthDir(this.accountId);
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    log.info(`[${this.accountId}] Using WA v${version.join(".")} (latest: ${isLatest})`);

    this.sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, waLog),
      },
      printQRInTerminal: false,
      logger: waLog,
      browser: Browsers.macOS("Desktop"),
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
    });

    // Auto-save credentials & sync to Cloudflare R2
    this.sock.ev.on("creds.update", async () => {
      await saveCreds();
      scheduleBackup(this.accountId, log);
    });

    // Connection lifecycle
    this.sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.state = "qr";
        log.info(`[${this.accountId}] 📱 New QR code generated. Updating dashboard...`);
        qrTerminal.generate(qr, { small: true });
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 });
        await updateStatus(this.accountId, { state: "qr", qr: qrDataUrl });
      }

      if (connection === "open") {
        this.reconnectAttempts = 0;
        this.state = "connected";
        this.me = {
          pn: this.sock.user?.id ? jidNormalizedUser(this.sock.user.id) : null,
          lid: this.sock.user?.lid ? jidNormalizedUser(this.sock.user.lid) : null,
          name: this.sock.user?.name || this.sock.user?.notify || "WhatsApp User",
        };
        log.info(`[${this.accountId}] ✅ ${this.label} connected as ${this.me.name} (${this.me.pn})`);
        await updateStatus(this.accountId, { state: "connected", me: this.me });
        // Immediately persist session credentials to R2
        await backupNow(this.accountId, log);
      }

      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        log.warn(`[${this.accountId}] Connection closed (code: ${code ?? "unknown"})`);

        if (code === DisconnectReason.connectionReplaced) {
          // Another runner instance took over this session (e.g. during 24/7 relay switchover)
          // Do NOT mark status as disconnected in Cloudflare so UI stays seamlessly connected!
          log.warn(`[${this.accountId}] Connection replaced by another gateway instance. Standing by.`);
          this.scheduleRestart(60_000);
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          // Absolute Credential Safety: Keep saved session safe in R2 - only delete if user clicks Disconnect in UI!
          log.warn(`[${this.accountId}] Logged out reported by WhatsApp. Standing by; keeping remote session safe.`);
          this.state = "disconnected";
          await updateStatus(this.accountId, { state: "disconnected", error: "Session disconnected from WhatsApp" });
          this.scheduleRestart(30_000);
          return;
        }

        // Exponential backoff (15s–30s) instead of rapid 1s loops
        const delay = Math.min(30_000, 15_000 * Math.max(1, Math.min(2, ++this.reconnectAttempts)));
        log.warn(`[${this.accountId}] Reconnecting in ${Math.round(delay / 1000)}s…`);
        this.scheduleRestart(delay);
      }
    });

    // Contacts tracking for display names
    this.sock.ev.on("contacts.upsert", (contacts) => {
      for (const c of contacts) {
        if (c.id && (c.name || c.notify)) {
          this.contacts.set(c.id, c.name || c.notify);
        }
      }
    });

    // Messages sync
    this.sock.ev.on("messages.upsert", async ({ messages }) => {
      for (const msg of messages) {
        try {
          await this.handleMessage(msg);
        } catch (err) {
          log.error(`[${this.accountId}] Message handling error: ${err.message}`);
        }
      }
    });
  }

  scheduleRestart(delayMs) {
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.start(), delayMs);
  }

  // Relaxed outbound check: called on gentle fallback or on message arrival
  async checkOutbound() {
    if (!this.sock || this.state !== "connected") return;
    try {
      const res = await getOutbound(this.accountId);
      if (Array.isArray(res?.outbound) && res.outbound.length > 0) {
        for (const item of res.outbound) {
          await this.sendOutboundItem(item);
        }
      }
    } catch (err) {
      log.debug(`[${this.accountId}] checkOutbound: ${err.message}`);
    }
  }

  async sendOutboundItem(item) {
    if (!item?.jid || !item?.text || !this.sock || this.state !== "connected") return;
    try {
      await this.sock.sendPresenceUpdate("composing", item.jid).catch(() => {});
      await new Promise((r) => setTimeout(r, 300));
      await this.sock.sendMessage(item.jid, { text: item.text });
      await this.sock.sendPresenceUpdate("paused", item.jid).catch(() => {});
      log.info(`[${this.accountId}] 📤 Sent message from dashboard to ${item.jid}: "${item.text.slice(0, 40)}"`);
    } catch (err) {
      log.error(`[${this.accountId}] Failed to send message to ${item.jid}: ${err.message}`);
    }
  }

  async handleMessage(msg) {
    if (!msg.message) return;
    const key = msg.key;
    const isFromMe = Boolean(key.fromMe);
    const chatJid = key.remoteJid;
    if (!chatJid || chatJid === "status@broadcast") return;

    const content = normalizeMessageContent(msg.message);
    if (!content) return;

    let text = "";
    let mediaType = null;
    let mediaMime = null;
    let mediaBuffer = null;
    let mediaFilename = null;

    if (content.conversation) {
      text = content.conversation;
    } else if (content.extendedTextMessage?.text) {
      text = content.extendedTextMessage.text;
    } else if (content.imageMessage) {
      mediaType = "image";
      mediaMime = content.imageMessage.mimetype || "image/jpeg";
      text = content.imageMessage.caption || "";
      mediaFilename = `img_${Date.now()}.jpg`;
    } else if (content.videoMessage) {
      mediaType = "video";
      mediaMime = content.videoMessage.mimetype || "video/mp4";
      text = content.videoMessage.caption || "";
      mediaFilename = `vid_${Date.now()}.mp4`;
    } else if (content.audioMessage) {
      mediaType = "audio";
      mediaMime = content.audioMessage.mimetype || "audio/ogg; codecs=opus";
      text = content.audioMessage.ptt ? "🎤 Voice message" : "🎵 Audio";
      mediaFilename = `aud_${Date.now()}.ogg`;
    } else if (content.documentMessage) {
      mediaType = "document";
      mediaMime = content.documentMessage.mimetype || "application/octet-stream";
      text = content.documentMessage.fileName || content.documentMessage.title || "Document";
      mediaFilename = content.documentMessage.fileName || `doc_${Date.now()}`;
    } else if (content.stickerMessage) {
      mediaType = "sticker";
      mediaMime = content.stickerMessage.mimetype || "image/webp";
      text = "🎨 Sticker";
      mediaFilename = `stk_${Date.now()}.webp`;
    }

    // Extract quoted context if message is a reply
    let quotedText = null;
    let quotedSender = null;
    const contextInfo =
      content.extendedTextMessage?.contextInfo ||
      content.imageMessage?.contextInfo ||
      content.videoMessage?.contextInfo ||
      content.audioMessage?.contextInfo ||
      content.documentMessage?.contextInfo;

    if (contextInfo?.quotedMessage) {
      const q = normalizeMessageContent(contextInfo.quotedMessage);
      if (q?.conversation) quotedText = q.conversation;
      else if (q?.extendedTextMessage?.text) quotedText = q.extendedTextMessage.text;
      else if (q?.imageMessage) quotedText = "📷 Photo";
      else if (q?.videoMessage) quotedText = "🎥 Video";
      else if (q?.audioMessage) quotedText = "🎤 Voice message";
      else if (q?.documentMessage) quotedText = "📄 Document";
      else if (q?.stickerMessage) quotedText = "🎨 Sticker";

      const qParticipant = contextInfo.participant;
      if (qParticipant) {
        quotedSender = this.contacts.get(qParticipant) || `+${qParticipant.replace(/@.*$/, "")}`;
      }
    }

    // Download media buffer if present (up to 20MB)
    let mediaUrl = null;
    let mediaId = null;
    if (mediaType) {
      try {
        const { downloadMediaMessage } = await import("@whiskeysockets/baileys");
        mediaBuffer = await downloadMediaMessage(msg, "buffer", {}, { logger: waLog });
        if (mediaBuffer && mediaBuffer.length > 0) {
          log.info(`[${this.accountId}] Uploading ${mediaBuffer.length} bytes to Google Drive...`);
          const uploadRes = await uploadMedia(mediaFilename, mediaMime, mediaBuffer);
          if (uploadRes?.fileId) {
            mediaId = uploadRes.fileId;
            mediaUrl = uploadRes.viewUrl;
            log.info(`[${this.accountId}] Stored in Google Drive (ID: ${mediaId})`);
          }
        }
      } catch (mediaErr) {
        log.error(`[${this.accountId}] Media download/upload failed: ${mediaErr.message}`);
      }
    }

    const senderJid = isFromMe ? this.sock.user?.id : key.participant || chatJid;
    const senderName = isFromMe ? "You" : msg.pushName || this.contacts.get(senderJid) || null;
    const phone = senderJid ? senderJid.replace(/@.*$/, "") : null;
    const isGroup = isJidGroup(chatJid);

    const messageRecord = {
      id: key.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      account_id: this.accountId,
      chat_id: chatJid,
      role: isFromMe ? "assistant" : "user",
      sender: phone,
      sender_name: senderName,
      content: text || (mediaType ? `[${mediaType.toUpperCase()}]` : ""),
      source: "whatsapp",
      created_at: Number(msg.messageTimestamp) ? Number(msg.messageTimestamp) * 1000 : Date.now(),
      media_type: mediaType,
      media_url: mediaUrl,
      media_id: mediaId,
      media_mime: mediaMime,
      quoted_text: quotedText,
      quoted_sender: quotedSender,
    };

    const chatRecord = {
      account_id: this.accountId,
      chat_id: chatJid,
      name: isGroup ? "Group Chat" : senderName || phone,
      is_group: isGroup ? 1 : 0,
      last_at: messageRecord.created_at,
      last_msg: messageRecord.content,
      notify_name: msg.pushName || null,
      phone: isGroup ? null : phone,
      unread: isFromMe ? 0 : 1,
    };

    // Event-driven: recordMessage response returns pending outbound queue
    const res = await recordMessage(this.accountId, messageRecord, chatRecord);
    if (Array.isArray(res?.outbound) && res.outbound.length > 0) {
      for (const item of res.outbound) {
        await this.sendOutboundItem(item);
      }
    }
  }
}

// ─── Main Cloud Gateway Loop ─────────────────────────────────────────────────
async function main() {
  log.info("👑 Initializing Nyra Mirror Dual WhatsApp Gateway in Cloud...");

  const manager1 = new WhatsAppAccountManager("acc1", "WhatsApp Account 1");
  const manager2 = new WhatsAppAccountManager("acc2", "WhatsApp Account 2");

  await Promise.all([manager1.start(), manager2.start()]);

  // Gentle fallback timer: checks outbound messages every 60s ONLY if connected
  // (In idle state, ZERO request spam to Cloudflare!)
  setInterval(async () => {
    if (manager1.state === "connected") {
      await manager1.checkOutbound();
    }
    if (manager2.state === "connected") {
      await manager2.checkOutbound();
    }
  }, 60_000);
}

main().catch((err) => {
  log.fatal("Fatal gateway crash:", err);
  process.exit(1);
});
