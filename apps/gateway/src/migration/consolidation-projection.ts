import { createPrivateKey, X509Certificate } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { certificateIdentity } from "../computers/identity.ts";
import { databaseUrl } from "../database-credentials.ts";
import { decryptSecret, loadSecretsKey } from "../store/secrets.ts";
import { consolidationBlockers } from "./consolidation-blockers.ts";
import {
  consolidationCatalog,
  databaseLayer,
  ident,
  keySql,
  publicTable,
  type Database,
  type SelectedTable,
} from "./consolidation-catalog.ts";
import {
  checkProjectionArchive,
  encodeProjectionManifest,
  projectionArchive,
  projectionBlockersTable,
  projectionManifest,
  projectionOperation,
  projectionOperationId,
  projectionSecretsTable,
  projectionWriter,
  readProjectionManifest,
  type ProjectionMetadata,
} from "./consolidation-projection-format.ts";
import { consolidationError } from "./consolidation-types.ts";
import { assertProjectionOffline, selectedOwner } from "./consolidation-projection-source.ts";

export { materializeConsolidationProjection } from "./consolidation-projection-materialize.ts";

export { loadApprovedConsolidationSecrets } from "./consolidation-projection-secrets.ts";

export type { ProjectionManifest } from "./consolidation-projection-format.ts";

interface ExportOptions {
  operationId: string;
  offline: boolean;
}

export function verifyConsolidationProjection(directory: string) {
  return projectionOperation(async () => {
    const manifest = await readProjectionManifest(directory);
    await checkProjectionArchive(directory, manifest);

    return manifest;
  });
}

function syncDirectory(path: string) {
  return Effect.tryPromise(async () => {
    if (process.platform === "win32") return;

    const directory = await open(path, "r");

    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  });
}

export function exportConsolidationProjection(env: NodeJS.ProcessEnv, directory: string, options: ExportOptions) {
  return projectionOperation(async () => {
    const operationId = projectionOperationId(options.operationId);
    await mkdir(directory, { mode: 0o700 });

    try {
      const effect = SqlClient.SqlClient.use((sql) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;

            if (options.offline) yield* assertProjectionOffline(sql, operationId, false);

            const { metadata, privateKey, tables } = yield* readSource(sql, env, { ...options, operationId });
            const archive = yield* Effect.tryPromise(() => open(projectionArchive(directory), "wx", 0o600));

            try {
              const writer = yield* Effect.tryPromise(() => projectionWriter(archive, metadata));
              yield* exportRouting(sql, metadata.source, writer);

              for (const table of tables) yield* exportTable(sql, table, metadata.source.ownerUserId, writer);

              const manifest = writer.result();
              yield* Effect.tryPromise(() => archive.sync());
              const path = projectionManifest(directory);
              const pending = path + ".partial";
              yield* Effect.tryPromise(() =>
                writeFile(pending, encodeProjectionManifest(manifest, privateKey), {
                  flag: "wx",
                  mode: 0o600,
                  flush: true,
                }),
              );

              if (options.offline) yield* assertProjectionOffline(sql, operationId, false);
              yield* Effect.tryPromise(() => rename(pending, path));
              yield* syncDirectory(directory);
              yield* syncDirectory(dirname(directory));

              return manifest;
            } finally {
              yield* Effect.tryPromise(() => archive.close());
            }
          }),
        ),
      );

      return await Effect.runPromise(
        effect.pipe(Effect.provide(databaseLayer(databaseUrl(env), "canopy-projection-export"))),
      );
    } catch (error) {
      await rm(directory, { force: true, recursive: true });
      throw error;
    }
  });
}

