-- Diagnostic metadata only: never retain exception text or transcript content.
ALTER TABLE thread_range_failures ADD COLUMN frame_bytes bigint NOT NULL DEFAULT 0
  CHECK (frame_bytes BETWEEN 0 AND 4294967295);
