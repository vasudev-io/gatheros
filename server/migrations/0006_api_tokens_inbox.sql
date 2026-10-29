-- Inbox tokens and the short-lived inbox queue.
--
-- api_tokens stores sha256(token), never the raw token. Scopes is a
-- JSON array so later scopes (library:read, sync) don't need a new
-- column. v1 only issues ["inbox:write"].
--
-- inbox_items is an account-scoped queue, not the library. The desktop
-- app is still the system of record once an item is imported. R2 holds
-- the original bytes at users/<user_id>/inbox/<item_id>/original.
-- content_hash is sha256 of those original bytes (the same definition
-- the desktop uses), never of the optimized WebP the app stores later.
--
-- inbox_collections is a name catalog the desktop pushes so an MCP
-- client can target a collection or board. It is not the library.

CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  label        TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER,
  expires_at   INTEGER
);
CREATE INDEX idx_api_tokens_user ON api_tokens (user_id);

CREATE TABLE inbox_items (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_id           TEXT NOT NULL,
  kind               TEXT NOT NULL,
  title              TEXT,
  note               TEXT,
  source_name        TEXT,
  source_url         TEXT,
  image_url          TEXT,
  tags               TEXT,
  content_hash       TEXT,
  r2_key             TEXT,
  bytes              INTEGER,
  mime               TEXT,
  collection_id      TEXT,
  collection_kind    TEXT,
  created_at         INTEGER,
  received_at        INTEGER NOT NULL,
  delivered_at       INTEGER,
  delivered_save_id  TEXT,
  status             TEXT NOT NULL,
  error              TEXT,
  deleted_at         INTEGER
);
CREATE INDEX idx_inbox_items_user_status
  ON inbox_items (user_id, status, received_at);
-- One live copy of a given original per account. Tombstoned rows
-- (deleted_at set) drop out of the index so the same bytes can be
-- sent again later. NULL hashes (URL-only items) are not indexed.
CREATE UNIQUE INDEX idx_inbox_items_user_hash
  ON inbox_items (user_id, content_hash)
  WHERE content_hash IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE inbox_collections (
  user_id       TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, collection_id)
);
