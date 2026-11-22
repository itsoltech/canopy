import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { GrantScope, PushPlatform } from "./subscriptions.ts";

type PushRevocation = {
  id: string;
  device_id: string;
  platform: PushPlatform;
  expo_token_hash: Uint8Array;
  encrypted_bearer: Uint8Array;
};

export function retirePushGrant(sql: SqlClient.SqlClient, owner: string, device: string) {
  return sql<Pick<PushRevocation, "id" | "platform" | "expo_token_hash"> & { origin: string }>`WITH retired AS (
    DELETE FROM mobile_push_grants g USING mobile_devices d WHERE g.device_id = d.id
      AND d.owner_user_id = ${owner}::uuid AND d.id = ${device}::uuid
    RETURNING g.id, g.device_id, g.origin, g.platform, g.expo_token_hash, g.encrypted_bearer
  )
  INSERT INTO mobile_push_revocations (id, owner_user_id, device_id, origin, platform, expo_token_hash, encrypted_bearer)
  SELECT id, ${owner}::uuid, device_id, origin, platform, expo_token_hash, encrypted_bearer FROM retired
  RETURNING id, origin, platform, expo_token_hash`;
}

export const enqueuePushRevocation = (owner: string, device: string, scope: GrantScope, bearer: Buffer) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`INSERT INTO mobile_push_revocations
      (id, owner_user_id, device_id, origin, platform, expo_token_hash, encrypted_bearer)
      VALUES (gen_random_uuid(), ${owner}::uuid, ${device}::uuid, ${scope.origin}, ${scope.platform},
        ${scope.tokenHash}, ${bearer})`;
  });

export const claimPushRevocations = (owner: string, origin: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql<PushRevocation>`WITH due AS (
      SELECT id FROM mobile_push_revocations WHERE owner_user_id = ${owner}::uuid AND origin = ${origin}
        AND expires_at > now() AND next_attempt_at <= now()
      ORDER BY next_attempt_at LIMIT 8 FOR UPDATE SKIP LOCKED
    )
    UPDATE mobile_push_revocations r SET next_attempt_at = now() + interval '1 minute'
      FROM due WHERE r.id = due.id RETURNING r.id, r.device_id, r.platform, r.expo_token_hash, r.encrypted_bearer`;
  });

export const settlePushRevocation = (owner: string, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`DELETE FROM mobile_push_revocations WHERE owner_user_id = ${owner}::uuid AND id = ${id}::uuid`;
  });
