import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { retirePushGrant } from "./revocation-store.ts";
import {
  lockPushDevice,
  matchingPushGrant,
  writePushSubscription,
  type GrantScope,
  type PushPlatform,
} from "./subscriptions.ts";

export const reservePushEnrollment = (
  owner: string,
  device: string,
  input: Omit<GrantScope, "platform"> & {
    encryptedToken: Buffer;
    rejectedGrantId?: string | undefined;
    refreshGrantId?: string | undefined;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [active] = yield* lockPushDevice(sql, owner, device);

        if (!active) return;
        const { platform } = active;
        const { origin, tokenHash, encryptedToken, rejectedGrantId, refreshGrantId } = input;
        const [grant] = yield* matchingPushGrant(sql, device, { origin, platform, tokenHash });
        const refreshExistingGrant = !!grant && grant.id === refreshGrantId;

        if (grant && grant.id !== rejectedGrantId && !refreshExistingGrant)
          return { kind: "grant" as const, platform, grant };

        const requestId = randomUUID();

        yield* sql`INSERT INTO mobile_push_enrollments
          (device_id, request_id, origin, platform, expo_token_hash, encrypted_token, expires_at)
          VALUES (${device}::uuid, ${requestId}::uuid, ${origin}, ${platform}, ${tokenHash}, ${encryptedToken},
            clock_timestamp() + interval '5 minutes')
          ON CONFLICT (device_id) DO UPDATE SET request_id = EXCLUDED.request_id, origin = EXCLUDED.origin,
            platform = EXCLUDED.platform, expo_token_hash = EXCLUDED.expo_token_hash,
            encrypted_token = EXCLUDED.encrypted_token, expires_at = EXCLUDED.expires_at,
            relay_id = NULL, encrypted_claim = NULL`;

        if (grant && grant.id === rejectedGrantId)
          yield* sql`UPDATE mobile_push_grants SET expires_at = clock_timestamp()
            WHERE device_id = ${device}::uuid AND id = ${grant.id}::uuid`;

        return { kind: "challenge" as const, platform, requestId, refreshExistingGrant };
      }),
    );
  });

export const savePushChallenge = (owner: string, device: string, requestId: string, relayId: string, claim: Buffer) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql`UPDATE mobile_push_enrollments e SET relay_id = ${relayId}::uuid, encrypted_claim = ${claim}
      FROM mobile_devices d WHERE e.device_id = d.id AND d.owner_user_id = ${owner}::uuid AND d.revoked_at IS NULL
        AND d.id = ${device}::uuid AND e.request_id = ${requestId}::uuid AND e.expires_at > clock_timestamp()
      RETURNING e.request_id`;

    return rows.length > 0;
  });

type PendingChallenge = {
  request_id: string;
  platform: PushPlatform;
  expo_token_hash: Uint8Array;
  encrypted_token: Uint8Array;
  encrypted_claim: Uint8Array;
};

export const claimPushChallenge = (owner: string, device: string, origin: string, relayId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [active] = yield* lockPushDevice(sql, owner, device);

        if (!active) return;

        const [pending] = yield* sql<PendingChallenge>`SELECT request_id, platform, expo_token_hash,
          encrypted_token, encrypted_claim FROM mobile_push_enrollments
          WHERE device_id = ${device}::uuid AND origin = ${origin} AND relay_id = ${relayId}::uuid
            AND platform = ${active.platform} AND encrypted_claim IS NOT NULL AND expires_at > clock_timestamp()
          FOR UPDATE`;

        if (!pending) return;

        yield* sql`UPDATE mobile_push_enrollments SET encrypted_claim = NULL
          WHERE device_id = ${device}::uuid AND request_id = ${pending.request_id}::uuid`;

        return pending;
      }),
    );
  });

export const registerManagedPush = (
  owner: string,
  device: string,
  input: GrantScope & { requestId: string; bearer: Buffer; expiresAtMs: number },
  registration: Parameters<typeof writePushSubscription>[2],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const [active] = yield* lockPushDevice(sql, owner, device);

        if (!active || active.platform !== input.platform) return false;
        const { requestId, origin, platform, tokenHash, bearer, expiresAtMs } = input;

        const removed = yield* sql`DELETE FROM mobile_push_enrollments WHERE device_id = ${device}::uuid
          AND request_id = ${requestId}::uuid AND platform = ${platform} AND origin = ${origin}
          AND expo_token_hash = ${tokenHash} AND encrypted_claim IS NULL AND expires_at > clock_timestamp()
          RETURNING request_id`;

        if (!removed.length) return false;
        const grantId = randomUUID();

        const [previous] = yield* retirePushGrant(sql, owner, device);
        yield* sql`INSERT INTO mobile_push_grants
          (device_id, id, origin, platform, expo_token_hash, encrypted_bearer, expires_at)
          VALUES (${device}::uuid, ${grantId}::uuid, ${origin}, ${platform}, ${tokenHash}, ${bearer}, ${new Date(expiresAtMs)})`;

        const sameTarget =
          previous &&
          previous.origin === origin &&
          previous.platform === platform &&
          tokenHash.equals(previous.expo_token_hash);

        yield* writePushSubscription(sql, device, registration, grantId, sameTarget ? previous.id : null);

        return true;
      }),
    );
  });

export const renewPushGrant = (
  owner: string,
  device: string,
  id: string,
  { expiresAtMs, reattest }: { expiresAtMs: number; reattest?: boolean },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql`UPDATE mobile_push_grants g
      SET expires_at = greatest(g.expires_at, ${new Date(expiresAtMs)}), reattest_due = g.reattest_due OR ${reattest === true}
      FROM mobile_devices d WHERE g.device_id = d.id AND d.owner_user_id = ${owner}::uuid AND d.revoked_at IS NULL
        AND d.id = ${device}::uuid AND g.id = ${id}::uuid AND g.expires_at > clock_timestamp() RETURNING g.id`;

    return rows.length > 0;
  });

export const invalidatePushGrant = (owner: string, device: string, id: string, expiresAt: Date) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE mobile_push_grants g SET expires_at = clock_timestamp()
      FROM mobile_devices d WHERE g.device_id = d.id AND d.owner_user_id = ${owner}::uuid
        AND d.id = ${device}::uuid AND g.id = ${id}::uuid AND g.expires_at = ${expiresAt}
        AND g.expires_at > clock_timestamp()`;
  });
