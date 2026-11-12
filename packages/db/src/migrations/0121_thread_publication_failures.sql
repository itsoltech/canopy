-- Retry suppression is durable rather than an unbounded gateway heap map.
-- Only sanitized protocol metadata is stored; never an Error or record content.
CREATE TABLE thread_publication_failures (
  thread_id uuid PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  signature text NOT NULL CHECK (length(signature) <= 128),
  payload bytea NOT NULL CHECK (octet_length(payload) <= 512),
  attempts integer NOT NULL CHECK (attempts > 0),
  retry_at bigint CHECK (retry_at >= 0),
  failed_at bigint NOT NULL CHECK (failed_at >= 0)
);