function readSource(sql: Database, env: NodeJS.ProcessEnv, options: ExportOptions) {
  return Effect.gen(function* () {
    const { selected: tables, signature: catalogSignature } = yield* consolidationCatalog(sql);

    const [row] = yield* sql<{
      owner_user_id: string;
      email: string;
      node_id: string;
      name: string;
      certificate: string;
      private_key: Uint8Array;
      postgres_major: number;
      schema_migration: number;
    }>`SELECT i.owner_user_id,u.email,i.node_id,i.name,i.certificate,i.private_key,
      current_setting('server_version_num')::int/10000 AS postgres_major,
      (SELECT max(migration_id) FROM public.schema_migrations) AS schema_migration
      FROM public.computer_identity i JOIN public.users u ON u.id=i.owner_user_id
      WHERE u.disabled_at IS NULL AND u.email=${selectedOwner(env)}`;

    const { source, privateKey, database } = yield* Effect.try({
      try: () => {
        if (!row) throw new Error();

        const { nodeId, certificate } = certificateIdentity(row.certificate);
        const privateKey = createPrivateKey(decryptSecret(loadSecretsKey(env), row.private_key));

        if (row.node_id !== nodeId || !new X509Certificate(certificate).checkPrivateKey(privateKey)) throw new Error();

        return {
          privateKey,
          database: { postgresMajor: row.postgres_major, schemaMigration: row.schema_migration },
          source: { nodeId, ownerUserId: row.owner_user_id, ownerEmail: row.email, name: row.name, certificate },
        };
      },
      catch: () =>
        consolidationError("Check the selected owner, Linked Computer identity and source gateway encryption key."),
    });

    const metadata: ProjectionMetadata = {
      format: "canopy-consolidation-1",
      version: CANOPY_VERSION,
      operationId: options.operationId,
      database,
      catalogSignature,
      source,
      fence: options.offline ? "drained" : null,
    };

    return { metadata, privateKey, tables };
  });
}

type ProjectionWriter = Awaited<ReturnType<typeof projectionWriter>>;

function exportRows(
  sql: Database,
  query: string,
  parameters: readonly unknown[],
  tableName: string,
  writer: ProjectionWriter,
) {
  return Effect.gen(function* () {
    yield* sql.unsafe(`DECLARE canopy_export NO SCROLL CURSOR FOR ${query}`, parameters);

    // Every PostgreSQL row is independently bounded by the driver's message size.
    for (;;) {
      const [row] = yield* sql.unsafe<{ payload: string }>("FETCH NEXT FROM canopy_export");

      if (!row) break;
      yield* Effect.tryPromise(() => writer.write(tableName, row.payload));
    }

    yield* sql`CLOSE canopy_export`;
  });
}

function exportRouting(sql: Database, source: ProjectionMetadata["source"], writer: ProjectionWriter) {
  const { ownerUserId, nodeId } = source;
  const blockerQuery = consolidationBlockers(sql, ownerUserId);

  return Effect.gen(function* () {
    yield* exportRows(
      sql,
      `SELECT to_jsonb(r)::text AS payload FROM (
      SELECT c.owner_user_id,c.kind,c.local_id,c.global_id FROM public.config_items c
      JOIN public.projects p ON p.id::text=c.local_id AND p.owner_user_id=c.owner_user_id
      WHERE c.owner_user_id=$1::uuid AND c.kind='project' AND c.home_node_id IN ('',$2)
      ORDER BY c.global_id) r`,
      [ownerUserId, nodeId],
      "config_items",
      writer,
    );

    yield* exportRows(
      sql,
      `SELECT to_jsonb(r)::text AS payload FROM (
      SELECT owner_user_id,kind,item_id,from_node_id,home_node_id,home_name,moved_at,basis FROM public.computer_redirects
      WHERE owner_user_id=$1::uuid AND (from_node_id=$2 OR (home_node_id=$2 AND basis='local_move'))
      ORDER BY kind,item_id,from_node_id) r`,
      [ownerUserId, nodeId],
      "computer_redirects",
      writer,
    );

    // Compile the same blocker query used by source inventory and export only its public metadata.
    const [query, parameters] = blockerQuery.compile();
    yield* exportRows(
      sql,
      `SELECT jsonb_build_object('table_name',kind,'item_key',id::text,'reason',reason)::text AS payload
      FROM (${query}) blockers ORDER BY kind,id,reason`,
      parameters,
      projectionBlockersTable,
      writer,
    );
  });
}

