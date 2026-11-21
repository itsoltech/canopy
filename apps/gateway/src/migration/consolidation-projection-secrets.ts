import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { databaseUrl } from "../database-credentials.ts";
import { decryptSecret, loadSecretsKey } from "../store/secrets.ts";
import {
  consolidationCatalog,
  databaseLayer,
  ident,
  keySql,
  publicTable,
  type Database,
} from "./consolidation-catalog.ts";
import {
  projectionFrames,
  projectionOperation,
  projectionOperationId,
  projectionSecretsTable,
  readProjectionManifest,
  type ProjectionManifest,
} from "./consolidation-projection-format.ts";
import { assertProjectionOffline, selectedOwner } from "./consolidation-projection-source.ts";
import { consolidationSecretId, consolidationError } from "./consolidation-types.ts";

interface LoadOptions {
  operationId: string;
  archiveSha256: string;
  approvedSecretIds: readonly string[];
}

const hex = /^[a-f0-9]{64}$/;

const markerSchema = Schema.Struct({
  table_name: Schema.String,
  column_name: Schema.String,
  source_key: Schema.String,
  envelope_sha256: Schema.String.check(Schema.isPattern(hex)),
});

const readMarker = Schema.decodeUnknownSync(Schema.fromJsonString(markerSchema), { onExcessProperty: "error" });

type SecretMarker = typeof markerSchema.Type;

/** Resolve opaque review IDs through the authenticated local artifact before querying any envelope. */
async function approvedMarkers(directory: string, manifest: ProjectionManifest, approvedIds: readonly string[]) {
  const approved = new Set(approvedIds);
  const markers = new Map<string, SecretMarker>();

  if (approved.size !== approvedIds.length || approvedIds.some((id) => !hex.test(id)))
    throw consolidationError("Consolidation secret approvals must contain distinct valid IDs.");

  for await (const row of projectionFrames(directory, manifest)) {
    if (row.table !== projectionSecretsTable) continue;

    const marker = readMarker(row.payload);
    const id = consolidationSecretId(marker.table_name, marker.source_key, marker.column_name);

    if (!approved.has(id)) continue;

    if (markers.has(id)) throw consolidationError("The source projection repeats an approved secret ID.");
    markers.set(id, marker);
  }

  if (markers.size !== approved.size)
    throw consolidationError("An approved secret ID is missing from the final projection.");

  return markers;
}

function loadEnvelopes(
  sql: Database,
  env: NodeJS.ProcessEnv,
  manifest: ProjectionManifest,
  markers: ReadonlyMap<string, SecretMarker>,
) {
  return Effect.gen(function* () {
    yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    yield* assertProjectionOffline(sql, manifest.operationId, true);

    const { ownerUserId, nodeId, ownerEmail } = manifest.source;

    const [identity] = yield* sql<{ matches: boolean }>`SELECT EXISTS (
      SELECT FROM public.computer_identity i JOIN public.users u ON u.id=i.owner_user_id
      WHERE i.node_id=${nodeId} AND u.id=${ownerUserId}::uuid AND u.email=${ownerEmail}
        AND u.email=${selectedOwner(env)} AND u.disabled_at IS NULL) AS matches`;

    const catalog = yield* consolidationCatalog(sql);

    if (!identity?.matches || manifest.catalogSignature !== catalog.signature)
      return yield* Effect.fail(
        consolidationError("The final projection no longer matches this source owner or release."),
      );

    const key = loadSecretsKey(env);
    const payloads: { id: string; value: string }[] = [];

    for (const [id, marker] of markers) {
      const table = catalog.selected.find(
        ({ name, secret }) => name === marker.table_name && secret === marker.column_name,
      );

      if (!table?.secret)
        return yield* Effect.fail(consolidationError("An approved secret has no source projection policy."));

      const column = ident(table.secret);

      const [row] = yield* sql.unsafe<{ envelope: Uint8Array }>(
        `SELECT s.${column} AS envelope
        FROM ${publicTable(table.name)} s WHERE (${table.filter}) AND ${keySql("s", table)}=$2
          AND encode(sha256(s.${column}),'hex')=$3`,
        [ownerUserId, marker.source_key, marker.envelope_sha256],
      );

      if (!row)
        return yield* Effect.fail(
          consolidationError("An approved source secret is missing or has changed since review."),
        );

      const value = yield* Effect.try({
        try: () => Buffer.from(decryptSecret(key, row.envelope), "utf8").toString("base64"),
        catch: () => consolidationError("An approved source secret could not be decrypted."),
      });

      payloads.push({ id, value });
    }

    yield* assertProjectionOffline(sql, manifest.operationId, true);

    return payloads;
  });
}

export function loadApprovedConsolidationSecrets(
  env: NodeJS.ProcessEnv,
  directory: string,
  options: LoadOptions,
): Promise<readonly { id: string; value: string }[]> {
  return projectionOperation(async () => {
    const manifest = await readProjectionManifest(directory);

    if (
      manifest.operationId !== projectionOperationId(options.operationId) ||
      manifest.archiveSha256 !== options.archiveSha256 ||
      manifest.fence !== "drained"
    )
      throw consolidationError("Approve the secrets from the matching final source projection.");

    const markers = await approvedMarkers(directory, manifest, options.approvedSecretIds);

    return Effect.runPromise(
      SqlClient.SqlClient.use((sql) => sql.withTransaction(loadEnvelopes(sql, env, manifest, markers))).pipe(
        Effect.provide(databaseLayer(databaseUrl(env), "canopy-projection-secrets")),
      ),
    );
  });
}
