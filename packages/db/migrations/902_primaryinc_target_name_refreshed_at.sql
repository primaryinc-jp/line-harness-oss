-- 902 (fork-local primaryinc migration): track when a target's display name
-- was last fetched from the LINE group summary API, so a stale name (the group
-- was renamed after we first saw it) can be refreshed on a later message.
-- Fork-local migrations use the 900+ prefix so they never collide with
-- upstream's numbered migrations (see docs/STAFF_MESSAGE_SENDER.md).
--
-- name_refreshed_at is the LINE event.timestamp (ms) of the last successful
-- group-summary fetch. Group names were previously only fetched on join or when
-- the name was still unknown, so a rename would leave a stale name forever.
ALTER TABLE line_targets ADD COLUMN name_refreshed_at INTEGER;