// Rebuildable reports and ephemeral lease metadata are not persisted in the projection.
const replacedColumns = new Map<string, Readonly<Record<string, string>>>([
  ["workers", { capabilities: "'{}'::jsonb", last_seen_at: "NULL" }],
  ["connector_accounts", { tools: "'[]'::jsonb", error: "NULL" }],
  ["worker_configs", { applied_at: "NULL", applied_version: "NULL", applied_ok: "NULL", apply_report: "NULL" }],
  [
    "worker_environments",
    { automatic_tags: "'{}'::text[]", supported: "false", report: "'{}'::jsonb", reported_at: "NULL" },
  ],
  ["thread_secrets", { file_path: "NULL", applied_revision: "0" }],
]);

function exportTable(sql: Database, table: SelectedTable, owner: string, writer: ProjectionWriter) {
  return Effect.gen(function* () {
    const { name, secret, written } = table;

    if (name === "worker_model_catalogs" || name === "checkout_heads") return;

    if (name === "connector_project_grants") {
      // Transfer only grants with a real project of the exported owner. The projection uses the
      // source's local project id so staging can rebase it with the rest of the project references.
      yield* exportRows(
        sql,
        `SELECT to_jsonb(r)::text AS payload FROM (
        SELECT DISTINCT g.account_id,p.id AS project_id FROM public.connector_project_grants g
        JOIN public.connector_accounts a ON a.id=g.account_id
        JOIN public.projects p ON p.owner_user_id=a.owner_user_id AND p.kind='project'
        LEFT JOIN public.config_items c ON c.owner_user_id=p.owner_user_id AND c.kind='project'
          AND c.local_id=p.id::text AND c.unsupported=''
        LEFT JOIN public.config_aliases l ON l.owner_user_id=p.owner_user_id AND l.kind='project' AND l.alias_id=g.project_id::text
        WHERE a.owner_user_id=$1::uuid AND COALESCE(l.global_id,g.project_id::text)=COALESCE(c.global_id,p.id::text)
        ORDER BY g.account_id,p.id) r`,
        [owner],
        name,
        writer,
      );

      return;
    }

    // Generated primary keys identify source rows during staging. The target recomputes them.
    const columns = table.columns
      .filter((column) => column !== secret && (written.includes(column) || table.key.includes(column)))
      .map((column) => {
        const replacement = replacedColumns.get(name)?.[column];

        return replacement ? `${replacement} AS ${ident(column)}` : `s.${ident(column)}`;
      })
      .join(",");

    const homeWorker =
      name === "project_workspaces" || name === "worktrees" || name === "workspace_copies"
        ? " AND EXISTS (SELECT FROM public.workers w WHERE w.id=s.worker_id AND w.owner_user_id=$1::uuid)"
        : "";

    const source = `FROM ${publicTable(name)} s WHERE (${table.filter})${homeWorker}`;
    const order = table.key.map((column) => `s.${ident(column)}`).join(",");

    yield* exportRows(
      sql,
      `SELECT to_jsonb(r)::text AS payload FROM (SELECT ${columns} ${source} ORDER BY ${order}) r`,
      [owner],
      name,
      writer,
    );

    if (secret) {
      yield* exportRows(
        sql,
        `SELECT jsonb_build_object('table_name','${name}','column_name','${secret}',
        'source_key',${keySql("s", table)},'envelope_sha256',encode(sha256(s.${ident(secret)}),'hex'))::text AS payload
        ${source} AND s.${ident(secret)} IS NOT NULL ORDER BY ${order}`,
        [owner],
        projectionSecretsTable,
        writer,
      );
    }
  });
}
