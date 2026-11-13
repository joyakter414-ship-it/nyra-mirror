import type { AppEnv } from "./env";
import {
  getAccountStatus,
  setAccountStatus,
  listChats,
  listMessages,
  recordMessage,
  upsertChat,
  kvGet,
  kvSet,
  type DBMessage,
  type DBChat,
} from "./db";
import { uploadToGoogleDrive, streamFromGoogleDrive } from "./gdrive";

function jsonResponse(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
      ...headers,
    },
  });
}

function verifyAuth(req: Request, env: AppEnv): boolean {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const cookieToken = getCookie(req, "nm_auth");
  const validToken = env.ADMIN_PASSWORD || "joy12345";
  return token === validToken || cookieToken === validToken;
}

function verifyGateway(req: Request, env: AppEnv): boolean {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const gatewayToken = env.GATEWAY_TOKEN || "nyra_mirror_gateway_secret_key_8899";
  return token === gatewayToken;
}

function getCookie(req: Request, name: string): string | null {
  const cookieStr = req.headers.get("cookie") || "";
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export default {
  async fetch(req: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "Content-Type, Authorization",
        },
      });
    }

    // ─── Direct Media Proxy from Google Drive ────────────────────────────────
    if (path.startsWith("/api/media/")) {
      const fileId = path.replace("/api/media/", "").trim();
      if (!fileId) return new Response("Media not found", { status: 404 });
      const range = req.headers.get("range");
      return streamFromGoogleDrive(env, fileId, range);
    }

    // ─── Authentication Endpoints ──────────────────────────────────────────
    if (path === "/api/login" && req.method === "POST") {
      try {
        const body = (await req.json()) as { email?: string; password?: string };
        const validEmail = env.ADMIN_EMAIL || "joyakter414@gmail.com";
        const validPass = env.ADMIN_PASSWORD || "joy12345";

        const inputEmail = (body.email || "").trim().toLowerCase();
        const inputPass = (body.password || "").trim();

        if (inputEmail === validEmail.toLowerCase() && inputPass === validPass) {
          const cookie = `nm_auth=${encodeURIComponent(validPass)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
          return jsonResponse({ success: true, email: validEmail }, 200, {
            "set-cookie": cookie,
          });
        }
        return jsonResponse({ success: false, error: "Invalid email or password" }, 401);
      } catch (e: any) {
        return jsonResponse({ success: false, error: e.message }, 400);
      }
    }

    if (path === "/api/session" && req.method === "GET") {
      const isAuthed = verifyAuth(req, env);
      return jsonResponse({
        authenticated: isAuthed,
        email: isAuthed ? env.ADMIN_EMAIL || "joyakter414@gmail.com" : null,
      });
    }

    if (path === "/api/logout" && req.method === "POST") {
      return jsonResponse({ success: true }, 200, {
        "set-cookie": "nm_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
      });
    }

    // ─── Gateway Webhooks (From GitHub Cloud 24/7 Engine) ─────────────────
    if (path.startsWith("/api/gateway/")) {
      if (!verifyGateway(req, env)) {
        return jsonResponse({ error: "Unauthorized gateway" }, 401);
      }

      // Gateway Status & QR update
      if (path === "/api/gateway/update" && req.method === "POST") {
        const body = (await req.json()) as any;
        const accountId = body.account_id === "acc2" ? "acc2" : "acc1";

        if (body.type === "status") {
          await setAccountStatus(env, accountId, {
            state: body.state,
            qr: body.qr,
            me: body.me,
            error: body.error,
          });
          return jsonResponse({ ok: true });
        }

        if (body.type === "message") {
          const msg = body.message as DBMessage;
          msg.account_id = accountId;
          await recordMessage(env, msg);

          if (body.chat) {
            const chat = body.chat as DBChat;
            chat.account_id = accountId;
            await upsertChat(env, chat);
          }
          return jsonResponse({ ok: true });
        }

        if (body.type === "chat") {
          const chat = body.chat as DBChat;
          chat.account_id = accountId;
          await upsertChat(env, chat);
          return jsonResponse({ ok: true });
        }

        return jsonResponse({ ok: true });
      }

      // Gateway Media Upload (Streams directly into Google Drive!)
      if (path === "/api/gateway/media" && req.method === "POST") {
        try {
          const contentType = req.headers.get("content-type") || "";
          let filename = req.headers.get("x-filename") || `wa_media_${Date.now()}`;
          let mime = req.headers.get("x-mime") || "application/octet-stream";
          let buffer: ArrayBuffer;

          if (contentType.includes("application/json")) {
            const body = (await req.json()) as { filename?: string; mime?: string; base64: string };
            if (body.filename) filename = body.filename;
            if (body.mime) mime = body.mime;
            const bin = atob(body.base64);
            const u8 = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
            buffer = u8.buffer;
          } else {
            buffer = await req.arrayBuffer();
          }

          const upload = await uploadToGoogleDrive(env, filename, mime, buffer);
          if (upload) {
            return jsonResponse({ success: true, fileId: upload.id, viewUrl: upload.viewUrl });
          }
          return jsonResponse({ success: false, error: "Drive upload failed" }, 500);
        } catch (e: any) {
          return jsonResponse({ success: false, error: e.message }, 500);
        }
      }

      // Gateway Outbound Message Polling (for dashboard replies)
      if (path === "/api/gateway/outbound" && req.method === "GET") {
        const account = url.searchParams.get("account") === "acc2" ? "acc2" : "acc1";
        const key = `gateway_outbound_queue_${account}`;
        const queue = (await kvGet<Array<{ id: string; jid: string; text: string }>>(env, key)) || [];
        if (queue.length > 0) {
          await kvSet(env, key, []); // clear queue once fetched
        }
        return jsonResponse({ outbound: queue });
      }

      // Gateway Encrypted Session Store (R2 Bucket Sync)
      if (path === "/api/gateway/session") {
        const account = url.searchParams.get("account") === "acc2" ? "acc2" : "acc1";
        const key = `sessions/${account}/session.enc`;

        if (req.method === "GET") {
          const obj = await env.BUCKET.get(key);
          if (!obj) return new Response(null, { status: 404 });
          const headers = new Headers();
          obj.writeHttpMetadata(headers);
          headers.set("etag", obj.httpEtag);
          return new Response(obj.body, { headers });
        }

        if (req.method === "POST") {
          const buffer = await req.arrayBuffer();
          await env.BUCKET.put(key, buffer);
          return jsonResponse({ ok: true });
        }

        if (req.method === "DELETE") {
          await env.BUCKET.delete(key);
          await setAccountStatus(env, account, {
            state: "disconnected",
            qr: null,
            me: null,
          });
          return jsonResponse({ ok: true });
        }
      }
    }

    // ─── Dashboard Protected API Endpoints ────────────────────────────────
    if (path.startsWith("/api/")) {
      if (!verifyAuth(req, env)) {
        return jsonResponse({ error: "Unauthorized" }, 401);
      }

      // Dual Status: Returns both accounts' live connection and QR state
      if (path === "/api/status" && req.method === "GET") {
        const [acc1, acc2] = await Promise.all([
          getAccountStatus(env, "acc1"),
          getAccountStatus(env, "acc2"),
        ]);
        return jsonResponse({ acc1, acc2 });
      }

      // Get Chat List for selected account
      if (path === "/api/chats" && req.method === "GET") {
        const account = (url.searchParams.get("account") === "acc2" ? "acc2" : "acc1") as "acc1" | "acc2";
        const search = url.searchParams.get("search");
        const limit = parseInt(url.searchParams.get("limit") || "100", 10);
        const chats = await listChats(env, account, search, limit);
        return jsonResponse({ chats });
      }

      // Get Messages for a specific chat
      if (path === "/api/messages" && req.method === "GET") {
        const account = (url.searchParams.get("account") === "acc2" ? "acc2" : "acc1") as "acc1" | "acc2";
        const chatId = url.searchParams.get("chatId") || "";
        const limit = parseInt(url.searchParams.get("limit") || "80", 10);
        const before = url.searchParams.get("before") ? parseInt(url.searchParams.get("before")!, 10) : null;

        if (!chatId) return jsonResponse({ error: "Missing chatId" }, 400);

        const messages = await listMessages(env, account, chatId, limit, before);
        return jsonResponse({ messages });
      }

      // Send direct message / reply to WhatsApp chat
      if (path === "/api/messages/send" && req.method === "POST") {
        try {
          const body = (await req.json()) as { account?: string; chat?: string; text?: string };
          const account = body.account === "acc2" ? "acc2" : "acc1";
          const chat = (body.chat || "").trim();
          const text = (body.text || "").trim();

          if (!chat || !text) {
            return jsonResponse({ error: "chat and text are required" }, 400);
          }

          const msgId = `dash_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const now = Date.now();

          // 1. Immediately insert into DB for instant UI reflection
          await recordMessage(env, {
            id: msgId,
            account_id: account,
            chat_id: chat,
            role: "assistant",
            sender: "You",
            sender_name: "You",
            content: text,
            source: "dashboard-reply",
            created_at: now,
          });

          // 2. Update chat timestamp & snippet
          await upsertChat(env, {
            account_id: account,
            chat_id: chat,
            is_group: chat.includes("@g.us") ? 1 : 0,
            last_at: now,
            last_msg: text,
            unread: 0,
          });

          // 3. Queue for gateway to dispatch via Baileys socket
          const key = `gateway_outbound_queue_${account}`;
          const queue = (await kvGet<Array<{ id: string; jid: string; text: string }>>(env, key)) || [];
          queue.push({ id: msgId, jid: chat, text });
          await kvSet(env, key, queue);

          return jsonResponse({ ok: true, id: msgId, text, created_at: now });
        } catch (e: any) {
          return jsonResponse({ error: e.message }, 500);
        }
      }

      // Disconnect / Reset Account
      if (path === "/api/disconnect" && req.method === "POST") {
        const body = (await req.json()) as { account?: string };
        const account = body.account === "acc2" ? "acc2" : "acc1";
        await env.BUCKET.delete(`sessions/${account}/session.enc`);
        await setAccountStatus(env, account, {
          state: "disconnected",
          qr: null,
          me: null,
        });
        await kvSet(env, `cmd_${account}`, { cmd: "restart", at: Date.now() });
        return jsonResponse({ success: true });
      }
    }

    // ─── Static Frontend Assets ──────────────────────────────────────────
    if (env.ASSETS) {
      return env.ASSETS.fetch(req);
    }

    return new Response("Nyra Mirror Cloud Backend Active", { status: 200 });
  },
};
