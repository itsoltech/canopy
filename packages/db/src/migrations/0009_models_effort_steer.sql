-- Models, reasoning effort and steering (docs/ui-api.md, docs/protocol.md#modele-effort-i-steer).

-- A worker's model catalog from its last report (ModelCatalog, ListModels): the protobuf JSON of
-- worker.v1 ProfileModels, one entry per provider + profile. Replaced as a whole.
CREATE TABLE worker_model_catalogs (
  worker_id       uuid PRIMARY KEY REFERENCES workers (id),
  config_version  bigint NOT NULL DEFAULT 0,
  profiles        jsonb NOT NULL DEFAULT '[]',
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Reasoning effort of a turn (the model column already exists): the message's override while queued,
-- the values sent to the worker once the turn starts. '' = the thread's default / the profile's.
ALTER TABLE turns ADD COLUMN effort text NOT NULL DEFAULT '';

-- Messages delivered into a running turn (SendMessage delivery = steer; send_message delivery = steer).
-- id = SteerTurn.input_id = the client_id of the user_message item where the message entered the turn.
-- A steer that cannot enter its turn becomes the next turn (queued_turn_id) with a reason.
CREATE TABLE turn_steers (
  id                 uuid PRIMARY KEY,
  thread_id          uuid NOT NULL REFERENCES threads (id),
  turn_id            uuid NOT NULL,
  -- What the model gets (input.text) and, for a fallback turn, the same split as a queued turn's input.
  input              jsonb NOT NULL,
  author_user_id     uuid REFERENCES users (id),
  agent_call_id      uuid REFERENCES agent_bus_calls (id),
  hops               smallint NOT NULL DEFAULT 0 CHECK (hops BETWEEN 0 AND 16),
  client_request_id  text,
  -- Used only when the message falls back to the queue.
  model              text NOT NULL DEFAULT '',
  effort             text NOT NULL DEFAULT '',
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'accepted', 'delivered', 'dropped', 'queued', 'failed')),
  reason             text,
  queued_turn_id     uuid,
  delivered_seq      bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (turn_id, thread_id) REFERENCES turns (id, thread_id),
  FOREIGN KEY (queued_turn_id, thread_id) REFERENCES turns (id, thread_id),
  CONSTRAINT turn_steers_author CHECK ((author_user_id IS NULL) <> (agent_call_id IS NULL)),
  CONSTRAINT turn_steers_queued CHECK ((status = 'queued') = (queued_turn_id IS NOT NULL))
);

CREATE UNIQUE INDEX turn_steers_client_request ON turn_steers (thread_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE INDEX turn_steers_thread ON turn_steers (thread_id, created_at);
