-- Nyra Mirror — Dual WhatsApp Cloud D1 Database Schema

CREATE TABLE IF NOT EXISTS messages (
  id          TEXT NOT NULL,
  account_id  TEXT NOT NULL CHECK (account_id IN ('acc1', 'acc2')),
  chat_id     TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  sender      TEXT,
  sender_name TEXT,
  content     TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'whatsapp',
  created_at  INTEGER NOT NULL,
  media_type  TEXT,
  media_url   TEXT,
  media_id    TEXT,
  media_mime  TEXT,
  deleted_at  INTEGER DEFAULT 0,
  deleted_by  TEXT,
  PRIMARY KEY (id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_account_chat ON messages (account_id, chat_id, created_at);

CREATE TABLE IF NOT EXISTS chats (
  account_id  TEXT NOT NULL CHECK (account_id IN ('acc1', 'acc2')),
  chat_id     TEXT NOT NULL,
  name        TEXT,
  is_group    INTEGER NOT NULL DEFAULT 0,
  last_at     INTEGER NOT NULL,
  last_msg    TEXT,
  notify_name TEXT,
  phone       TEXT,
  avatar_url  TEXT,
  unread      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_chats_last_at ON chats (account_id, last_at DESC);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
