-- Indeksy wydajnościowe: migrator buduje je po zatwierdzeniu migracji schematu.
-- Zapis kanoniczny pg_get_indexdef umożliwia sprawdzenie definicji po restarcie.
CREATE INDEX worker_commands_redelivery ON public.worker_commands USING btree (worker_id, created_at, id) WHERE (status = ANY (ARRAY['pending'::text, 'delivered'::text]));
