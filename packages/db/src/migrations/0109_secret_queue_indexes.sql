CREATE INDEX thread_secrets_delivery ON public.thread_secrets USING btree (thread_id, id) WHERE (revision > applied_revision);
CREATE INDEX thread_secrets_active ON public.thread_secrets USING btree (thread_id, expires_at, id) WHERE (status = ANY (ARRAY['saved'::text, 'pending'::text]));
