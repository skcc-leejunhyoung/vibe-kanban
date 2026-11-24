ALTER TABLE agent_memory_snapshots
    DROP CONSTRAINT agent_memory_snapshots_source_agent_check,
    ADD CONSTRAINT agent_memory_snapshots_source_agent_check
        CHECK (source_agent IN ('claude_code', 'codex', 'opencode_v2')),
    ADD CONSTRAINT agent_memory_snapshots_opencode_repository_check
        CHECK (source_agent <> 'opencode_v2' OR scope = 'repository');

ALTER TABLE agent_memory_receipts
    DROP CONSTRAINT agent_memory_receipts_target_agent_check,
    ADD CONSTRAINT agent_memory_receipts_target_agent_check
        CHECK (target_agent IN ('claude_code', 'codex', 'opencode_v2'));

ALTER TABLE agent_memory_mutation_receipts
    DROP CONSTRAINT agent_memory_mutation_receipts_target_agent_check,
    ADD CONSTRAINT agent_memory_mutation_receipts_target_agent_check
        CHECK (target_agent IN ('claude_code', 'codex', 'opencode_v2')),
    ADD CONSTRAINT agent_memory_mutation_receipts_opencode_repository_check
        CHECK (target_agent <> 'opencode_v2' OR target_scope_key <> '');
