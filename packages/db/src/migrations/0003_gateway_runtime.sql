-- Gateway runtime needs (docs/ui-api.md).

-- Why a thread is failed or stuck, shown in the UI (e.g. the provider refused to create it).
ALTER TABLE threads ADD COLUMN status_detail text;

-- The scheduler asks "is there already a StartTurn for this turn in the outbox?".
CREATE INDEX worker_commands_turn ON worker_commands (turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX worker_commands_thread ON worker_commands (thread_id, created_at) WHERE thread_id IS NOT NULL;
