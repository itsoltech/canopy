import { POSTGRES_MAX_MESSAGE_BYTES } from "@canopy/db";
import { PgClient } from "@effect/sql-pg";
import { Effect, Redacted } from "effect";
import type { SqlClient } from "effect/sql";
import {
  BOT_PARKED_MIGRATION,
  BOT_SKILLS_MIGRATION,
  GITHUB_AGENT_ACCESS_MIGRATION,
  BOT_TRIGGERS_MIGRATION,
  coveredTables,
  importTables,
  MESSENGER_PROVIDERS_MIGRATION,
  SLACK_CONTEXT_MIGRATION,
  THREAD_TRANSFERS_MIGRATION,
  type ImportTable,
} from "./consolidation-tables.ts";
import { consolidationDigest, consolidationError } from "./consolidation-types.ts";

export type Database = SqlClient.SqlClient;

export const databaseLayer = (url: string, applicationName: string) =>
  PgClient.layer({
    url: Redacted.make(url),
    applicationName,
    connectTimeout: "5 seconds",
    maxMessageSize: POSTGRES_MAX_MESSAGE_BYTES,
    startupParameters: { search_path: "pg_catalog,public" },
  });

export const ident = (identifier: string) => '"' + identifier.replaceAll('"', '""') + '"';
export const publicTable = (name: string) => "public." + ident(name);
export const staged = (name: string) => "pg_temp." + ident("cc_" + name);

interface ForeignKey {
  name: string;
  target: string;
  columns: string[];
  references: string[];
  deferrable: boolean;
  deferred: boolean;
}

interface TableColumns {
  name: string;
  columns: string[];
  types: string[];
  written: string[];
  key: string[];
}

export interface SelectedTable extends TableColumns, ImportTable {
  foreignKeys: ForeignKey[];
}

function columns(sql: Database) {
  return sql<TableColumns>`
      SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attnum) AS columns,
        array_agg(format_type(a.atttypid,a.atttypmod) ORDER BY a.attnum) AS types,
        array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attgenerated='') AS written,
        ARRAY(SELECT k.attname::text FROM pg_index i
          CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY p(n,position)
          JOIN pg_attribute k ON k.attrelid=c.oid AND k.attnum=p.n
          WHERE i.indrelid=c.oid AND i.indisprimary ORDER BY p.position) AS key
      FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
      WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
      GROUP BY c.oid ORDER BY c.relname
    `;
}

export function checkProjectedSchema(sql: Database, selected: readonly SelectedTable[]) {
  return Effect.gen(function* () {
    const source = yield* columns(sql);

    const required = new Set([
      ...selected.map(({ name }) => name),
      "users",
      "computer_identity",
      "gateway_relocation_fence",
      "config_items",
      "computer_redirects",
      "consolidation_export_secrets",
      "consolidation_export_blockers",
    ]);

    if (source.some(({ name }) => !required.has(name) && name !== "schema_migrations"))
      return yield* Effect.fail(
        consolidationError("The staging database must contain a scoped consolidation projection."),
      );

    for (const name of required) {
      if (!source.some((row) => row.name === name))
        return yield* Effect.fail(consolidationError("The consolidation projection is missing a required table."));
    }

    for (const table of selected) {
      const shape = source.find(({ name }) => name === table.name);

      if (
        !shape ||
        table.columns.some((column, index) => shape.types[shape.columns.indexOf(column)] !== table.types[index])
      )
        return yield* Effect.fail(
          consolidationError("The consolidation projection has an incompatible column layout."),
        );
    }
  });
}

