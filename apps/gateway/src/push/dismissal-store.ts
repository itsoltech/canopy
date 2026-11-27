import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { dismissibleEvent, managedGrant, registered } from "./store.ts";
import type { PushPlatform } from "./subscriptions.ts";

/** A phone receives at most one silent dismissal in this window; later marks wait for the next one. */
const throttleSeconds = 10;
const maxAttempts = 5;
export const maxDismissedReceipts = 32;

type LeasedRow = {
  id: string;
  device_id: string;
  registration_id: string;
  platform: PushPlatform;
  encrypted_token: Uint8Array;
  encrypted_preview_key: Uint8Array;
  lease_until: Date;
  grant_id: string | null;
  grant_expires_at: Date | null;
  encrypted_bearer: Uint8Array | null;
  expo_token_hash: Uint8Array | null;
};

type RoutedRow = Omit<LeasedRow, "lease_until"> & { throttled: boolean | null };

export type DismissalLease = Omit<LeasedRow, "id"> & { ids: string[] };

/**
 * Leases marked rows whose push reached the provider and is now stale, grouped by phone. Rows that turned
 * unread again or never went out lose their mark; rows still in delivery or inside a phone's throttle wait.
 */
export const claimPushDismissals = (owner: string, managedOrigin: string | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const [due] = yield* sql`SELECT 1 FROM mobile_push_outbox
      WHERE owner_user_id = ${owner}::uuid AND dismiss_at <= now() LIMIT 1`;

    if (!due) return [];

    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const marked = yield* sql<{ id: string; ready: boolean; sending: boolean }>`
          SELECT o.id,
            (o.ticket_id IS NOT NULL AND o.created_at > now() - interval '1 day' AND ${dismissibleEvent(sql)}) AS ready,
            (o.ticket_id IS NULL AND o.next_attempt_at IS NOT NULL AND o.created_at > now() - interval '5 minutes') AS sending
          FROM mobile_push_outbox o
          WHERE o.owner_user_id = ${owner}::uuid AND o.dismiss_at <= now() AND o.dismissed_at IS NULL
          ORDER BY o.dismiss_at LIMIT 64 FOR UPDATE OF o SKIP LOCKED`;

        const ready = marked.filter((row) => row.ready).map((row) => row.id);
        const sending = marked.filter((row) => !row.ready && row.sending).map((row) => row.id);

        if (sending.length)
          yield* sql`UPDATE mobile_push_outbox SET dismiss_at = now() + interval '10 seconds'
            WHERE id = ANY(${sending}::uuid[])`;

        const routed = ready.length
          ? yield* sql<RoutedRow>`SELECT o.id, o.device_id, o.registration_id, d.platform, s.encrypted_token,
              s.encrypted_preview_key,
              s.last_dismissal_at > now() - ${throttleSeconds}::integer * interval '1 second' AS throttled,
              ${
                managedOrigin
                  ? sql`g.id AS grant_id, g.expires_at AS grant_expires_at, g.encrypted_bearer, g.expo_token_hash`
                  : sql`NULL::uuid AS grant_id, NULL::timestamptz AS grant_expires_at,
                    NULL::bytea AS encrypted_bearer, NULL::bytea AS expo_token_hash`
              }
            FROM mobile_push_outbox o ${registered(sql)} ${managedOrigin ? managedGrant(sql, managedOrigin) : sql``}
            WHERE o.id = ANY(${ready}::uuid[]) ${managedOrigin ? sql`` : sql`AND s.managed_grant_id IS NULL`}`
          : [];

        const throttled = routed.filter((row) => row.throttled).map((row) => row.id);
        const leasable = perDevice(routed.filter((row) => !row.throttled)).map((row) => row.id);

        if (throttled.length)
          yield* sql`UPDATE mobile_push_outbox o
            SET dismiss_at = s.last_dismissal_at + ${throttleSeconds}::integer * interval '1 second'
            FROM mobile_push_subscriptions s WHERE o.id = ANY(${throttled}::uuid[]) AND s.device_id = o.device_id`;

        const leases = leasable.length
          ? yield* sql<{ id: string; lease_until: Date }>`UPDATE mobile_push_outbox
              SET dismiss_at = date_trunc('milliseconds', now() + interval '1 minute'), dismiss_attempts = dismiss_attempts + 1
              WHERE id = ANY(${leasable}::uuid[]) RETURNING id, dismiss_at AS lease_until`
          : [];

        // A read can be followed by "mark unread", a re-registration, or a delivery that never reached the phone.
        const kept = new Set([...sending, ...routed.map((row) => row.id)]);
        const released = marked.map((row) => row.id).filter((id) => !kept.has(id));

        if (released.length)
          yield* sql`UPDATE mobile_push_outbox SET dismiss_at = NULL WHERE id = ANY(${released}::uuid[])`;

        const until = new Map(leases.map((row) => [row.id, row.lease_until]));

        return groupLeases(routed, until);
      }),
    );
  });

