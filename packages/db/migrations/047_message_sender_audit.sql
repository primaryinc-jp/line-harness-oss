-- Record the staff sender identity used for manual outgoing messages.
ALTER TABLE messages_log ADD COLUMN sender_staff_id TEXT;
ALTER TABLE messages_log ADD COLUMN sender_name TEXT;
ALTER TABLE messages_log ADD COLUMN sender_icon_url TEXT;
