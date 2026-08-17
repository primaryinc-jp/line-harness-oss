-- Owner identity for manual resolution of a provider-dispatch claim.
ALTER TABLE message_delivery_idempotency ADD COLUMN resolved_by_staff_id TEXT;
