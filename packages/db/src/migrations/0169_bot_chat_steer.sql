-- A queued owner message can join a running turn. Keep the original row for send idempotency.
ALTER TABLE bot_turns ADD COLUMN steer_target_id uuid REFERENCES bot_turns(id);
