// Nyra Mirror — Dual WhatsApp Cloud Gateway (Seamless 24/7 Cloud Engine)

import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  isJidGroup,
  jidNormalizedUser,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  useMultiFileAuthState,
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
    this.me = { pn: null, lid: null, name: null };
    this.reconnectAttempts = 0;
    this.restartTimer = null;
    this.contacts = new Map();
  }

  async start() {
    clearTimeout(this.restartTimer);
    this.state = "connecting";
    await updateStatus(this.accountId, { state: "connecting" });

    log.info(`[${this.accountId}] Starting ${this.label}...`);
    await restoreSession(this.accountId, log);

    const authDir = getAuthDir(this.accountId);
    const { state: auth, saveCreds } = await useMultiFileAuthState(authDir);

    const keys = {
      get: (type, ids) => auth.keys.get(type, ids),
      set: async (data) => {
        await auth.keys.set(data);
        scheduleBackup(this.accountId, log);
      },
    };

    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    this.sock = makeWASocket({
      version,
      auth: { creds: auth.creds, keys: makeCacheableSignalKeyStore(keys, waLog) },
      logger: waLog,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      getMessage: async () => undefined,
    });

    this.sock.ev.on("creds.update", async () => {
      await saveCreds();
      scheduleBackup(this.accountId, log);
    });

    this.sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        log.info(`[${this.accountId}] QR Code generated for ${this.label}:`);
        qrTerminal.generate(qr, { small: true });
        const qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
        this.state = "qr";
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
          // Keep saved session safe in R2 - only delete from dashboard if user clicks Disconnect!
          log.warn(`[${this.accountId}] Logged out reported by WhatsApp. Standing by; keeping remote session safe.`);
          this.state = "disconnected";
          await updateStatus(this.accountId, { state: "disconnected", error: "Session disconnected from WhatsApp" });
          this.scheduleRestart(10_000);
          return;
        }

        const isFastRetry =
          code === DisconnectReason.restartRequired ||
          code === DisconnectReason.timedOut ||
          code === 408 ||
          code === 515;
        const delay = isFastRetry ? 1_000 : Math.min(5_000, 1_500 * Math.min(4, ++this.reconnectAttempts));
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
    this.sock.ev.on("messages.upsert", async ({ messages, type }) => {
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
      mediaFilename = `wa_img_${Date.now()}.jpg`;
    } else if (content.videoMessage) {
      mediaType = "video";
      mediaMime = content.videoMessage.mimetype || "video/mp4";
      text = content.videoMessage.caption || "";
      mediaFilename = `wa_vid_${Date.now()}.mp4`;
    } else if (content.audioMessage) {
      mediaType = "audio";
      mediaMime = content.audioMessage.mimetype || "audio/ogg";
      mediaFilename = `wa_audio_${Date.now()}.ogg`;
    } else if (content.documentMessage) {
      mediaType = "document";
      mediaMime = content.documentMessage.mimetype || "application/octet-stream";
      text = content.documentMessage.title || content.documentMessage.fileName || "";
      mediaFilename = content.documentMessage.fileName || `wa_doc_${Date.now()}`;
    } else if (content.stickerMessage) {
      mediaType = "sticker";
      mediaMime = content.stickerMessage.mimetype || "image/webp";
      mediaFilename = `wa_stk_${Date.now()}.webp`;
    }

    // Quoted reply extraction
    const ctx =
      content.extendedTextMessage?.contextInfo ||
      content.imageMessage?.contextInfo ||
      content.videoMessage?.contextInfo ||
      content.audioMessage?.contextInfo ||
      content.documentMessage?.contextInfo ||
      content.stickerMessage?.contextInfo;

    let quotedText = null;
    let quotedSender = null;
    if (ctx?.quotedMessage) {
      const qContent = normalizeMessageContent(ctx.quotedMessage);
      quotedText =
        qContent?.conversation ||
        qContent?.extendedTextMessage?.text ||
        qContent?.imageMessage?.caption ||
        qContent?.videoMessage?.caption ||
        (qContent?.imageMessage
          ? "[PHOTO]"
          : qContent?.audioMessage
          ? "[VOICE NOTE]"
          : qContent?.videoMessage
          ? "[VIDEO]"
          : qContent?.documentMessage
          ? "[DOCUMENT]"
          : "[MESSAGE]");
      quotedSender = ctx.participant
        ? this.contacts.get(ctx.participant) || ctx.participant.replace(/@.*$/, "")
        : null;
    }

    let mediaUrl = null;
    let mediaId = null;

    // Download media & store to Google Drive via Brain!
    if (mediaType && (content.imageMessage || content.videoMessage || content.audioMessage || content.documentMessage)) {
      try {
        log.info(`[${this.accountId}] Downloading media (${mediaType})...`);
        mediaBuffer = await downloadMediaMessage(
          msg,
          "buffer",
          {},
          { logger: waLog, reuploadRequest: this.sock.updateMediaMessage }
        );

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

    await recordMessage(this.accountId, messageRecord, chatRecord);
  }
}

// ─── Main Cloud Gateway Loop ─────────────────────────────────────────────────
async function main() {
  log.info("👑 Initializing Nyra Mirror Dual WhatsApp Gateway in Cloud...");

  const manager1 = new WhatsAppAccountManager("acc1", "WhatsApp Account 1");
  const manager2 = new WhatsAppAccountManager("acc2", "WhatsApp Account 2");

  await Promise.all([manager1.start(), manager2.start()]);

  // 1. Continuous Heartbeat every 25 seconds so Cloudflare status never goes offline
  setInterval(async () => {
    if (manager1.state === "connected") {
      await updateStatus("acc1", { state: "connected", me: manager1.me }).catch(() => {});
    }
    if (manager2.state === "connected") {
      await updateStatus("acc2", { state: "connected", me: manager2.me }).catch(() => {});
    }
  }, 25_000);

  // 2. Continuous Outbound Polling every 2 seconds for instant dashboard replies!
  setInterval(async () => {
    await manager1.checkOutbound();
    await manager2.checkOutbound();
  }, 2000);
}

main().catch((err) => {
  log.fatal("Fatal gateway crash:", err);
  process.exit(1);
});
