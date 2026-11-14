import { fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Fx } from "./instance-checks.ts";
import { proxyRecords, type ProxyRow } from "./proxy-records.ts";

export interface ProxyTarget {
  readonly root: string;
  /** Decrypted management key; empty = none stored or not a CLIProxyAPI proxy. */
  readonly key: string;
  /** Decrypted proxy secret: redacted from account text like the key. */
  readonly secret: string;
  /** The stored key and URL (`<secret id>|<url>`): a read result belongs to the identity it was made with. */
  readonly identity: string;
  /** The last read of this identity, shared by restarts and gateway processes. */
  readonly last?: ui.ProxyAccounts | undefined;
}

export interface ProxyManagementApi {
  /** The owner's proxy as a management target; an unknown or foreign id fails as not found. */
  proxyManagement(userId: string, id: string): Fx<ProxyTarget>;
  /** The owner's CLIProxyAPI proxies with a management key that a profile uses: the periodic check reads these. */
  managedProxies(userId: string): Fx<string[]>;
  /**
   * Claims the next read of a proxy for this process: false while another read of the same identity started less
   * than `spacingMs` ago, here or in another gateway process.
   */
  claimProxyRead(userId: string, id: string, identity: string, spacingMs: number): Fx<boolean>;
  /** Stores a read for the identity it was made with; a key or URL changed meanwhile keeps it out. */
  storeProxyAccounts(userId: string, id: string, identity: string, accounts: ui.ProxyAccounts): Fx<void>;
}

export const managementIdentity = (row: Pick<ProxyRow, "management_secret_id" | "base_url">) =>
  row.management_secret_id ? `${row.management_secret_id}|${row.base_url}` : "";

/** The stored read when it belongs to the proxy's current key and URL; a decoding failure counts as none. */
export function storedAccounts(row: ProxyRow): ui.ProxyAccounts | undefined {
  const identity = managementIdentity(row);

  if (!identity || row.kind !== "cliproxyapi" || row.management_identity !== identity || !row.management_status)
    return undefined;

  try {
    return fromJson(ui.ProxyAccountsSchema, row.management_status, { ignoreUnknownFields: true });
  } catch {
    return undefined;
  }
}

export function proxyManagementStore(sql: SqlClient.SqlClient, key: Buffer): ProxyManagementApi {
  const records = proxyRecords(sql, key);

  return {
    proxyManagement: (userId, id) =>
      Effect.gen(function* () {
        const row = yield* records.get(userId, id);
        const managed = row.kind === "cliproxyapi";

        return {
          root: row.base_url,
          key: managed ? yield* records.secret(userId, row.management_secret_id) : "",
          secret: managed ? yield* records.secret(userId, row.secret_id) : "",
          identity: managed ? managementIdentity(row) : "",
          last: storedAccounts(row),
        };
      }),
    managedProxies: (userId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string }>`SELECT p.id::text FROM proxies p
          WHERE p.owner_user_id = ${userId}::uuid AND p.kind = 'cliproxyapi' AND p.management_secret_id IS NOT NULL
            AND (EXISTS (SELECT 1 FROM provider_instances i WHERE i.proxy_id = p.id)
              OR EXISTS (SELECT 1 FROM provider_instance_workers w WHERE w.proxy_id = p.id))
          ORDER BY p.id`;

        return rows.map((row) => row.id);
      }),
    claimProxyRead: (userId, id, identity, spacingMs) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string }>`UPDATE proxies SET management_read_at = now(),
            management_read_identity = ${identity}
          WHERE id::text = ${id} AND owner_user_id = ${userId}::uuid
            AND (management_read_at IS NULL OR management_read_identity IS DISTINCT FROM ${identity}
              OR management_read_at < now() - make_interval(secs => ${spacingMs / 1000}))
          RETURNING id::text`;

        return rows.length > 0;
      }),
    storeProxyAccounts: (userId, id, identity, accounts) =>
      Effect.asVoid(
        sql`UPDATE proxies SET management_status = ${JSON.stringify(toJson(ui.ProxyAccountsSchema, accounts) satisfies JsonValue)}::jsonb,
            management_identity = ${identity}
          WHERE id::text = ${id} AND owner_user_id = ${userId}::uuid
            AND management_secret_id::text || '|' || base_url = ${identity}`,
      ),
  };
}
