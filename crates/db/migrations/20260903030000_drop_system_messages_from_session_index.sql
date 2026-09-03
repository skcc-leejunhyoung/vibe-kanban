-- System/status entries (CLI spinner lines such as "requesting", hook events,
-- model banners, compaction notices, skill-body dumps) are no longer indexed
-- for session search; drop the ones extracted before the rule changed.
DELETE FROM session_message_index WHERE entry_type = 'system_message';
