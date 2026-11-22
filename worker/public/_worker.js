// src/db.ts
var memKVCache = /* @__PURE__ */ new Map();
async function kvGet(env, key) {
  const cached = memKVCache.get(key);
  if (cached && Date.now() - cached.time < 5e3) {
    return cached.val;
  }
  try {
    if (env.DB) {
      const row = await env.DB.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first();
      if (row) {
        try {
          const parsed = JSON.parse(row.value);
          memKVCache.set(key, { val: parsed, time: Date.now() });
          return parsed;
        } catch {
          memKVCache.set(key, { val: row.value, time: Date.now() });
          return row.value;
        }
      }
    }
  } catch (err) {
    console.warn(`[D1 kvGet warning for ${key}]:`, err?.message || err);
  }
  if (cached) {
    return cached.val;
  }
  try {
    if (env.BUCKET) {
      const obj = await env.BUCKET.get(`kv/${key}.json`);
      if (obj) {
        const text = await obj.text();
        const parsed = JSON.parse(text);
        memKVCache.set(key, { val: parsed, time: Date.now() });
        return parsed;
      }
    }
  } catch {
  }
  return null;
}
async function kvSet(env, key, value) {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  memKVCache.set(key, { val: value, time: Date.now() });
  try {
    if (env.DB) {
      await env.DB.prepare(
        "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).bind(key, str, Date.now()).run();
    }
  } catch (err) {
    console.warn(`[D1 kvSet warning for ${key}]:`, err?.message || err);
  }
  try {
    if (env.BUCKET) {
      await env.BUCKET.put(`kv/${key}.json`, str);
    }
  } catch {
  }
}
async function recordMessage(env, m) {
  try {
    if (!env.DB) return;
    await env.DB.prepare(
      `INSERT INTO messages (id, account_id, chat_id, role, sender, sender_name, content, source, created_at, media_type, media_url, media_id, media_mime, quoted_text, quoted_sender, deleted_at, deleted_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id, account_id) DO UPDATE SET
         content = excluded.content,
         media_url = coalesce(excluded.media_url, messages.media_url),
         media_id = coalesce(excluded.media_id, messages.media_id),
         quoted_text = coalesce(excluded.quoted_text, messages.quoted_text),
         quoted_sender = coalesce(excluded.quoted_sender, messages.quoted_sender),
         deleted_at = excluded.deleted_at,
         deleted_by = excluded.deleted_by`
    ).bind(
      m.id,
      m.account_id,
      m.chat_id,
      m.role,
      m.sender || null,
      m.sender_name || null,
      m.content,
      m.source || "whatsapp",
      m.created_at || Date.now(),
      m.media_type || null,
      m.media_url || null,
      m.media_id || null,
      m.media_mime || null,
      m.quoted_text || null,
      m.quoted_sender || null,
      m.deleted_at || 0,
      m.deleted_by || null
    ).run();
  } catch (err) {
    console.error(`[recordMessage error]:`, err?.message || err);
  }
}
async function upsertChat(env, c) {
  try {
    if (!env.DB) return;
    await env.DB.prepare(
      `INSERT INTO chats (account_id, chat_id, name, is_group, last_at, last_msg, notify_name, phone, avatar_url, unread)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, chat_id) DO UPDATE SET
         name = coalesce(excluded.name, chats.name),
         last_at = max(chats.last_at, excluded.last_at),
         last_msg = coalesce(excluded.last_msg, chats.last_msg),
         notify_name = coalesce(excluded.notify_name, chats.notify_name),
         phone = coalesce(excluded.phone, chats.phone),
         avatar_url = coalesce(excluded.avatar_url, chats.avatar_url),
         unread = excluded.unread`
    ).bind(
      c.account_id,
      c.chat_id,
      c.name || null,
      c.is_group ? 1 : 0,
      c.last_at,
      c.last_msg || null,
      c.notify_name || null,
      c.phone || null,
      c.avatar_url || null,
      c.unread || 0
    ).run();
  } catch (err) {
    console.error(`[upsertChat error]:`, err?.message || err);
  }
}
async function listChats(env, accountId, search, limit = 100) {
  try {
    if (!env.DB) return [];
    let query = "SELECT * FROM chats WHERE account_id = ?";
    const params = [accountId];
    if (search && search.trim()) {
      query += " AND (name LIKE ? OR notify_name LIKE ? OR phone LIKE ? OR chat_id LIKE ?)";
      const term = `%${search.trim()}%`;
      params.push(term, term, term, term);
    }
    query += " ORDER BY last_at DESC LIMIT ?";
    params.push(limit);
    const res = await env.DB.prepare(query).bind(...params).all();
    return res.results || [];
  } catch (err) {
    console.warn(`[listChats warning]:`, err?.message || err);
    return [];
  }
}
async function listMessages(env, accountId, chatId, limit = 100, before) {
  try {
    if (!env.DB) return [];
    let query = "SELECT * FROM messages WHERE account_id = ? AND chat_id = ?";
    const params = [accountId, chatId];
    if (before && before > 0) {
      query += " AND created_at < ?";
      params.push(before);
    }
    query += " ORDER BY created_at DESC LIMIT ?";
    params.push(limit);
    const res = await env.DB.prepare(query).bind(...params).all();
    return (res.results || []).reverse();
  } catch (err) {
    console.warn(`[listMessages warning]:`, err?.message || err);
    return [];
  }
}
async function getAccountStatus(env, accountId) {
  const status = await kvGet(env, `status_${accountId}`);
  if (status) return status;
  return {
    state: "disconnected",
    qr: null,
    me: null,
    updated_at: Date.now()
  };
}
async function setAccountStatus(env, accountId, status) {
  const current = await getAccountStatus(env, accountId);
  const updated = {
    ...current,
    ...status,
    updated_at: Date.now()
  };
  await kvSet(env, `status_${accountId}`, updated);
}

// src/gdrive.ts
var cachedAccessToken = null;
async function getGDriveConfig(env) {
  const cfg = await kvGet(env, "gdrive_config");
  const clientId = env.GDRIVE_CLIENT_ID || cfg?.clientId;
  const clientSecret = env.GDRIVE_CLIENT_SECRET || cfg?.clientSecret;
  const refreshToken = env.GDRIVE_REFRESH_TOKEN || cfg?.refreshToken;
  const folderId = env.GDRIVE_FOLDER_ID || cfg?.folderId || "19Onv9HwLXhoZjMTc5UvoxsrDyqr5UWy2";
  if (clientId && clientSecret && refreshToken) {
    return {
      enabled: true,
      clientId,
      clientSecret,
      refreshToken,
      folderId,
      account: "joyakter414@gmail.com"
    };
  }
  return null;
}
async function getGDriveAccessToken(env) {
  const cfg = await getGDriveConfig(env);
  if (!cfg) {
    console.error("Google Drive OAuth credentials missing");
    return null;
  }
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now() + 6e4) {
    return cachedAccessToken.token;
  }
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken,
        grant_type: "refresh_token"
      })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error("GDrive token refresh failed:", res.status, err);
      return null;
    }
    const data = await res.json();
    if (!data.access_token) return null;
    cachedAccessToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1e3
    };
    return data.access_token;
  } catch (err) {
    console.error("GDrive OAuth fetch error:", err);
    return null;
  }
}
async function uploadToGoogleDrive(env, filename, mime, buffer, customFolderId) {
  const cfg = await getGDriveConfig(env);
  const accessToken = await getGDriveAccessToken(env);
  if (!accessToken) return null;
  const folderId = customFolderId || cfg?.folderId || env.GDRIVE_FOLDER_ID || "19Onv9HwLXhoZjMTc5UvoxsrDyqr5UWy2";
  const boundary = "-------NyraMirrorDriveBoundary982374";
  const delimiter = `\r
--${boundary}\r
`;
  const closeDelimiter = `\r
--${boundary}--`;
  const metadata = {
    name: filename,
    mimeType: mime
  };
  if (folderId) {
    metadata.parents = [folderId];
  }
  const metaPart = `${delimiter}Content-Type: application/json; charset=UTF-8\r
\r
${JSON.stringify(metadata)}\r
`;
  const mediaHeader = `${delimiter}Content-Type: ${mime}\r
Content-Transfer-Encoding: binary\r
\r
`;
  const metaBytes = new TextEncoder().encode(metaPart);
  const mediaHeaderBytes = new TextEncoder().encode(mediaHeader);
  const closeBytes = new TextEncoder().encode(closeDelimiter);
  const bodyBytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const fullLength = metaBytes.length + mediaHeaderBytes.length + bodyBytes.length + closeBytes.length;
  const combined = new Uint8Array(fullLength);
  let offset = 0;
  combined.set(metaBytes, offset);
  offset += metaBytes.length;
  combined.set(mediaHeaderBytes, offset);
  offset += mediaHeaderBytes.length;
  combined.set(bodyBytes, offset);
  offset += bodyBytes.length;
  combined.set(closeBytes, offset);
  try {
    const uploadRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body: combined
    });
    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      console.error("Google Drive upload failed:", uploadRes.status, err);
      return null;
    }
    const file = await uploadRes.json();
    if (!file.id) return null;
    fetch(`https://www.googleapis.com/drive/v3/files/${file.id}/permissions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        role: "reader",
        type: "anyone"
      })
    }).catch(() => {
    });
    return {
      id: file.id,
      viewUrl: `https://lh3.googleusercontent.com/d/${file.id}`
    };
  } catch (err) {
    console.error("GDrive upload exception:", err);
    return null;
  }
}
async function streamFromGoogleDrive(env, fileId, rangeHeader) {
  const accessToken = await getGDriveAccessToken(env);
  if (!accessToken) {
    return new Response("Google Drive authorization unavailable", { status: 503 });
  }
  const headers = {
    Authorization: `Bearer ${accessToken}`
  };
  if (rangeHeader) {
    headers["Range"] = rangeHeader;
  }
  const driveRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers
  });
  if (!driveRes.ok && driveRes.status !== 206) {
    return new Response("Failed to fetch media from Google Drive", { status: driveRes.status });
  }
  const responseHeaders = new Headers();
  const forwardHeaders = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified"
  ];
  for (const h of forwardHeaders) {
    const val = driveRes.headers.get(h);
    if (val) responseHeaders.set(h, val);
  }
  if (!responseHeaders.has("accept-ranges")) {
    responseHeaders.set("accept-ranges", "bytes");
  }
  responseHeaders.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(driveRes.body, {
    status: driveRes.status,
    headers: responseHeaders
  });
}

