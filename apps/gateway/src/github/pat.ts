import { Code, ConnectError } from "@connectrpc/connect";
import { Cause, Effect, Exit } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import { GatewayStore } from "../store/store.ts";
import type { AccountRow } from "./records.ts";

export class GitHubPat {
  readonly run: <A, E>(effect: Effect.Effect<A, E, GatewayStore | SqlClient.SqlClient>) => Promise<A>;
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
  ) {
    this.run = async (effect) => {
      const result = await runtime.runPromise(Effect.exit(effect));

      if (Exit.isFailure(result)) throw Cause.squash(result.cause);

      return result.value;
    };
  }
  invalidate() {
    const owner = this.owner;

    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE github_accounts a SET status='needs_reconnect',revision=a.revision+1,updated_at=now()
        WHERE a.owner_user_id=${owner}::uuid AND a.auth_kind='pat' AND a.status='connected' AND NOT EXISTS
        (SELECT 1 FROM connector_accounts c WHERE c.owner_user_id=a.owner_user_id AND c.id=a.connector_account_id
        AND c.revision=a.connector_revision AND c.status='connected' AND c.connector_type='github'
        AND c.auth_kind='headers' AND c.url='https://api.githubcopilot.com/mcp/')`;
      }),
    );
  }
  candidates() {
    const owner = this.owner;

    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql<{ id: string; name: string }>`SELECT id,name FROM connector_accounts
        WHERE owner_user_id=${owner}::uuid AND connector_type='github' AND auth_kind='headers'
        AND url='https://api.githubcopilot.com/mcp/' AND status='connected' ORDER BY name,id`;
      }),
    );
  }
  async read(id: string) {
    const owner = this.owner;

    return this.run(
      GatewayStore.use((s) =>
        Effect.gen(function* () {
          const row = yield* s.connectors.owned(owner, id);

          if (
            row.connector_type !== "github" ||
            row.auth_kind !== "headers" ||
            row.status !== "connected" ||
            row.url !== "https://api.githubcopilot.com/mcp/"
          )
            return yield* Effect.fail(
              new ConnectError("Choose a GitHub personal access token from Connectors.", Code.FailedPrecondition),
            );
          const credentials = yield* s.connectors.credentials(row);

          // Only an explicitly selected official GitHub connector's bearer token is eligible.
          const header = Object.entries(credentials.headers ?? {}).find(
            ([name]) => name.toLowerCase() === "authorization",
          )?.[1];

          const token = /^Bearer ([A-Za-z0-9_]+)$/i.exec(header ?? "")?.[1];

          if (!token)
            return yield* Effect.fail(
              new ConnectError("Reconnect this account in Settings → Connectors.", Code.FailedPrecondition),
            );

          return { token, revision: BigInt(row.revision) };
        }),
      ),
    );
  }
  save(connector: string, revision: bigint, userId: string, login: string) {
    const owner = this.owner;

    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* sql`SELECT id FROM connector_accounts WHERE owner_user_id=${owner}::uuid
          AND id=${connector}::uuid AND revision=${revision}::bigint AND status='connected' FOR SHARE`;

            if (!current.length)
              return yield* Effect.fail(
                new ConnectError("The connector changed. Choose it again.", Code.FailedPrecondition),
              );

            // SAFETY: this single-row INSERT/ON CONFLICT UPDATE either returns the account or fails.
            const row =
              (yield* sql<AccountRow>`INSERT INTO github_accounts(id,owner_user_id,github_user_id,login,auth_kind,connector_account_id,connector_revision,status)
          VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,${userId},${login},'pat',${connector}::uuid,${revision}::bigint,'connected')
          ON CONFLICT(owner_user_id,host,github_user_id) DO UPDATE SET connector_account_id=excluded.connector_account_id,
          connector_revision=excluded.connector_revision,
          auth_kind='pat',credentials=NULL,key_id=NULL,refresh_lease=NULL,refresh_lease_until=NULL,catalog_verified_at=NULL,
          login=excluded.login,status='connected',revision=github_accounts.revision+1,updated_at=now() RETURNING *`)[0]!;

            yield* sql`DELETE FROM github_installations WHERE owner_user_id=${owner}::uuid AND account_id=${row.id}::uuid`;
            yield* sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,'github.use_pat','github_account',${row.id}::uuid)`;

            return row;
          }),
        );
      }),
    );
  }
}
