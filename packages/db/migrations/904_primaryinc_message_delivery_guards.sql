-- This migration intentionally contains only idempotent CREATE IF NOT EXISTS
-- statements. It must still complete when a file-level runner skipped the tail
-- of an older 903 after a duplicate-column error.

-- Repair a database where an older 903 used an account-scoped composite key.
-- Duplicate legacy rows make this fail closed for explicit operator cleanup.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_delivery_idempotency_request_global
  ON message_delivery_idempotency(client_request_id);

-- Account ownership may not change while a delivery is in flight. A crashed
-- request therefore fails closed and must be reconciled before relinking.
CREATE TRIGGER IF NOT EXISTS prevent_friend_account_change_during_delivery
BEFORE UPDATE OF line_account_id ON friends
WHEN OLD.line_account_id IS NOT NEW.line_account_id
 AND EXISTS (
   SELECT 1 FROM message_delivery_idempotency mdi
   WHERE mdi.friend_id = OLD.id AND mdi.status = 'in_progress'
 )
BEGIN SELECT RAISE(ABORT, 'friend has an in-progress idempotent delivery'); END;

-- A global idempotency key is safety history, not child data. Even databases
-- created by an older 903 with ON DELETE CASCADE must retain it. Operators must
-- anonymize or detach application data rather than deleting this ledger row.
CREATE TRIGGER IF NOT EXISTS prevent_friend_delete_with_delivery_history
BEFORE DELETE ON friends
WHEN EXISTS (
  SELECT 1 FROM message_delivery_idempotency mdi WHERE mdi.friend_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'friend has message delivery idempotency history'); END;
