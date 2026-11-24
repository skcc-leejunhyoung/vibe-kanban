-- Only overflow report fragments carry an execution scope.
ALTER TABLE drawer_comments ADD COLUMN report_execution_id UUID;
