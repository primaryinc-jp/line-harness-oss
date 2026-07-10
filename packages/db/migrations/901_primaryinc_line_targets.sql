-- 901 (fork-local primaryinc migration): LINE group/room conversation targets
-- (P0 group support). Fork-local migrations use the 900+ prefix so they can
-- never collide with upstream's numbered migrations (see docs/STAFF_MESSAGE_SENDER.md).
--
-- line_targets: group/room conversation targets. Rows are registered when the
-- official account joins a group/room (join event) or when a message occurs
-- in one. `metadata` is a JSON TEXT column mirroring friends.metadata so the
-- sales-harness link fields (salesCustomerPageId, salesDealPageId, ...) work
-- identically for 1:1 friends and group targets. membership_updated_at is the
-- LINE event.timestamp (ms) of the last join/leave applied; it guards
-- membership transitions against out-of-order webhook redelivery.
CREATE TABLE IF NOT EXISTS line_targets (
  id               TEXT PRIMARY KEY,
  target_type      TEXT NOT NULL CHECK (target_type IN ('group', 'room')),
  line_target_id   TEXT UNIQUE NOT NULL,
  display_name     TEXT,
  picture_url      TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  line_account_id  TEXT,
  metadata         TEXT,
  last_message_at  TEXT,
  membership_updated_at INTEGER,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_line_targets_line_target_id ON line_targets (line_target_id);
CREATE INDEX IF NOT EXISTS idx_line_targets_type ON line_targets (target_type);
CREATE INDEX IF NOT EXISTS idx_line_targets_last_message_at ON line_targets (last_message_at);

-- target_messages_log: message history for group/room targets. A parallel
-- table (not new columns on messages_log) because messages_log.friend_id is
-- NOT NULL with an FK to friends and group messages have no friend row.
-- sender_line_user_id / sender_display_name attribute incoming messages to
-- the group member who sent them. line_message_id is the LINE message id of
-- incoming webhook messages; the partial UNIQUE index below makes inserts
-- idempotent against LINE webhook redelivery (outgoing rows keep it NULL).
CREATE TABLE IF NOT EXISTS target_messages_log (
  id                   TEXT PRIMARY KEY,
  target_id            TEXT NOT NULL REFERENCES line_targets (id) ON DELETE CASCADE,
  direction            TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type         TEXT NOT NULL,
  content              TEXT NOT NULL,
  sender_line_user_id  TEXT,
  sender_display_name  TEXT,
  source               TEXT,
  line_account_id      TEXT,
  sender_staff_id      TEXT,
  sender_name          TEXT,
  sender_icon_url      TEXT,
  line_message_id      TEXT,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_target_messages_log_target_id ON target_messages_log (target_id);
CREATE INDEX IF NOT EXISTS idx_target_messages_log_created_at ON target_messages_log (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_target_messages_log_line_message_id
  ON target_messages_log (target_id, line_message_id)
  WHERE line_message_id IS NOT NULL;
