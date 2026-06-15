CREATE TABLE web_push_subscriptions (
  id BLOB PRIMARY KEY NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);

