-- Ratings and filing for inbox items.
--
-- inbox_ratings: the like / dislike the user gave an inbox item in the
-- desktop app. The desktop writes it with the signed-in session; an
-- inbox token can only read it through the MCP list_rated_items tool.
-- A cleared rating keeps the row with rating NULL so a stale write
-- (older rated_at) cannot bring it back.
--
-- inbox_filings: "move this inbox item into that collection" requests
-- queued by an inbox token through file_items. The desktop applies
-- them on its next pull and acks. Only items that came through the
-- inbox can be filed, and filing never deletes a save.
--
-- inbox_new_collections: one row per collection name an inbox token
-- asked the desktop to create, used to cap creations per account per
-- day.
--
-- inbox_items.collection_name: add_item can name a collection instead
-- of an id. The desktop matches it case-insensitively or creates it.

ALTER TABLE inbox_items ADD COLUMN collection_name TEXT;

CREATE TABLE inbox_ratings (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id    TEXT NOT NULL,
  rating     TEXT,
  rated_at   INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX idx_inbox_ratings_user_rated ON inbox_ratings (user_id, rated_at);

CREATE TABLE inbox_filings (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id         TEXT NOT NULL,
  token_id        TEXT NOT NULL,
  collection_id   TEXT,
  collection_kind TEXT,
  collection_name TEXT,
  status          TEXT NOT NULL,
  error           TEXT,
  created_at      INTEGER NOT NULL,
  applied_at      INTEGER
);
CREATE INDEX idx_inbox_filings_user_status ON inbox_filings (user_id, status, created_at);
CREATE INDEX idx_inbox_filings_item ON inbox_filings (user_id, item_id);

CREATE TABLE inbox_new_collections (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_key   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, name_key)
);
