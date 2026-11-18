-- Socket Mode jest częścią istniejącego połączenia Slack, z osobnym stanem odbioru.
ALTER TABLE connector_oauth_apps ADD COLUMN client_id text;
ALTER TABLE messenger_accounts
  ADD COLUMN connector_account_id uuid,
  ADD COLUMN connector_client_id text,
  ADD CONSTRAINT messenger_connector_owner FOREIGN KEY(connector_account_id, owner_user_id)
    REFERENCES connector_accounts(id, owner_user_id) ON DELETE SET NULL (connector_account_id);
CREATE UNIQUE INDEX messenger_connector_binding ON messenger_accounts(connector_account_id)
  WHERE connector_account_id IS NOT NULL AND deleted_at IS NULL;
-- Zachowany client ID odróżnia osierocone połączenie od starszego konta ręcznego.
CREATE FUNCTION disconnect_messenger_connector() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE messenger_accounts SET enabled=false,status='disconnected',lease_until=NULL,lease_token=NULL
    WHERE connector_account_id=OLD.id AND owner_user_id=OLD.owner_user_id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER disconnect_messenger_connector BEFORE DELETE ON connector_accounts
  FOR EACH ROW EXECUTE FUNCTION disconnect_messenger_connector();
ALTER TABLE messenger_accounts ADD COLUMN revision bigint NOT NULL DEFAULT 1,
  ADD COLUMN refresh_attempt uuid, ADD COLUMN refresh_started_at timestamptz;
-- Zmiana lub usunięcie aplikacji przez synchronizację również odcina aktywne źródła.
CREATE FUNCTION invalidate_slack_app() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.connector_type='slack' AND (TG_OP='DELETE' OR
    (OLD.client_id IS NOT NULL AND OLD.client_id IS DISTINCT FROM NEW.client_id)) THEN
    UPDATE connector_accounts SET status='needs_reconnect',revision=revision+1,tools='[]'
      WHERE owner_user_id=OLD.owner_user_id AND connector_type='slack';
    UPDATE messenger_accounts SET status='needs_authorization',lease_token=NULL,lease_until=NULL,revision=revision+1
      WHERE owner_user_id=OLD.owner_user_id AND connector_client_id IS NOT NULL;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER invalidate_slack_app AFTER UPDATE OF client_id OR DELETE ON connector_oauth_apps
  FOR EACH ROW EXECUTE FUNCTION invalidate_slack_app();
ALTER TABLE connector_accounts ADD COLUMN slack_team_id text,
  ADD COLUMN slack_refresh_attempt uuid, ADD COLUMN slack_refresh_started_at timestamptz;
ALTER TABLE messenger_accounts ADD COLUMN connector_team_id text;
