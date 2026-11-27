-- Konta wiadomości obsługują Slack, Telegram i Discord. Identyfikatory kanałów są natywne dla dostawcy,
-- więc rozmowa zapisuje, czy jest prywatna, zamiast wnioskować to z prefiksu identyfikatora Slacka.
ALTER TABLE messenger_accounts DROP CONSTRAINT messenger_accounts_provider_check,
  ADD CONSTRAINT messenger_accounts_provider_check CHECK (provider IN ('slack', 'telegram', 'discord'));

ALTER TABLE bot_channel_conversations ADD COLUMN direct boolean NOT NULL DEFAULT false;
UPDATE bot_channel_conversations SET direct = true WHERE channel_id LIKE 'D%';

-- Identyfikator wysłanej odpowiedzi pozwala przypisać odpowiedź uczestnika na nią do tej samej rozmowy.
ALTER TABLE messenger_outbound ADD COLUMN message_id text;
CREATE INDEX messenger_outbound_message ON messenger_outbound(account_id, channel_id, message_id)
  WHERE message_id IS NOT NULL;
