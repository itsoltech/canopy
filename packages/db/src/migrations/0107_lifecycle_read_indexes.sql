CREATE INDEX worker_commands_redelivery_expiry ON public.worker_commands USING btree (worker_id, created_at, id, expires_at) WHERE (status = ANY (ARRAY['pending'::text, 'delivered'::text]));
CREATE INDEX worker_commands_live_expiry ON public.worker_commands USING btree (worker_id, expires_at) WHERE (status = ANY (ARRAY['pending'::text, 'delivered'::text]));
CREATE INDEX worker_commands_thread_busy ON public.worker_commands USING btree (thread_id, expires_at) WHERE ((status = ANY (ARRAY['pending'::text, 'delivered'::text])) AND (kind = ANY (ARRAY['startTurn'::text, 'createThread'::text, 'setGoal'::text])));
CREATE INDEX turns_busy ON public.turns USING btree (thread_id) WHERE (status = ANY (ARRAY['queued'::text, 'running'::text]));
