-- Safe, globally keyed idempotency with account ownership assertions for
-- API-triggered 1:1 LINE deliveries.
-- The request body is represented only by request_hash; message content stays
-- in the existing messages_log after a confirmed send.
CREATE TABLE IF NOT EXISTS message_delivery_idempotency (
  line_account_id  TEXT NOT NULL,
  client_request_id TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  request_hash     TEXT NOT NULL,
  status           TEXT NOT NULL CHECK (status IN ('in_progress', 'sent', 'failed', 'uncertain')),
  message_log_id   TEXT,
  error_code       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  -- A delivery intent key is global. Keeping the account outside the key
  -- prevents a friend relink from making the same intent sendable again.
  PRIMARY KEY (client_request_id),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_message_delivery_idempotency_status
  ON message_delivery_idempotency(status, updated_at);

-- Fresh and existing databases both add this exactly once. Keeping the column
-- out of CREATE TABLE avoids a guaranteed duplicate-column error in file-level
-- migration runners. A partially-applied older 903 may still report duplicate;
-- the following 904 contains every safety object that must run afterwards.
ALTER TABLE message_delivery_idempotency ADD COLUMN dispatch_claimed_at TEXT;
