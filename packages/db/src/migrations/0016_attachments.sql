-- Attachments (docs/ui-api.md, "Załączniki"; docs/data-model.md): files a user adds to a message.
-- The bytes are a content-addressed blob; the row says whose it is, what the gateway found it to be (from the
-- content, not the name) and, once sent, which message (thread, turn) it belongs to. An attachment is bound once.
CREATE TABLE attachments (
  id              uuid PRIMARY KEY,
  owner_user_id   uuid NOT NULL REFERENCES users (id),
  sha256          text NOT NULL REFERENCES blobs (sha256),
  -- WebP preview of an image (UI only; the agent gets the file).
  thumb_sha256    text REFERENCES blobs (sha256),
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 255 AND name !~ '[/\\[:cntrl:]]' AND name NOT IN ('.', '..')),
  mime_type       text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('image', 'file')),
  size_bytes      bigint NOT NULL CHECK (size_bytes >= 0),
  width           integer CHECK (width > 0),
  height          integer CHECK (height > 0),
  thread_id       uuid REFERENCES threads (id),
  turn_id         uuid REFERENCES turns (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attachments_bound_together CHECK ((thread_id IS NULL) = (turn_id IS NULL))
);
CREATE INDEX attachments_turn ON attachments (turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX attachments_unbound ON attachments (owner_user_id, created_at) WHERE thread_id IS NULL;

-- Blobs a thread's transcript points to (Image.blob, ToolCall.images: previews the worker uploaded). The UI may read
-- a blob only through a thread of its tree that references it. No foreign key to blobs: a reference whose preview
-- never arrived (lost with the worker) stays and is answered with "not found".
CREATE TABLE thread_blobs (
  thread_id  uuid NOT NULL REFERENCES threads (id),
  sha256     text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  PRIMARY KEY (thread_id, sha256)
);
