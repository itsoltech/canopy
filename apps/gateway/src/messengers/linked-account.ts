import type { SqlClient } from "effect/sql";

/** Use with the owner-scoped messenger_accounts alias a at every durable source gate. */
export function linkedMessengerActive(sql: SqlClient.SqlClient) {
  return sql`(a.status NOT IN ('needs_authorization','needs_reconnect','disconnected') AND (
    (a.connector_account_id IS NULL AND a.connector_client_id IS NULL) OR EXISTS (
      SELECT 1 FROM connector_accounts c JOIN connector_oauth_apps p
        ON p.owner_user_id=c.owner_user_id AND p.connector_type='slack'
      WHERE c.id=a.connector_account_id AND c.owner_user_id=a.owner_user_id
        AND c.connector_type='slack' AND c.auth_kind='oauth' AND c.status IN ('connected','error')
        AND p.client_id=a.connector_client_id AND c.slack_team_id=a.connector_team_id)))`;
}
