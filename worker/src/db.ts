import type { AppEnv } from "./env";

export interface DBMessage {
  id: string;
  account_id: "acc1" | "acc2";
  chat_id: string;
  role: "user" | "assistant";
  sender?: string | null;
  sender_name?: string | null;
  content: string;
  source: string;
  created_at: number;
  media_type?: string | null;
  media_url?: string | null;
  media_id?: string | null;
  media_mime?: string | null;
  deleted_at?: number;
  deleted_by?: string | null;
}

export interface DBChat {
  account_id: "acc1" | "acc2";
  chat_id: string;
  name?: string | null;
  is_group: number;
  last_at: number;
  last_msg?: string | null;
  notify_name?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  unread: number;
}

export interface AccountStatus {
  state: "starting" | "connecting" | "qr" | "connected" | "disconnected" | "error";
  qr?: string | null;
  me?: {
    pn: string | null;
    lid?: string | null;
    name: string | null;
  } | null;
  updated_at: number;
  error?: string | null;
}

export async function kvGet<T = string>(env: AppEnv, key: string): Promise<T | null> {
  const row = await env.DB.prepare("SELECT value FROM kv WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return row.value as unknown as T;
  }
}

export async function kvSet(env: AppEnv, key: string, value: unknown): Promise<void> {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  await env.DB.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(key, str, Date.now())
    .run();
}

export async function recordMessage(env: AppEnv, m: DBMessage): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO messages (id, account_id, chat_id, role, sender, sender_name, content, source, created_at, media_type, media_url, media_id, media_mime, deleted_at, deleted_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id, account_id) DO UPDATE SET
       content = excluded.content,
       media_url = coalesce(excluded.media_url, messages.media_url),
       media_id = coalesce(excluded.media_id, messages.media_id),
       deleted_at = excluded.deleted_at,
       deleted_by = excluded.deleted_by`
  )
    .bind(
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
      m.deleted_at || 0,
      m.deleted_by || null
    )
    .run();
}

export async function upsertChat(env: AppEnv, c: DBChat): Promise<void> {
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
  )
    .bind(
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
    )
    .run();
}

export async function listChats(
  env: AppEnv,
  accountId: "acc1" | "acc2",
  search?: string | null,
  limit = 100
): Promise<DBChat[]> {
  let query = "SELECT * FROM chats WHERE account_id = ?";
  const params: unknown[] = [accountId];

  if (search && search.trim()) {
    query += " AND (name LIKE ? OR notify_name LIKE ? OR phone LIKE ? OR chat_id LIKE ?)";
    const term = `%${search.trim()}%`;
    params.push(term, term, term, term);
  }

  query += " ORDER BY last_at DESC LIMIT ?";
  params.push(limit);

  const res = await env.DB.prepare(query).bind(...params).all<DBChat>();
  return res.results || [];
}

export async function listMessages(
  env: AppEnv,
  accountId: "acc1" | "acc2",
  chatId: string,
  limit = 100,
  before?: number | null
): Promise<DBMessage[]> {
  let query = "SELECT * FROM messages WHERE account_id = ? AND chat_id = ?";
  const params: unknown[] = [accountId, chatId];

  if (before && before > 0) {
    query += " AND created_at < ?";
    params.push(before);
  }

  query += " ORDER BY created_at DESC LIMIT ?";
  params.push(limit);

  const res = await env.DB.prepare(query).bind(...params).all<DBMessage>();
  // Return in chronological order
  return (res.results || []).reverse();
}

export async function getAccountStatus(env: AppEnv, accountId: "acc1" | "acc2"): Promise<AccountStatus> {
  const status = await kvGet<AccountStatus>(env, `status_${accountId}`);
  if (status) return status;
  return {
    state: "disconnected",
    qr: null,
    me: null,
    updated_at: Date.now(),
  };
}

export async function setAccountStatus(
  env: AppEnv,
  accountId: "acc1" | "acc2",
  status: Partial<AccountStatus>
): Promise<void> {
  const current = await getAccountStatus(env, accountId);
  const updated: AccountStatus = {
    ...current,
    ...status,
    updated_at: Date.now(),
  };
  await kvSet(env, `status_${accountId}`, updated);
}
