import type { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { X509Certificate } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { decryptSecret, encryptSecret, SECRETS_KEY_ID } from "../store/secrets.ts";
import { normalizedRelayOrigin, PUSH_KEY, type PushRelayOptions } from "./relay.ts";

const CERTIFICATE =
  /^-----BEGIN CERTIFICATE-----\n([A-Za-z0-9+/=]+(?:\n[A-Za-z0-9+/=]+)*)\n-----END CERTIFICATE-----$/gm;

function privateCa(value: string) {
  const invalid = new ConnectError("Paste CA certificates in PEM format.", Code.InvalidArgument);

  if (value.length > 64 * 1024) throw invalid;
  const pem = value.replaceAll("\r\n", "\n");
  const certificates: string[] = [];
  let end = 0;

  try {
    for (const block of pem.matchAll(CERTIFICATE)) {
      const base64 = block[1]?.replaceAll("\n", "");

      if (!base64 || pem.slice(end, block.index).trim()) throw invalid;
      const der = Buffer.from(base64, "base64");

      if (der.toString("base64") !== base64) throw invalid;
      const certificate = new X509Certificate(der);

      if (!certificate.ca || !certificate.raw.equals(der)) throw invalid;
      certificates.push(certificate.toString().trimEnd());
      end = block.index + block[0].length;
    }
  } catch {
    throw invalid;
  }

  if (!certificates.length || pem.slice(end).trim()) throw invalid;

  return certificates.join("\n") + "\n";
}

type RelayChoice = { useManaged: boolean; custom?: PushRelayOptions };

export function updatedRelayChoice(
  input: ui.UpdatePushRelaySettingsRequest,
  current: PushRelayOptions | undefined,
): RelayChoice {
  if (input.useManaged) {
    if (input.remove || input.origin || input.bearer || input.caPem !== undefined)
      throw new ConnectError("Choose one push relay.", Code.InvalidArgument);

    return { useManaged: true };
  }

  if (input.remove) return { useManaged: false };
  const value = input.origin.trim();
  const origin = /^https:\/\/[^/?#@\\\s]+\/?$/i.test(value) && normalizedRelayOrigin(value);

  if (!origin)
    throw new ConnectError("Enter an HTTPS address with only the hostname and optional port.", Code.InvalidArgument);
  const sameOrigin = current?.origin === origin;
  const bearer = input.bearer || (sameOrigin ? current.bearer : "");

  if (!PUSH_KEY.test(bearer))
    throw new ConnectError("Enter the 43-character token from your relay operator.", Code.InvalidArgument);
  const ca = input.caPem === undefined ? (sameOrigin ? current.ca : undefined) : input.caPem && privateCa(input.caPem);

  return { useManaged: false, custom: { origin, bearer, ...(ca && { ca }) } };
}

type SettingsRow = {
  origin: string | null;
  encrypted_bearer: Uint8Array | null;
  ca_pem: string | null;
  use_managed: boolean;
};

export const loadPushRelaySettings = (owner: string, key: Buffer) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql<SettingsRow>`SELECT origin, encrypted_bearer, ca_pem, use_managed
      FROM mobile_push_relay_settings WHERE owner_user_id = ${owner}::uuid`;

    const row = rows[0];

    if (!row) return;

    if (!row.origin || !row.encrypted_bearer) return { useManaged: row.use_managed };

    return {
      useManaged: false,
      custom: {
        origin: row.origin,
        bearer: decryptSecret(key, row.encrypted_bearer),
        ...(row.ca_pem && { ca: row.ca_pem }),
      },
    };
  });

export const savePushRelaySettings = (
  owner: string,
  key: Buffer,
  { useManaged, custom }: RelayChoice,
  retireReceipts: boolean,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        // An explicit removal must survive restarts with deployment defaults still set.
        const bearer = custom ? encryptSecret(key, custom.bearer) : null;
        yield* sql`INSERT INTO mobile_push_relay_settings (owner_user_id, origin, encrypted_bearer, key_id, ca_pem, use_managed)
          VALUES (${owner}::uuid, ${custom?.origin ?? null}, ${bearer}, ${custom ? SECRETS_KEY_ID : null}, ${custom?.ca ?? null}, ${useManaged})
          ON CONFLICT (owner_user_id) DO UPDATE SET origin = EXCLUDED.origin,
            encrypted_bearer = EXCLUDED.encrypted_bearer, key_id = EXCLUDED.key_id, ca_pem = EXCLUDED.ca_pem,
            use_managed = EXCLUDED.use_managed`;

        // A ticket belongs to the previous relay. Keep its local receipt resolvable by the phone.
        if (retireReceipts) {
          yield* sql`UPDATE mobile_push_outbox SET next_attempt_at = NULL
            WHERE owner_user_id = ${owner}::uuid AND ticket_id IS NOT NULL AND next_attempt_at IS NOT NULL`;
          yield* sql`DELETE FROM mobile_push_enrollments e USING mobile_devices d
            WHERE e.device_id = d.id AND d.owner_user_id = ${owner}::uuid`;
        }
      }),
    );
  });
