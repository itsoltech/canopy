import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { RECLAIM_TABLES } from "./reclaim.ts";

/** Decimal strings preserve PostgreSQL's bigint sizes in JSON. TOAST includes its indexes. */
export interface RelationStorage {
  readonly schema: string;
  readonly table: string;
  readonly heapBytes: string;
  readonly toastBytes: string;
  readonly indexBytes: string;
  readonly totalBytes: string;
  readonly liveTuplesEstimate: string;
  readonly deadTuplesEstimate: string;
}

/** Catalog and size functions only: no user rows or connection settings leave PostgreSQL. */
export const inspectStorage = (sql: SqlClient.SqlClient) =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* sql.reserve;

      const database: readonly { bytes: string }[] = yield* connection.executeUnprepared(
        "SELECT pg_database_size(current_database())::text AS bytes",
        [],
        undefined,
      );

      const relations: readonly RelationStorage[] = yield* connection.executeUnprepared(
        `SELECT n.nspname AS schema, c.relname AS "table",
          pg_relation_size(c.oid)::text AS "heapBytes",
          (CASE WHEN c.reltoastrelid=0 THEN 0
            ELSE pg_total_relation_size(c.reltoastrelid) END)::text AS "toastBytes",
          pg_indexes_size(c.oid)::text AS "indexBytes",
          pg_total_relation_size(c.oid)::text AS "totalBytes",
          coalesce(s.n_live_tup,0)::text AS "liveTuplesEstimate",
          coalesce(s.n_dead_tup,0)::text AS "deadTuplesEstimate"
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid=c.oid
        WHERE n.nspname='public' AND c.relkind IN ('r','m')
        ORDER BY pg_total_relation_size(c.oid) DESC, c.relname`,
        [],
        undefined,
      );

      return {
        databaseBytes: database[0]?.bytes ?? "0",
        relations: relations.map((row) => ({ ...row, reclaimable: RECLAIM_TABLES.includes(row.table) })),
      };
    }),
  );
