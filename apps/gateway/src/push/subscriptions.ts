import { createHash } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { encryptSecret } from "../store/secrets.ts";
import { retirePushGrant } from "./revocation-store.ts";

export type PushPlatform = "ios" | "android";

export const expoTokenHash = (token: string) => createHash("sha256").update(token).digest();

export function pushRegistration(secretsKey: Buffer, token: string, previewKey: string) {
  return {
    hash: createHash("sha256").update(token).update("\0").update(previewKey).digest(),
    token: encryptSecret(secretsKey, token),
    key: encryptSecret(secretsKey, previewKey),
  };
}

type Registration = ReturnType<typeof pushRegistration>;

export function lockPushDevice(sql: SqlClient.SqlClient, owner: string, device: string) {
  return sql<{ platform: PushPlatform }>`SELECT platform FROM mobile_devices WHERE id = ${device}::uuid
    AND owner_user_id = ${owner}::uuid AND revoked_at IS NULL AND client_kind = 'mobile' AND pairing_version = 2
    AND platform IN ('ios', 'android') FOR UPDATE`;
}

export function writePushSubscription(
  sql: SqlClient.SqlClient,
  device: string,
  registration: Registration,
  managedGrantId: string | null = null,
  previousGrantId: string | null = null,
) {
  return sql`INSERT INTO mobile_push_subscriptions
    (device_id, registration_id, registration_hash, encrypted_token, encrypted_preview_key, expires_at, managed_grant_id)
    VALUES (${device}::uuid, gen_random_uuid(), ${registration.hash}, ${registration.token}, ${registration.key},
      now() + interval '30 days', ${managedGrantId}::uuid)
    ON CONFLICT (device_id) DO UPDATE SET
      registration_id = CASE WHEN mobile_push_subscriptions.registration_hash = EXCLUDED.registration_hash
          AND (mobile_push_subscriptions.managed_grant_id IS NOT DISTINCT FROM EXCLUDED.managed_grant_id
            OR mobile_push_subscriptions.managed_grant_id = ${previousGrantId}::uuid)
          AND mobile_push_subscriptions.expires_at > now()
        THEN mobile_push_subscriptions.registration_id ELSE EXCLUDED.registration_id END,
      registration_hash = EXCLUDED.registration_hash, encrypted_token = EXCLUDED.encrypted_token,
      encrypted_preview_key = EXCLUDED.encrypted_preview_key, expires_at = EXCLUDED.expires_at,
      managed_grant_id = EXCLUDED.managed_grant_id`;
}

export const setMobilePushSubscription = (
  owner: string,
  device: string,
  registration?: Registration,
  managed?: { origin: string; tokenHash: Buffer },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [active] = yield* lockPushDevice(sql, owner, device);

        if (!active) return "device-unavailable" as const;
        const grant = managed && (yield* matchingPushGrant(sql, device, { ...managed, platform: active.platform }))[0];

        if (registration && managed && !grant) return "enrollment-required" as const;

        if (registration) yield* writePushSubscription(sql, device, registration, grant?.id);
        else {
          // Fence pending attestations and persist relay revocation before forgetting the bearer.
          yield* sql`DELETE FROM mobile_push_enrollments WHERE device_id = ${device}::uuid`;
          yield* retirePushGrant(sql, owner, device);
          yield* sql`DELETE FROM mobile_push_subscriptions WHERE device_id = ${device}::uuid`;
        }

        return "ok" as const;
      }),
    );
  });

export type GrantScope = { origin: string; platform: PushPlatform; tokenHash: Buffer };

export type CachedPushGrant = { id: string; encrypted_bearer: Uint8Array; expires_at: Date; reattest_due: boolean };

export function matchingPushGrant(
  sql: SqlClient.SqlClient,
  device: string,
  { origin, platform, tokenHash }: GrantScope,
) {
  return sql<CachedPushGrant>`SELECT id, encrypted_bearer, expires_at, reattest_due FROM mobile_push_grants
    WHERE device_id = ${device}::uuid AND origin = ${origin} AND platform = ${platform}
      AND expo_token_hash = ${tokenHash} AND expires_at > clock_timestamp()`;
}
