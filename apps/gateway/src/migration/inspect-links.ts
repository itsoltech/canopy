import { POSTGRES_MAX_MESSAGE_BYTES } from "@canopy/db";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import { SqlClient } from "effect/sql";
import { databaseUrl } from "../database-credentials.ts";
import { consolidationPreflight } from "./consolidation-inventory.ts";
import { DatabaseMigrationError } from "./postgres-tools.ts";

/** The operator's configured gateway owner determines the scope of the report. */
export function inspectLinks(env: NodeJS.ProcessEnv) {
  const email = env["CANOPY_DEV_USER_EMAIL"] ?? "dev@localhost";

  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const [owner] = yield* sql<{
        id: string;
      }>`SELECT id FROM public.users WHERE email=${email} AND disabled_at IS NULL`;

      if (!owner) return yield* Effect.fail(new DatabaseMigrationError("The configured gateway owner was not found."));

      const { source, home, sharedWorkers, peers, redirects, blockers } = yield* consolidationPreflight(owner.id);

      return {
        action: "inspect-links",
        source: { nodeId: source.nodeId, name: source.name },
        home: Object.fromEntries(Object.entries(home).map(([kind, records]) => [kind, records.length])),
        referencedSharedWorkers: sharedWorkers.length,
        peers,
        redirects: redirects.length,
        blockers,
      };
    }).pipe(
      Effect.provide(
        PgClient.layer({
          url: Redacted.make(databaseUrl(env)),
          applicationName: "canopy-migration-inspect",
          connectTimeout: "5 seconds",
          maxMessageSize: POSTGRES_MAX_MESSAGE_BYTES,
          startupParameters: { default_transaction_read_only: "on", search_path: "pg_catalog,public" },
        }),
      ),
    ),
  );
}
