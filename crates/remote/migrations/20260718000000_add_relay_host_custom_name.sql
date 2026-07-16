ALTER TABLE hosts ADD COLUMN custom_name TEXT;

ALTER TABLE hosts ADD CONSTRAINT hosts_custom_name_length
    CHECK (custom_name IS NULL OR char_length(custom_name) BETWEEN 1 AND 100);
