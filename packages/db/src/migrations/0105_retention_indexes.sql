CREATE INDEX worker_commands_retention ON public.worker_commands USING btree (completed_at, id) WHERE ((payload_pruned_at IS NULL) AND (thread_id IS NOT NULL) AND (status = ANY (ARRAY['completed'::text, 'failed'::text])));
CREATE INDEX bot_harness_events_turn ON public.bot_harness_events USING btree (turn_id, journal_seq);
CREATE INDEX bot_harness_retention ON public.bot_harness_turns USING btree (finished_at, turn_id) WHERE ((events_pruned_at IS NULL) AND (outcome IS NOT NULL));
CREATE INDEX config_history_retention ON public.config_history USING btree (owner_user_id, superseded_at, id);
CREATE INDEX connector_oauth_retention ON public.connector_oauth_states USING btree (owner_user_id, expires_at);
