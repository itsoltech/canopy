import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ownerModule } from "../store/module-access.ts";

import type { PushPlatform } from "./subscriptions.ts";

export type PushEvent = "turn" | "interaction" | "message" | "approval";

export type PushJob = {
  id: string;
  destination_id: string;
  registration_id: string;
  device_id: string;
  event_kind: PushEvent;
  event_id: string;
  attempts: number;
  ticket_id: string | null;
  platform: PushPlatform;
  encrypted_token: Uint8Array;
  encrypted_preview_key: Uint8Array;
};

export const registered = (sql: SqlClient.SqlClient) => sql`
  JOIN mobile_devices d ON d.id = o.device_id AND d.owner_user_id = o.owner_user_id
    AND d.revoked_at IS NULL AND d.client_kind = 'mobile' AND d.platform IN ('ios', 'android')
  JOIN mobile_push_subscriptions s ON s.device_id = d.id AND s.registration_id = o.registration_id AND s.expires_at > now()`;

const reachable = (sql: SqlClient.SqlClient) => sql`(
  (o.event_kind IN ('turn', 'interaction') AND ${ownerModule(sql, sql`o.owner_user_id`, "threads")}
    AND EXISTS (SELECT 1 FROM threads t WHERE t.id = o.destination_id AND t.owner_user_id = o.owner_user_id
      AND t.archived_at IS NULL AND t.deleted_at IS NULL AND t.moved_to IS NULL AND t.origin <> 'agent'))
  OR
  (o.event_kind IN ('message', 'approval') AND ${ownerModule(sql, sql`o.owner_user_id`, "bots")}
    AND EXISTS (SELECT 1 FROM bots b WHERE b.id = o.destination_id AND b.owner_user_id = o.owner_user_id
      AND b.archived_at IS NULL AND b.deleted_at IS NULL AND b.moved_to IS NULL))
)`;

const deliverable = (sql: SqlClient.SqlClient) => sql`${reachable(sql)} AND (
  o.event_kind NOT IN ('turn', 'interaction') OR NOT mobile_push_thread_muted(o.destination_id, o.owner_user_id)
)`;

export const resolveMobilePush = (owner: string, device: string, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const rows = yield* sql<Pick<PushJob, "destination_id" | "event_kind">>`
      SELECT o.destination_id, o.event_kind FROM mobile_push_outbox o ${registered(sql)}
      WHERE o.id = ${id}::uuid AND o.owner_user_id = ${owner}::uuid AND o.device_id = ${device}::uuid
        AND o.attempts > 0 AND o.created_at > now() - interval '1 day' AND ${reachable(sql)}`;

    return rows[0];
  });

/** The read, answer or expiry that makes a delivered push of row `o` stale. */
export const dismissibleEvent = (sql: SqlClient.SqlClient) => sql`(
  (o.event_kind = 'turn' AND EXISTS (
    SELECT 1 FROM turns u JOIN thread_reads r ON r.thread_id = u.thread_id AND r.user_id = o.owner_user_id
    WHERE u.id = o.event_id AND u.thread_id = o.destination_id AND NOT r.marked_unread
      AND (u.last_seq <= r.seen_seq OR (u.last_seq IS NULL AND u.completed_at <= r.seen_at))
  ))
  OR (o.event_kind = 'interaction' AND EXISTS (
    SELECT 1 FROM interaction_requests i WHERE i.id = o.event_id AND i.thread_id = o.destination_id
      AND (i.status <> 'pending' OR i.expires_at <= now())
  ))
  OR (o.event_kind = 'message' AND EXISTS (
    SELECT 1 FROM bot_messages m JOIN bots b ON b.id = m.bot_id AND b.owner_user_id = o.owner_user_id
    WHERE m.id = o.event_id AND m.bot_id = o.destination_id AND m.seq <= b.last_read_seq
  ))
  OR (o.event_kind = 'approval' AND EXISTS (
    SELECT 1 FROM bot_approvals a JOIN bots b ON b.id = a.bot_id AND b.owner_user_id = o.owner_user_id
    WHERE a.id = o.event_id AND a.bot_id = o.destination_id AND (a.status <> 'pending' OR a.expires_at <= now())
  ))
)`;

