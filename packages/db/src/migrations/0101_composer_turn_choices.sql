-- Ostatni własny wybór kompozytora bez skanowania nowszych tur agenta ani wejść shell.
CREATE INDEX turns_composer_choices ON turns (thread_id, author_user_id, ordinal DESC)
  WHERE trigger = 'user' AND withdrawn IS NULL AND NOT (input ? 'shellCommand');
