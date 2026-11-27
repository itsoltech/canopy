-- Pliki wysyłane razem z odpowiedzią tury w rozmowie zewnętrznej. Wiersz outboxa powstaje dopiero
-- po zakończeniu tury, więc pliki wskazują turę, a wysyłka czyta je przez messenger_outbound.turn_id.
CREATE TABLE messenger_outbound_files (
  turn_id uuid NOT NULL REFERENCES bot_turns(id) ON DELETE CASCADE,
  attachment_id uuid NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 10),
  PRIMARY KEY (turn_id, attachment_id),
  UNIQUE (turn_id, ordinal)
);
CREATE INDEX messenger_outbound_files_attachment ON messenger_outbound_files(attachment_id);