// src/index.ts
function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
      ...headers
    }
  });
}
function verifyAuth(req, env) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const cookieToken = getCookie(req, "nm_auth");
  const validToken = env.ADMIN_PASSWORD || "joy12345";
  return token === validToken || cookieToken === validToken;
}
function verifyGateway(req, env) {
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const gatewayToken = env.GATEWAY_TOKEN || "nyra_mirror_gateway_secret_key_8899";
  return token === gatewayToken;
}
function getCookie(req, name) {
  const cookieStr = req.headers.get("cookie") || "";
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}
var index_default = {
  async fetch(req, env, ctx) {
    try {
      const url = new URL(req.url);
      const path = url.pathname;
      if (req.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET, POST, OPTIONS",
            "access-control-allow-headers": "Content-Type, Authorization"
          }
        });
      }
      if (path.startsWith("/api/media/")) {
        const fileId = path.replace("/api/media/", "").trim();
        if (!fileId) return new Response("Media not found", { status: 404 });
        const range = req.headers.get("range");
        return await streamFromGoogleDrive(env, fileId, range);
      }
      if (path === "/api/login" && req.method === "POST") {
        try {
          const body = await req.json();
          const validEmail = env.ADMIN_EMAIL || "joyakter414@gmail.com";
          const validPass = env.ADMIN_PASSWORD || "joy12345";
          const inputEmail = (body.email || "").trim().toLowerCase();
          const inputPass = (body.password || "").trim();
          if (inputEmail === validEmail.toLowerCase() && inputPass === validPass) {
            const cookie = `nm_auth=${encodeURIComponent(validPass)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
            return jsonResponse({ success: true, email: validEmail }, 200, {
              "set-cookie": cookie
            });
          }
          return jsonResponse({ success: false, error: "Invalid email or password" }, 401);
        } catch (e) {
          return jsonResponse({ success: false, error: e.message }, 400);
        }
      }
      if (path === "/api/session" && req.method === "GET") {
        const isAuthed = verifyAuth(req, env);
        return jsonResponse({
          authenticated: isAuthed,
          email: isAuthed ? env.ADMIN_EMAIL || "joyakter414@gmail.com" : null
        });
      }
      if (path === "/api/logout" && req.method === "POST") {
        return jsonResponse({ success: true }, 200, {
          "set-cookie": "nm_auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        });
      }
      if (path.startsWith("/api/gateway/")) {
        if (!verifyGateway(req, env)) {
          return jsonResponse({ error: "Unauthorized gateway" }, 401);
        }
        if (path === "/api/gateway/update" && req.method === "POST") {
          const body = await req.json();
          const accountId = body.account_id === "acc2" ? "acc2" : "acc1";
          if (body.type === "status") {
            await setAccountStatus(env, accountId, {
              state: body.state,
              qr: body.qr,
              me: body.me,
              error: body.error
            });
          } else if (body.type === "message") {
            const msg = body.message;
            msg.account_id = accountId;
            await recordMessage(env, msg);
            if (body.chat) {
              const chat = body.chat;
              chat.account_id = accountId;
              await upsertChat(env, chat);
            }
          } else if (body.type === "chat") {
            const chat = body.chat;
            chat.account_id = accountId;
            await upsertChat(env, chat);
          }
          const outKey = `gateway_outbound_queue_${accountId}`;
          const queue = await kvGet(env, outKey) || [];
          if (queue.length > 0) {
            await kvSet(env, outKey, []);
          }
          return jsonResponse({ ok: true, outbound: queue });
        }
        if (path === "/api/gateway/media" && req.method === "POST") {
          try {
            const contentType = req.headers.get("content-type") || "";
            let filename = req.headers.get("x-filename") || `wa_media_${Date.now()}`;
            let mime = req.headers.get("x-mime") || "application/octet-stream";
            let buffer;
            if (contentType.includes("application/json")) {
              const body = await req.json();
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
          } catch (e) {
            return jsonResponse({ success: false, error: e.message }, 500);
          }
        }
        if (path === "/api/gateway/outbound" && req.method === "GET") {
          const account = url.searchParams.get("account") === "acc2" ? "acc2" : "acc1";
          const key = `gateway_outbound_queue_${account}`;
          const queue = await kvGet(env, key) || [];
          if (queue.length > 0) {
            await kvSet(env, key, []);
          }
          return jsonResponse({ outbound: queue });
        }
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
              me: null
            });
            return jsonResponse({ ok: true });
          }
        }
      }
      if (path.startsWith("/api/")) {
        if (!verifyAuth(req, env)) {
          return jsonResponse({ error: "Unauthorized" }, 401);
        }
        if (path === "/api/status" && req.method === "GET") {
          const [acc1, acc2] = await Promise.all([
            getAccountStatus(env, "acc1"),
            getAccountStatus(env, "acc2")
          ]);
          return jsonResponse({ acc1, acc2 });
        }
        if (path === "/api/chats" && req.method === "GET") {
          const account = url.searchParams.get("account") === "acc2" ? "acc2" : "acc1";
          const search = url.searchParams.get("search");
          const limit = parseInt(url.searchParams.get("limit") || "100", 10);
          const chats = await listChats(env, account, search, limit);
          return jsonResponse({ chats });
        }
        if (path === "/api/messages" && req.method === "GET") {
          const account = url.searchParams.get("account") === "acc2" ? "acc2" : "acc1";
          const chatId = url.searchParams.get("chatId") || "";
          const limit = parseInt(url.searchParams.get("limit") || "80", 10);
          const before = url.searchParams.get("before") ? parseInt(url.searchParams.get("before"), 10) : null;
          if (!chatId) return jsonResponse({ error: "Missing chatId" }, 400);
          const messages = await listMessages(env, account, chatId, limit, before);
          return jsonResponse({ messages });
        }
        if (path === "/api/messages/send" && req.method === "POST") {
          try {
            const body = await req.json();
            const account = body.account === "acc2" ? "acc2" : "acc1";
            const chat = (body.chat || "").trim();
            const text = (body.text || "").trim();
            if (!chat || !text) {
              return jsonResponse({ error: "chat and text are required" }, 400);
            }
            const msgId = `dash_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const now = Date.now();
            await recordMessage(env, {
              id: msgId,
              account_id: account,
              chat_id: chat,
              role: "assistant",
              sender: "You",
              sender_name: "You",
              content: text,
              source: "dashboard-reply",
              created_at: now
            });
            await upsertChat(env, {
              account_id: account,
              chat_id: chat,
              is_group: chat.includes("@g.us") ? 1 : 0,
              last_at: now,
              last_msg: text,
              unread: 0
            });
            const key = `gateway_outbound_queue_${account}`;
            const queue = await kvGet(env, key) || [];
            queue.push({ id: msgId, jid: chat, text });
            await kvSet(env, key, queue);
            return jsonResponse({ ok: true, id: msgId, text, created_at: now });
          } catch (e) {
            return jsonResponse({ error: e.message }, 500);
          }
        }
        if (path === "/api/disconnect" && req.method === "POST") {
          const body = await req.json();
          const account = body.account === "acc2" ? "acc2" : "acc1";
          await env.BUCKET.delete(`sessions/${account}/session.enc`);
          await setAccountStatus(env, account, {
            state: "disconnected",
            qr: null,
            me: null
          });
          return jsonResponse({ success: true });
        }
      }
      if (env.ASSETS) {
        return await env.ASSETS.fetch(req);
      }
      return new Response("Nyra Mirror Cloud Backend Active", { status: 200 });
    } catch (fatalErr) {
      console.error("[FATAL Worker Exception]:", fatalErr?.stack || fatalErr?.message || fatalErr);
      return jsonResponse({ error: "Internal Server Error", detail: fatalErr?.message }, 500);
    }
  }
};
export {
  index_default as default
};
