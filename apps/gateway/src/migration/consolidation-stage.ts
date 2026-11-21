import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { Effect } from "effect";
import { decryptSecret } from "../store/secrets.ts";
import { ident, keySql, publicTable, staged, type Database, type SelectedTable } from "./consolidation-catalog.ts";
import { certificateIdentity } from "../computers/identity.ts";
import { consolidationError, type ConsolidationBlocker, type ConsolidationInput } from "./consolidation-types.ts";

interface TransferRow {
  payload: string;
  source_key: string;
  has_secret: boolean;
}

export function stageConsolidation(
  source: Database,
  target: Database,
  input: ConsolidationInput,
  tables: readonly SelectedTable[],
) {
  return Effect.gen(function* () {
    const counts: Record<string, number> = {};

    // Store only metadata about secrets while reviewing. Envelopes are read from the isolated
    // source by approved row key during apply and re-encrypted before PostgreSQL receives them.
    yield* target`CREATE TEMP TABLE cc_project_identity(id uuid, global_id text) ON COMMIT DROP`;
    yield* target`CREATE TEMP TABLE cc_redirect_edges(kind text, item_id uuid, from_node_id text,
      home_node_id text, home_name text, moved_at timestamptz) ON COMMIT DROP`;
    yield* target`CREATE TEMP TABLE cc_merge(table_name text, source_key text, target_key text,
      target_digest text, source_id uuid, target_id uuid) ON COMMIT DROP`;

    yield* stageRouting(source, target, input);

    for (const table of tables) {
      const name = staged(table.name);
      const columns = table.written.map(ident).join(",");
      yield* target.unsafe(`CREATE TEMP TABLE ${ident("cc_" + table.name)} ON COMMIT DROP AS
        SELECT ${columns},NULL::text AS __source_key,false AS __has_secret FROM ${publicTable(table.name)} WITH NO DATA`);

      counts[table.name] = yield* stageTable(source, target, input.source.ownerUserId, table);

      if (counts[table.name]) yield* target.unsafe(`CREATE INDEX ON ${name} (${table.key.map(ident).join(",")})`);
    }

    const blockers = yield* source<ConsolidationBlocker>`SELECT table_name AS "table",item_key AS key,reason
      FROM public.consolidation_export_blockers ORDER BY table_name,item_key,reason`;

    const [secretCount] = yield* source<{
      total: number;
    }>`SELECT count(*)::int AS total FROM public.consolidation_export_secrets`;

    let stagedSecrets = 0;

    for (const { name, secret } of tables) {
      if (!secret || !counts[name]) continue;

      const [selected] = yield* target.unsafe<{ total: number }>(
        `SELECT count(*)::int AS total FROM ${staged(name)} WHERE __has_secret`,
      );

      stagedSecrets += selected?.total ?? 0;
    }

    if (secretCount?.total !== stagedSecrets)
      return yield* Effect.fail(consolidationError("Projected secret markers do not match the imported rows."));

    return { counts, blockers };
  });
}

function stageTable(source: Database, target: Database, owner: string, table: SelectedTable) {
  return Effect.gen(function* () {
    const session = "cc_transfer";
    const { name, secret, written } = table;

    const include = written
      .filter((column) => column !== secret)
      .map((column) => `s.${ident(column)}`)
      .join(",");

    const sourceKey = keySql("s", table);

    const secretField = secret
      ? `EXISTS (SELECT FROM public.consolidation_export_secrets r
      WHERE r.table_name='${name}' AND r.column_name='${secret}' AND r.source_key=${sourceKey})`
      : "false";

    if (secret) {
      const [entry] = yield* source.unsafe<{ present: boolean }>(
        `SELECT EXISTS (SELECT FROM ${publicTable(name)} WHERE ${ident(secret)} IS NOT NULL) AS present`,
      );

      if (entry?.present)
        return yield* Effect.fail(
          consolidationError("The consolidation projection contains an encrypted source credential."),
        );
    }

    yield* source.unsafe(
      `DECLARE ${session} NO SCROLL CURSOR FOR
      SELECT to_jsonb(r)::text AS payload, r.__source_key AS source_key, r.__has_secret AS has_secret
      FROM (SELECT ${include}, ${sourceKey} AS __source_key, ${secretField} AS __has_secret
        FROM ${publicTable(name)} s WHERE ${table.filter}) r`,
      [owner],
    );

    let count = 0;

    for (;;) {
      // Blob payload is bytea encoded as hex JSON. Fetch it one row at a time.
      const rows = yield* source.unsafe<TransferRow>(`FETCH FORWARD ${name === "blobs" ? 1 : 16} FROM ${session}`);

      if (!rows.length) break;

      const columns = written.map(ident).join(",");
      const projected = written.map((column) => `v.${ident(column)}`).join(",");

      for (const batch of transferBatches(rows)) {
        const json =
          "[" +
          batch
            .map(
              (r) =>
                `{"payload":${r.payload},"source_key":${JSON.stringify(r.source_key)},"has_secret":${r.has_secret}}`,
            )
            .join(",") +
          "]";

        yield* target.unsafe(
          `INSERT INTO ${staged(name)} (${columns},__source_key,__has_secret)
          SELECT ${projected}, r.source_key, r.has_secret FROM
          jsonb_to_recordset($1::jsonb) AS r(payload jsonb,source_key text,has_secret boolean)
          CROSS JOIN LATERAL jsonb_populate_record(NULL::${staged(name)},r.payload) AS v`,
          [json],
        );
      }

      count += rows.length;
    }

    yield* source.unsafe(`CLOSE ${session}`);

    return count;
  });
}

