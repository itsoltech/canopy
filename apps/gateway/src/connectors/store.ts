import type { SqlClient } from "effect/sql";
import { connectorAccounts } from "./accounts.ts";
import { connectorSealing } from "./sealing.ts";
import { connectorWrites } from "./store-writes.ts";
import { connectorState } from "./store-state.ts";
import type { Effect } from "effect";

export { ConnectorFailure, digest, type AccountRow, type Credentials, type ExecutionSource } from "./records.ts";

/** Attached to GatewayStore and shared with the legacy bot RPC adapter; one persistence model. */
export function connectorStore(sql: SqlClient.SqlClient, key: Buffer) {
  const sealing = connectorSealing(sql, key);
  const base = { ...sealing, ...connectorAccounts(sql, sealing) };

  return {
    owned: base.owned,
    credentials: base.credentials,
    unseal: base.unseal,
    seal: base.seal,
    view: base.view,
    authorize: base.authorize,
    list: base.list,
    updateCredentials: base.updateCredentials,
    audit: base.audit,
    transaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => sql.withTransaction(effect),
    ...connectorWrites(sql, base),
    ...connectorState(sql, base, key),
  };
}

export type ConnectorStore = ReturnType<typeof connectorStore>;
