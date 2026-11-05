import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { decryptSecret, encryptSecret } from "../store/secrets.ts";
import { fail, type AccountRow, type Credentials } from "./records.ts";

/** Sealed credentials: only this store encrypts and decrypts them. */
export function connectorSealing(sql: SqlClient.SqlClient, key: Buffer) {
  // SAFETY: only this store writes sealed columns: JSON of the declared type, encrypted with AES-256-GCM under
  // `key`. Decryption rejects any other ciphertext, so the plaintext is that JSON.
  const opened = <T>(sealed: Parameters<typeof decryptSecret>[1]): T => JSON.parse(decryptSecret(key, sealed)) as T;

  const unseal = (row: AccountRow): Credentials => (row.credentials ? opened<Credentials>(row.credentials) : {});

  const seal = (value: Credentials) => encryptSecret(key, JSON.stringify(value));

  const credentials = (row: AccountRow) =>
    Effect.gen(function* () {
      const value = unseal(row);
      const headers = { ...value.headers };

      for (const [name, ref] of Object.entries(row.legacy_headers)) {
        const secret = (yield* sql<{
          ciphertext: Uint8Array;
        }>`SELECT ciphertext FROM secrets WHERE id=${ref.secretRef}::uuid AND owner_user_id=${row.owner_user_id}::uuid`)[0];

        if (!secret) return yield* fail("Connector credentials unavailable");
        headers[name] = decryptSecret(key, secret.ciphertext);
      }

      return { ...value, headers };
    });

  const updateCredentials = (row: AccountRow, value: Credentials, status = row.status) =>
    sql`UPDATE connector_accounts SET credentials=${seal(value)}, legacy_headers='{}', status=${status}, error=NULL, updated_at=now() WHERE id=${row.id}::uuid`;

  return { opened, unseal, seal, credentials, updateCredentials };
}