function* transferBatches(rows: readonly TransferRow[]) {
  let batch: TransferRow[] = [];
  let size = 0;

  for (const row of rows) {
    if (batch.length && size + row.payload.length > 2 * 1024 * 1024) {
      yield batch;
      batch = [];
      size = 0;
    }

    batch.push(row);
    size += row.payload.length;
  }

  if (batch.length) yield batch;
}

function stageRouting(source: Database, target: Database, input: ConsolidationInput) {
  return Effect.gen(function* () {
    const { ownerUserId, nodeId } = input.source;

    const projects = yield* source<{ id: string; global_id: string }>`SELECT p.id,c.global_id
      FROM public.config_items c JOIN public.projects p ON p.id::text=c.local_id AND p.owner_user_id=c.owner_user_id
      WHERE c.owner_user_id=${ownerUserId}::uuid AND c.kind='project'`;

    // Take only departures attested by the restored home or verified against this restored
    // owner's move history. Conflicting edges are checked against the target during review.
    const redirects = yield* source<{
      payload: string;
    }>`SELECT jsonb_agg(to_jsonb(r)-'owner_user_id'-'basis')::text AS payload
      FROM public.computer_redirects r
      WHERE r.owner_user_id=${ownerUserId}::uuid AND (r.from_node_id=${nodeId}
        OR (r.home_node_id=${nodeId} AND r.basis='local_move'))`;

    yield* target`INSERT INTO pg_temp.cc_project_identity
      SELECT r.id,r.global_id FROM jsonb_to_recordset(${JSON.stringify(projects)}::jsonb) r(id uuid, global_id text)`;
    yield* target`INSERT INTO pg_temp.cc_redirect_edges
      SELECT r.kind,r.item_id,r.from_node_id,r.home_node_id,r.home_name,r.moved_at
      FROM jsonb_to_recordset(${redirects[0]?.payload ?? "[]"}::jsonb)
        r(kind text,item_id uuid,from_node_id text,home_node_id text,home_name text,moved_at timestamptz)`;
  });
}

export function verifyProjectionIdentity(source: Database, input: ConsolidationInput, apply: boolean) {
  return Effect.gen(function* () {
    const { ownerUserId, nodeId } = input.source;

    const [identity] = yield* source<{ node_id: string; certificate: string }>`
      SELECT i.node_id,i.certificate FROM public.computer_identity i
      JOIN public.users u ON u.id=i.owner_user_id AND u.disabled_at IS NULL
      WHERE i.owner_user_id=${ownerUserId}::uuid AND i.node_id=${nodeId}
        AND (SELECT count(*) FROM public.computer_identity)=1 AND to_jsonb(i)->>'private_key' IS NULL`;

    yield* Effect.try({
      try: () => {
        if (!identity || certificateIdentity(identity.certificate).nodeId !== nodeId) throw new Error();
      },
      catch: () => consolidationError("The staged owner or linked computer identity does not match."),
    });

    if (apply) {
      const [fence] = yield* source<{ drained: boolean }>`SELECT EXISTS (
        SELECT FROM public.gateway_relocation_fence WHERE singleton AND operation_id=${input.operationId}::uuid
          AND state='drained') AS drained`;

      if (!fence?.drained)
        return yield* Effect.fail(
          consolidationError("The staged projection does not contain the drained source fence for this operation."),
        );
    }
  });
}

export function inspectIdentity(sql: Database, owner: string, key: Buffer) {
  return Effect.gen(function* () {
    const [identity] = yield* sql<{ node_id: string; name: string; certificate: string; private_key: Uint8Array }>`
      SELECT i.node_id,i.name,i.certificate,i.private_key FROM public.computer_identity i
      JOIN public.users u ON u.id=i.owner_user_id AND u.disabled_at IS NULL WHERE i.owner_user_id=${owner}::uuid`;

    return yield* Effect.try({
      try: () => {
        if (!identity) throw new Error();
        const cert = new X509Certificate(identity.certificate);
        const privateKey = createPrivateKey(decryptSecret(key, identity.private_key));

        const expected = createHash("sha256")
          .update(cert.publicKey.export({ type: "spki", format: "der" }))
          .digest("hex");

        if (!cert.checkPrivateKey(privateKey) || expected !== identity.node_id) throw new Error();

        return { node_id: identity.node_id, name: identity.name };
      },
      catch: () =>
        consolidationError("The selected owner, linked computer identity, or encryption key does not match."),
    });
  });
}