/** One silent push carries at most this many receipts; the rest of a phone's rows stay due for the next one. */
function perDevice(rows: readonly RoutedRow[]) {
  const counts = new Map<string, number>();

  return rows.filter(({ device_id }) => {
    const count = counts.get(device_id) ?? 0;
    counts.set(device_id, count + 1);

    return count < maxDismissedReceipts;
  });
}

function groupLeases(rows: readonly RoutedRow[], until: ReadonlyMap<string, Date>) {
  const leases = new Map<string, DismissalLease>();

  for (const row of rows) {
    const lease_until = until.get(row.id);

    if (!lease_until) continue;
    const lease = leases.get(row.device_id);

    if (lease) lease.ids.push(row.id);
    else
      leases.set(row.device_id, {
        ids: [row.id],
        device_id: row.device_id,
        registration_id: row.registration_id,
        platform: row.platform,
        encrypted_token: row.encrypted_token,
        encrypted_preview_key: row.encrypted_preview_key,
        lease_until,
        grant_id: row.grant_id,
        grant_expires_at: row.grant_expires_at,
        encrypted_bearer: row.encrypted_bearer,
        expo_token_hash: row.expo_token_hash,
      });
  }

  return [...leases.values()];
}

/** Earlier dismissals ride along, so a silent push the phone dropped or coalesced is covered by the next one. */
export const recentPushDismissals = (owner: string, lease: DismissalLease, limit: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    if (limit <= 0) return [];

    const rows = yield* sql<{ id: string }>`SELECT id FROM mobile_push_outbox
      WHERE device_id = ${lease.device_id}::uuid AND owner_user_id = ${owner}::uuid
        AND registration_id = ${lease.registration_id}::uuid AND dismissed_at > now() - interval '6 hours'
        AND ticket_id IS NOT NULL AND id <> ALL(${lease.ids}::uuid[])
      ORDER BY dismissed_at DESC LIMIT ${limit}`;

    return rows.map(({ id }) => id);
  });

export type DismissalOutcome = "sent" | "done" | "retry";

export const settlePushDismissal = (owner: string, lease: DismissalLease, outcome: DismissalOutcome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // The lease time is truncated to milliseconds so it survives the round trip through a JS Date.
    const leased = sql`owner_user_id = ${owner}::uuid AND id = ANY(${lease.ids}::uuid[]) AND dismiss_at = ${lease.lease_until}`;

    if (outcome === "retry") {
      yield* sql`UPDATE mobile_push_outbox SET
          dismissed_at = CASE WHEN dismiss_attempts >= ${maxAttempts} THEN now() END,
          dismiss_at = CASE WHEN dismiss_attempts >= ${maxAttempts} THEN NULL ELSE now() + interval '30 seconds' END
        WHERE ${leased}`;

      return;
    }

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE mobile_push_outbox SET dismiss_at = NULL, dismissed_at = now() WHERE ${leased}`;

        if (outcome === "sent")
          yield* sql`UPDATE mobile_push_subscriptions SET last_dismissal_at = now()
            WHERE device_id = ${lease.device_id}::uuid AND registration_id = ${lease.registration_id}::uuid`;
      }),
    );
  });