/** Column, primary key and FK metadata is checked before creating any staging relations. */
export function consolidationCatalog(sql: Database) {
  return Effect.gen(function* () {
    const [{ id } = { id: 0 }] = yield* sql<{
      id: number;
    }>`SELECT max(migration_id) AS id FROM public.schema_migrations`;

    if (id < 214) return yield* Effect.fail(consolidationError("Both databases must have migration 0214 or newer."));

    const tables = yield* columns(sql);

    const unknownTable = tables.find(({ name }) => !coveredTables.has(name));

    if (unknownTable)
      return yield* Effect.fail(consolidationError("The database contains a table without a consolidation policy."));

    const foreign = yield* sql<ForeignKey & { table: string }>`
      SELECT o.conname AS name,c.relname AS "table",d.relname AS target,o.condeferrable AS deferrable,
        o.condeferred AS deferred,
        ARRAY(SELECT a.attname::text FROM unnest(o.conkey) WITH ORDINALITY p(n,position)
          JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=p.n ORDER BY p.position) AS columns,
        ARRAY(SELECT a.attname::text FROM unnest(o.confkey) WITH ORDINALITY p(n,position)
          JOIN pg_attribute a ON a.attrelid=d.oid AND a.attnum=p.n ORDER BY p.position) AS references
      FROM pg_constraint o JOIN pg_class c ON c.oid=o.conrelid JOIN pg_class d ON d.oid=o.confrelid
      WHERE c.relnamespace='public'::regnamespace AND d.relnamespace='public'::regnamespace AND o.contype='f'
      ORDER BY c.relname,o.conname
    `;

    const selected: SelectedTable[] = [];

    for (const spec of importTables) {
      const table = tables.find(({ name }) => name === spec.name);

      if (!table && spec.sinceMigration && id < spec.sinceMigration) continue;
      const key = spec.name === "worktree_settings" ? ["owner_user_id", "project_id", "worker_id"] : table?.key;

      if (!table || !key?.length)
        return yield* Effect.fail(consolidationError("A consolidation table has a missing row key or is unavailable."));

      selected.push({ ...table, ...spec, key, foreignKeys: foreign.filter(({ table }) => table === spec.name) });
    }

    const signature = consolidationDigest(
      JSON.stringify(
        selected.map(({ name, columns, types, written, key, foreignKeys }) => ({
          name,
          columns,
          types,
          written,
          key,
          foreignKeys,
        })),
      ),
    );

    // Keep the table allowlist closed to columns and FKs introduced without a reviewed import policy.
    const expectedSignature =
      id >= GITHUB_AGENT_ACCESS_MIGRATION
        ? "d7133a4d9d8a7271513c635c83f9f7bf2def65a62aecad2a73f7f7dd318fd715"
        : id >= BOT_SKILLS_MIGRATION
          ? "d49868c27d8ebbc6fb4a79412452e4fefef8a52a8627a4b420f487a8ac81012a"
          : id >= BOT_TRIGGERS_MIGRATION
            ? "e442e83b2a81b2ceb6c1c8c77baf3b2632e6cfc5359329988efbba729c5c019d"
            : id >= BOT_PARKED_MIGRATION
              ? "0be8fc9f65d97b371caf94a63c142eb58e274ceb970eea6eb7437b666fca2815"
              : id >= THREAD_TRANSFERS_MIGRATION
                ? "ee388aa01779429e258a7dbb1523b9049acbda77c627a9e46d5af22ba4f9da9b"
                : id >= MESSENGER_PROVIDERS_MIGRATION
                  ? "c685c576ed76dedeb581fe998bf1020a439ee2bde257aa23fd5bf2400235d5c5"
                  : id >= SLACK_CONTEXT_MIGRATION
                    ? "1397f1da55d4fbd515d6f37e03688cd24158bc8db1f3b80fb4f4ddcf828a5e5c"
                    : id >= 216
                      ? "d9308c1a668ad42ea980e1afa7845a59aca8ec180f0e8b116b7a0fd14ebf8fed"
                      : "ec01736abf5e3a5ba0791405cf373c64a1fd9771e6ca11fd84128c98cd9793b0";

    if (signature !== expectedSignature)
      return yield* Effect.fail(
        consolidationError("The consolidation schema has unsupported columns or foreign keys."),
      );

    return { selected, signature };
  });
}

export function keySql(alias: string, table: SelectedTable) {
  return `jsonb_build_array(${table.key.map((key) => alias + "." + ident(key) + "::text").join(",")})::text`;
}

export function sameKey(left: string, right: string, table: SelectedTable) {
  return table.key.map((key) => `${left}.${ident(key)} IS NOT DISTINCT FROM ${right}.${ident(key)}`).join(" AND ");
}
