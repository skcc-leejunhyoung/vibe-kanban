-- Store the user-selected primary remote (e.g. "origin", "upstream") per repo.
-- Used by the repo settings push/fetch buttons; NULL falls back to the git
-- default remote.
ALTER TABLE repos ADD COLUMN primary_remote TEXT;
