/** App/conversation/workflow schema after the one-time Alo partition. */
export const APP_SCHEMA = `
CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'regular',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      , head_id TEXT);
CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        parent_id TEXT,
        role TEXT NOT NULL,
        content_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'complete',
        created_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
      );
CREATE TABLE turn_events (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, attribution_json TEXT,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
CREATE TABLE voice_drafts (
    thread_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL,
    created_at INTEGER NOT NULL, content_sha256 TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
CREATE TABLE "queued_turns" (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    branch_anchor TEXT,
    source TEXT NOT NULL CHECK (source IN ('typed', 'voice')),
    text TEXT NOT NULL,
    attachment_refs_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN (
      'queued', 'editing', 'running', 'awaiting_approval', 'failed',
      'interrupted', 'pinned', 'completed', 'cancelled'
    )),
    sequence INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0,
    edit_token TEXT,
    released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1)),
    turn_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
CREATE TABLE composer_buffers (
    thread_id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    attachment_refs_json TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
  );
CREATE TABLE workflow_executions (
        id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, definition_version INTEGER NOT NULL CHECK(definition_version>0),
        state_schema_version INTEGER NOT NULL DEFAULT 1 CHECK(state_schema_version>0),
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE, branch_anchor_id TEXT,
        request_message_id TEXT NOT NULL, parameters_json TEXT NOT NULL, targets_json TEXT NOT NULL DEFAULT '{}',
        current_step_id TEXT, current_step_run_id TEXT, checkpoint_json TEXT NOT NULL, outcome_json TEXT,
        status TEXT NOT NULL CHECK(status IN ('running','awaiting_input','suspended','completed','failed','cancelled')),
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0), reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
CREATE TABLE workflow_step_results (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
        step_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0), turn_id TEXT NOT NULL,
        schema_id TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','awaiting_input','failed','cancelled','blocked','not_supported')),
        result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(execution_id,step_id,ordinal)
      );
CREATE TABLE workflow_action_attempts (
        id TEXT PRIMARY KEY, execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
        step_run_id TEXT NOT NULL REFERENCES workflow_step_results(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK(ordinal>=0), action_id TEXT NOT NULL, args_digest TEXT NOT NULL,
        preconditions_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('claimed','dispatched','completed','blocked','uncertain')),
        receipt_id TEXT NOT NULL, operation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(execution_id,step_run_id,ordinal)
      );
CREATE TABLE workflow_execution_turns (
        execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
        turn_id TEXT NOT NULL, user_message_id TEXT NOT NULL, assistant_message_id TEXT NOT NULL,
        relation TEXT NOT NULL CHECK(relation IN ('start','resume','clarify','cancel')), created_at INTEGER NOT NULL,
        PRIMARY KEY(execution_id,turn_id)
      );
CREATE TABLE workflow_content_refs (
        execution_id TEXT NOT NULL REFERENCES workflow_executions(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL, PRIMARY KEY(execution_id,attachment_id)
      );
CREATE INDEX idx_messages_thread ON messages(thread_id);
CREATE INDEX idx_turn_events_message ON turn_events(message_id, seq);
CREATE INDEX idx_attachments_thread
    ON attachments(thread_id, created_at);
CREATE INDEX idx_queued_turns_thread
    ON queued_turns(thread_id, sequence);
CREATE INDEX workflow_executions_branch ON workflow_executions(thread_id,branch_anchor_id,status);
CREATE UNIQUE INDEX workflow_one_foreground_pending ON workflow_executions(thread_id,ifnull(branch_anchor_id,'')) WHERE status='awaiting_input';
`;
