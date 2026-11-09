CREATE INDEX agent_bus_calls_due ON public.agent_bus_calls USING btree (created_at, id) WHERE (notify_status = 'pending'::text);
CREATE INDEX bot_watches_pending ON public.bot_thread_watches USING btree (target_turn_id, call_id) WHERE (NOT delivered);
CREATE INDEX bot_wakeups_due ON public.bot_wakeups USING btree (run_at, id) WHERE ((NOT delivered) AND (NOT cancelled));
CREATE INDEX workers_credential ON public.workers USING btree (credential_hash);