export const dismissibleMobilePush = (owner: string, device: string, ids: string[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    return yield* sql<{ id: string }>`
      SELECT o.id FROM mobile_push_outbox o ${registered(sql)}
      WHERE o.id = ANY(${ids}::uuid[]) AND o.owner_user_id = ${owner}::uuid AND o.device_id = ${device}::uuid
        AND o.attempts > 0 AND o.created_at > now() - interval '1 day' AND ${dismissibleEvent(sql)}`;
  });

export const livePushJob = (sql: SqlClient.SqlClient, owner: string, job: PushJob) => sql`
  (SELECT o.destination_id, o.event_id, o.owner_user_id FROM mobile_push_outbox o ${registered(sql)}
    WHERE o.id = ${job.id}::uuid AND o.owner_user_id = ${owner}::uuid AND o.attempts = ${job.attempts}
      AND o.created_at > now() - interval '5 minutes' AND ${deliverable(sql)}) o`;

export const managedGrant = (sql: SqlClient.SqlClient, origin: string) => sql`
  JOIN mobile_push_grants g ON g.device_id = d.id AND g.id = s.managed_grant_id AND g.platform = d.platform
    AND g.origin = ${origin} AND g.expires_at > clock_timestamp()`;

export const claimPushJobs = (owner: string, managedOrigin: string | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Lease only the outbox rows. A concurrent consumer skips them, and a crash releases them after one minute.
    return yield* sql<PushJob>`WITH due AS (
      SELECT o.id, d.platform, s.encrypted_token, s.encrypted_preview_key
      FROM mobile_push_outbox o ${registered(sql)}
        ${managedOrigin ? managedGrant(sql, managedOrigin) : sql``}
      WHERE o.owner_user_id = ${owner}::uuid AND o.next_attempt_at <= now()
        ${managedOrigin ? sql`` : sql`AND s.managed_grant_id IS NULL`}
        AND ((o.ticket_id IS NOT NULL AND o.created_at > now() - interval '1 day')
          OR (o.ticket_id IS NULL AND o.attempts < 5 AND o.created_at > now() - interval '5 minutes' AND ${deliverable(sql)}))
      ORDER BY o.next_attempt_at LIMIT 4 FOR UPDATE OF o SKIP LOCKED
    )
    UPDATE mobile_push_outbox o SET attempts = o.attempts + 1, next_attempt_at = now() + interval '1 minute'
    FROM due WHERE o.id = due.id RETURNING o.*, due.platform, due.encrypted_token, due.encrypted_preview_key`;
  });

type DeliveryGrant = {
  grant_id: string;
  grant_expires_at: Date;
  encrypted_bearer: Uint8Array;
  expo_token_hash: Uint8Array;
};

export const livePushDelivery = (owner: string, job: PushJob, managedOrigin: string | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const [live] = yield* sql<{ id: string } & Partial<DeliveryGrant>>`
      SELECT o.id ${
        managedOrigin
          ? sql`, g.id AS grant_id, g.expires_at AS grant_expires_at,
        g.encrypted_bearer, g.expo_token_hash`
          : sql``
      }
      FROM mobile_push_outbox o ${registered(sql)}
        ${managedOrigin ? managedGrant(sql, managedOrigin) : sql``}
      WHERE o.id = ${job.id}::uuid AND o.owner_user_id = ${owner}::uuid AND o.attempts = ${job.attempts}
        AND o.next_attempt_at IS NOT NULL ${managedOrigin ? sql`` : sql`AND s.managed_grant_id IS NULL`}
        AND ((o.ticket_id IS NOT NULL AND o.created_at > now() - interval '1 day')
          OR (o.ticket_id IS NULL AND o.created_at > now() - interval '5 minutes' AND ${deliverable(sql)}))`;

    return live;
  });

