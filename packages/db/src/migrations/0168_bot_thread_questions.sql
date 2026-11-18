CREATE TABLE bot_thread_question_deliveries (
  call_id uuid NOT NULL REFERENCES bot_thread_watches(call_id) ON DELETE CASCADE,
  request_id uuid NOT NULL REFERENCES interaction_requests(id) ON DELETE CASCADE,
  PRIMARY KEY (call_id, request_id)
);
