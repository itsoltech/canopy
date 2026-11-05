import { Effect } from "effect";
import { type SqlClient } from "effect/sql";
import { decryptSecret, encryptSecret } from "../store/secrets.ts";
import type { ConfigRow, Field } from "./persistence.ts";

/**
 * Secret field versions (docs/linked-computers.md, "Sekrety"). A record holds a random token; the value of each
 * version is in config_secrets, encrypted with this computer's key and keyed by the version's HLC. The plain
 * value exists only while a link stream sends it and while a receiver stores it again with its own key.
 */

type SecretRow = { kind: string; global_id: string; field: string; hlc: string; ciphertext: Uint8Array };

export type Cipher = (name: string, field: Field) => Uint8Array | undefined;

export const versionKey = (kind: string, id: string, field: string, hlc: string) =>
  `${kind}\x1f${id}\x1f${field}\x1f${hlc}`;

/** Ciphertexts of the current and incoming versions this merge may move to history. */
export function recordCiphers(sql: SqlClient.SqlClient, owner: string, kind: string, id: string) {
  return Effect.gen(function* () {
    const rows = yield* sql<SecretRow>`SELECT kind,global_id,field,hlc,ciphertext FROM config_secrets
      WHERE owner_user_id=${owner}::uuid AND kind=${kind} AND global_id=${id}`;

    return new Map(rows.map((r) => [`${r.field}\x1f${r.hlc}`, r.ciphertext]));
  });
}

export const cipherOf =
  (known: ReadonlyMap<string, Uint8Array>): Cipher =>
  (name, field) =>
    known.get(`${name}\x1f${field.hlc}`);

/** Values for the link stream only. Callers attach them to the outgoing fields and drop the map. */
export function outgoingSecrets(sql: SqlClient.SqlClient, owner: string, key: Buffer, rows: readonly ConfigRow[]) {
  return Effect.gen(function* () {
    const ids = rows.map((r) => `${r.kind}\x1f${r.global_id}`);

    if (!ids.length) return new Map<string, string>();

    const found = yield* sql<SecretRow>`SELECT kind,global_id,field,hlc,ciphertext FROM config_secrets
      WHERE owner_user_id=${owner}::uuid AND kind||chr(31)||global_id=ANY(${ids}::text[])`;

    const current = new Map(rows.map((r) => [`${r.kind}\x1f${r.global_id}`, r]));

    return new Map(
      found.flatMap((s) =>
        current.get(`${s.kind}\x1f${s.global_id}`)?.fields[s.field]?.hlc === s.hlc
          ? [[versionKey(s.kind, s.global_id, s.field, s.hlc), decryptSecret(key, s.ciphertext)] as const]
          : [],
      ),
    );
  });
}

export function storeSecret(
  sql: SqlClient.SqlClient,
  owner: string,
  row: Pick<ConfigRow, "kind" | "global_id">,
  field: string,
  hlc: string,
  ciphertext: Uint8Array,
  secretId: string | null = null,
) {
  return sql`INSERT INTO config_secrets(owner_user_id,kind,global_id,field,hlc,ciphertext,secret_id)
    VALUES(${owner}::uuid,${row.kind},${row.global_id},${field},${hlc},${ciphertext},${secretId}::uuid)
    ON CONFLICT(owner_user_id,kind,global_id,field,hlc) DO UPDATE SET secret_id=COALESCE(excluded.secret_id,config_secrets.secret_id)`;
}

/** Received values are encrypted again with this computer's key before anything else sees them. */
export function encryptIncoming(key: Buffer, row: ConfigRow, plain: ReadonlyMap<string, string>) {
  const ciphers = new Map<string, Uint8Array>();

  for (const [name, value] of plain) {
    const field = name === "deleted" ? undefined : row.fields[name];

    if (field) ciphers.set(`${name}\x1f${field.hlc}`, encryptSecret(key, value));
  }

  return ciphers;
}

/** Only current versions stay; history rows keep their own ciphertext for Restore. */
export function pruneSecrets(sql: SqlClient.SqlClient, owner: string, row: ConfigRow) {
  const current = Object.entries(row.fields).map(([name, field]) => `${name}\x1f${field.hlc}`);

  return sql`DELETE FROM config_secrets WHERE owner_user_id=${owner}::uuid AND kind=${row.kind} AND global_id=${row.global_id}
    AND NOT (field||chr(31)||hlc=ANY(${current}::text[]))`;
}

/** The current version's plain value, for comparing identities and materializing domain secrets. */
export function currentSecret(sql: SqlClient.SqlClient, owner: string, key: Buffer, row: ConfigRow, name: string) {
  return Effect.gen(function* () {
    const field = row.fields[name];

    if (!field) return undefined;

    const found = (yield* sql<{ ciphertext: Uint8Array; secret_id: string | null }>`SELECT ciphertext,secret_id::text
      FROM config_secrets WHERE owner_user_id=${owner}::uuid AND kind=${row.kind} AND global_id=${row.global_id}
      AND field=${name} AND hlc=${field.hlc}`)[0];

    return found && { plain: decryptSecret(key, found.ciphertext), ...found };
  });
}