export const settlePushJob = (
  owner: string,
  job: PushJob,
  result: { outcome: "accepted"; ticketId: string } | { outcome: "done" | "retry" | "unregistered" },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const retryDelay = { accepted: 900, retry: job.ticket_id ? 300 : 30, done: null, unregistered: null };
    const wait = retryDelay[result.outcome];
    const ticket = result.outcome === "accepted" ? result.ticketId : job.ticket_id;

    yield* sql.withTransaction(
      Effect.gen(function* () {
        const settled = yield* sql`UPDATE mobile_push_outbox o
          SET next_attempt_at = now() + ${wait}::integer * interval '1 second', ticket_id = ${ticket}
          WHERE o.id = ${job.id}::uuid AND o.owner_user_id = ${owner}::uuid AND o.attempts = ${job.attempts}
            AND o.next_attempt_at IS NOT NULL AND EXISTS (SELECT 1 FROM mobile_push_subscriptions s
              WHERE s.device_id = o.device_id AND s.registration_id = o.registration_id)
          RETURNING id`;

        // A stale provider receipt cannot disable a replacement token/key.
        if (settled.length && result.outcome === "unregistered")
          yield* sql`DELETE FROM mobile_push_subscriptions s USING mobile_devices d
            WHERE s.device_id = d.id AND d.id = ${job.device_id}::uuid AND d.owner_user_id = ${owner}::uuid
              AND s.registration_id = ${job.registration_id}::uuid`;
      }),
    );
  });

export const prunePush = (sql: SqlClient.SqlClient, owner: string, batch: number) =>
  Effect.gen(function* () {
    const outbox = yield* sql`DELETE FROM mobile_push_outbox WHERE id IN (
      SELECT id FROM mobile_push_outbox WHERE owner_user_id = ${owner}::uuid AND created_at <= now() - interval '1 day'
      ORDER BY created_at LIMIT ${batch} FOR UPDATE SKIP LOCKED) RETURNING id`;

    const enrollments = yield* sql`DELETE FROM mobile_push_enrollments WHERE device_id IN (
      SELECT e.device_id FROM mobile_push_enrollments e JOIN mobile_devices d ON d.id = e.device_id
      WHERE d.owner_user_id = ${owner}::uuid AND e.expires_at <= now()
      LIMIT ${batch} FOR UPDATE OF e SKIP LOCKED) RETURNING device_id`;

    const grants = yield* sql`DELETE FROM mobile_push_grants WHERE device_id IN (
      SELECT g.device_id FROM mobile_push_grants g JOIN mobile_devices d ON d.id = g.device_id
      WHERE d.owner_user_id = ${owner}::uuid AND g.expires_at <= now() - interval '90 days'
      LIMIT ${batch} FOR UPDATE OF g SKIP LOCKED) RETURNING device_id`;

    const subscriptions = yield* sql`DELETE FROM mobile_push_subscriptions WHERE device_id IN (
      SELECT s.device_id FROM mobile_push_subscriptions s JOIN mobile_devices d ON d.id = s.device_id
      WHERE d.owner_user_id = ${owner}::uuid AND (s.expires_at <= now() OR d.revoked_at IS NOT NULL)
      LIMIT ${batch} FOR UPDATE OF s SKIP LOCKED) RETURNING device_id`;

    const revocations = yield* sql`DELETE FROM mobile_push_revocations WHERE id IN (
      SELECT id FROM mobile_push_revocations WHERE owner_user_id = ${owner}::uuid AND expires_at <= now()
      ORDER BY expires_at LIMIT ${batch} FOR UPDATE SKIP LOCKED) RETURNING id`;

    return outbox.length + subscriptions.length + enrollments.length + grants.length + revocations.length;
  });
