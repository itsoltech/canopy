import { create, fromJson, toJson } from "@bufbuild/protobuf";
import { ConnectorToolSchema } from "@canopy/contracts";
import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";
import { uuid } from "../agent-environment/composition.ts";
import { connectorType } from "../connectors/catalog.ts";
import { digest, type AccountRow } from "../connectors/records.ts";
import { connectorSealing } from "../connectors/sealing.ts";
import { sharedCredentials } from "../connectors/credential-values.ts";
import { connectorColumns } from "./connector-values.ts";
import type { ConfigRow } from "./persistence.ts";
import { canonicalId, NOT_SUPPORTED, recordOf } from "./provider-apply.ts";
import { alive } from "./provider-records.ts";
import { valuesOf } from "./provider-values.ts";
import { currentSecret } from "./secrets.ts";

/** Account references are global on the link and local at the domain boundary. */
export function connectorId(sql: SqlClient.SqlClient, owner: string, id: string, global = false) {
  return Effect.gen(function* () {
    if (!id) return id;

    if (global) {
      const rows = yield* sql<ConfigRow>`SELECT * FROM config_items WHERE owner_user_id=${owner}::uuid
        AND kind='connector' AND local_id=${id}`;

      if (rows[0]) return rows[0].global_id;
    }

    const canonical = yield* canonicalId(sql, owner, "connector", id);

    return global ? canonical : ((yield* recordOf(sql, owner, "connector", canonical))?.local_id ?? id);
  });
}

/** Deletion does not revoke tokens: Restore retains the encrypted credentials for 90 days. */
export function removeConnector(sql: SqlClient.SqlClient, owner: string, id: string) {
  return Effect.gen(function* () {
    yield* sql`UPDATE connector_audit SET account_id=NULL WHERE account_id=${id}::uuid AND owner_user_id=${owner}::uuid`;
    yield* sql`DELETE FROM connector_executions WHERE account_id=${id}::uuid AND owner_user_id=${owner}::uuid`;
    yield* sql`DELETE FROM connector_accounts WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid`;
  });
}

/** Materialize only owned rows. Local status changes only when the winning secret actually changes. */
export function applyConnector(sql: SqlClient.SqlClient, owner: string, key: Buffer, row: ConfigRow) {
  return Effect.gen(function* () {
    const v = valuesOf(row.fields);
    const secret = v["credentials"] ? yield* currentSecret(sql, owner, key, row, "credentials") : undefined;

    if (row.kind === "oauth_app") {
      if (!connectorType(row.local_id)) return void (row.unsupported = NOT_SUPPORTED);

      if (!alive(row)) {
        yield* sql`DELETE FROM connector_oauth_apps WHERE owner_user_id=${owner}::uuid AND connector_type=${row.local_id}`;

        return;
      }

      if (!secret) return void (row.unsupported = "A key is missing on this computer");

      const app = yield* Effect.try(() =>
        Schema.decodeUnknownSync(Schema.Struct({ client_id: Schema.String }))(JSON.parse(secret.plain)),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)));

      if (!app?.client_id || v["type"] !== row.local_id) return void (row.unsupported = NOT_SUPPORTED);
      yield* sql`INSERT INTO connector_oauth_apps(owner_user_id,connector_type,credentials)
        VALUES(${owner}::uuid,${row.local_id},${secret.ciphertext}) ON CONFLICT(owner_user_id,connector_type)
        DO UPDATE SET credentials=EXCLUDED.credentials,updated_at=now()`;

      return;
    }

    if (!uuid(row.local_id)) return void (row.unsupported = NOT_SUPPORTED);
    const current = (yield* sql<AccountRow>`SELECT * FROM connector_accounts WHERE id=${row.local_id}::uuid`)[0];

    if (current && current.owner_user_id !== owner) return void (row.unsupported = NOT_SUPPORTED);

    if (!alive(row)) return yield* removeConnector(sql, owner, row.local_id);
    const columns = connectorColumns(v);

    if (!columns) return void (row.unsupported = NOT_SUPPORTED);

    if (v["credentials"] && !secret) return void (row.unsupported = "A key is missing on this computer");
    const sealing = connectorSealing(sql, key);

    const parsed = secret
      ? yield* Effect.try(() => ({ value: sharedCredentials(secret.plain) })).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        )
      : { value: undefined };

    if (!parsed) return void (row.unsupported = NOT_SUPPORTED);
    const value = parsed.value;
    const namespace = current?.namespace ?? `${columns.type}_${digest(row.local_id).slice(0, 16)}`;

    const tools = columns.tools.map((json) => {
      const tool = fromJson(ConnectorToolSchema, json);
      const remote = tool.remoteName.replace(/[^a-zA-Z0-9_]/g, "_");

      const suffix =
        remote.length > 22 || remote !== tool.remoteName
          ? `${remote.slice(0, 13)}_${digest(tool.remoteName).slice(0, 8)}`
          : remote;

      return toJson(
        ConnectorToolSchema,
        create(ConnectorToolSchema, {
          ...tool,
          accountId: row.local_id,
          accountName: columns.name,
          connectorType: columns.type,
          name: `${namespace.slice(0, 39)}__${suffix}`,
        }),
      );
    });

    const old = current ? yield* sealing.credentials(current) : undefined;
    const changed = JSON.stringify(old) !== (secret?.plain ?? undefined);

    const status =
      !changed && current
        ? current.status
        : value
          ? columns.authKind === "oauth" && !value.tokens
            ? "needs_reconnect"
            : "connected"
          : "disconnected";

    yield* sql`INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,
      credentials,status,all_workers,all_bots,tools)
      VALUES(${row.local_id}::uuid,${owner}::uuid,${columns.type},${columns.name},${namespace},${columns.url},${columns.transport},
      ${columns.authKind},${secret?.ciphertext ?? null},${status},${columns.allWorkers},${columns.allBots},${JSON.stringify(tools)}::jsonb)
      ON CONFLICT(id) DO UPDATE SET connector_type=EXCLUDED.connector_type,name=EXCLUDED.name,url=EXCLUDED.url,
      transport=EXCLUDED.transport,auth_kind=EXCLUDED.auth_kind,credentials=EXCLUDED.credentials,legacy_headers='{}',
      status=EXCLUDED.status,all_workers=EXCLUDED.all_workers,all_bots=EXCLUDED.all_bots,tools=EXCLUDED.tools,
      revision=connector_accounts.revision+1,updated_at=now() WHERE connector_accounts.owner_user_id=${owner}::uuid`;

    if (changed)
      yield* sql`DELETE FROM connector_oauth_states WHERE account_id=${row.local_id}::uuid AND owner_user_id=${owner}::uuid`;
  });
}
