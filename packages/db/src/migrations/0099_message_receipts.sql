-- A receipt covers every SendMessage outcome, including platform commands without a turn.
CREATE TABLE thread_message_receipts (
  thread_id uuid NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  client_request_id text NOT NULL,
  response bytea NOT NULL,
  PRIMARY KEY(thread_id,client_request_id)
);
