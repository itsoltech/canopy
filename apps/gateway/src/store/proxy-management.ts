import { create, fromJson, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { proxyPlanOptions } from "@canopy/domain/proxy-capacity";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { Fx } from "./instance-checks.ts";
import { proxyRecords, type ProxyRow } from "./proxy-records.ts";
import { Invalid, NotFound } from "./store.ts";

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
  claimProxyRead(userId: string, id: string, identity: string, spacingMs: number, now?: Date): Fx<boolean>;
  /** Stores a read for the identity it was made with; a key or URL changed meanwhile keeps it out. */
  storeProxyAccounts(userId: string, id: string, identity: string, accounts: ui.ProxyAccounts): Fx<void>;
  setProxyAccountPlan(userId: string, request: ui.SetProxyAccountPlanRequest): Fx<ui.ProxyAccounts>;
}

export const managementIdentity = (row: Pick<ProxyRow, "management_secret_id" | "base_url">) =>
  row.management_secret_id ? `${row.management_secret_id}|${row.base_url}` : "";

/** The stored read when it belongs to the proxy's current key and URL; a decoding failure counts as none. */
export function storedAccounts(row: ProxyRow): ui.ProxyAccounts | undefined {
  const identity = managementIdentity(row);

  if (!identity || row.kind !== "cliproxyapi" || row.management_identity !== identity || !row.management_status)
    return undefined;

  try {
    const value = fromJson(ui.ProxyAccountsSchema, row.management_status, { ignoreUnknownFields: true });

    return create(ui.ProxyAccountsSchema, {
      ...value,
      accounts: value.accounts.map((account) => {
        const manualPlan = row.account_plans[account.planKey];

        return { ...account, detectedPlan: account.plan, manualPlan, plan: manualPlan ?? account.plan };
      }),
    });
  } catch {
    return undefined;
  }
}

export function proxyManagementStore(sql: SqlClient.SqlClient, key: Buffer): ProxyManagementApi {
  const records = proxyRecords(sql, key);

  return {
    setProxyAccountPlan: (userId, request) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const row = yield* records.get(userId, request.proxyId);
          const accounts = storedAccounts(row);
          const matches = accounts?.accounts.filter((account) => account.planKey === request.accountKey) ?? [];
          const account = matches[0];

          if (!request.accountKey || !account || matches.length !== 1 || accounts?.state !== "ok")
            return yield* Effect.fail(new NotFound("Account not found. Refresh accounts and try again."));

          if (
            request.plan !== ui.ProxyAccountPlan.UNSPECIFIED &&
            !proxyPlanOptions(account.provider).some((option) => option.plan === request.plan)
          )
            return yield* Effect.fail(new Invalid("Choose a plan available for this provider."));

          const plans = { ...row.account_plans };

          if (request.plan === ui.ProxyAccountPlan.UNSPECIFIED) delete plans[request.accountKey];
          else plans[request.accountKey] = request.plan;
          yield* sql`UPDATE proxies SET account_plans = ${JSON.stringify(plans)}::jsonb
        WHERE id = ${row.id}::uuid AND owner_user_id = ${userId}::uuid`;
          yield* records.audit(userId, row.id, "proxy.account_plan_set");

          return storedAccounts({ ...row, account_plans: plans })!;
        }),
      ),
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
    claimProxyRead: (userId, id, identity, spacingMs, now) =>
      Effect.gen(function* () {
        const readAt = now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;

        const rows = yield* sql<{ id: string }>`UPDATE proxies SET management_read_at = ${readAt},
            management_read_identity = ${identity}
          WHERE id::text = ${id} AND owner_user_id = ${userId}::uuid
            AND (management_read_at IS NULL OR management_read_identity IS DISTINCT FROM ${identity}
              OR management_read_at < ${readAt} - make_interval(secs => ${spacingMs / 1000}))
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
