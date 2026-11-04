-- Ukryte sesje harnessów botów nie są wątkami projektowymi.
CREATE TABLE bot_harness_turns (
    turn_id uuid PRIMARY KEY REFERENCES bot_turns(id),
    bot_id uuid NOT NULL REFERENCES bots(id),
    worker_id uuid NOT NULL REFERENCES workers(id),
    command_id uuid NOT NULL UNIQUE REFERENCES worker_commands(id),
    text text NOT NULL DEFAULT '',
    outcome integer,
    source integer NOT NULL DEFAULT 0,
    reason text NOT NULL DEFAULT '',
    error_code text NOT NULL DEFAULT '',
    items jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE bot_harness_events (
    event_id uuid PRIMARY KEY,
    turn_id uuid NOT NULL REFERENCES bot_harness_turns(turn_id),
    worker_id uuid NOT NULL REFERENCES workers(id),
    journal_id text NOT NULL,
    journal_seq bigint NOT NULL,
    payload bytea NOT NULL
);
CREATE INDEX bot_harness_events_cursor ON bot_harness_events(worker_id, journal_id);
