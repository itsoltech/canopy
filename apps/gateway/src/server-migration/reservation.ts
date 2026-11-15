import { Effect } from "effect";
import { CREDENTIAL_DAYS, INVITATION_ATTEMPTS, INVITATION_MINUTES, OPEN, Refused } from "./store.ts";
import type { Exchange, MigrationStore, SessionRow, SourceRow, Sql } from "./store.ts";
import type { Versions } from "./versions.ts";

/** Waits for writers in flight (they hold the shared lock until commit), then blocks new ones until this
 * transaction ends. The row lock also conflicts with writers outside READ COMMITTED (0147). */
const lock = (sql: Sql) =>
  Effect.gen(function* () {
    yield* sql.unsafe("SELECT pg_advisory_xact_lock(server_migration_lock_key())");

    return yield* sql.unsafe<{ session_id: string | null; expires_at: Date | null; active: boolean }>(
      `SELECT session_id, expires_at, session_id IS NOT NULL AND (expires_at IS NULL OR expires_at > clock_timestamp())
        AS active FROM server_migration_reservation WHERE singleton FOR UPDATE`,
    );
  });

/** A new statement after the lock: it sees every writer that committed while the lock waited. */
const requireEmpty = (sql: Sql, owner: string) =>
  Effect.gen(function* () {
    const occupied = yield* sql.unsafe<{ name: string }>("SELECT server_migration_occupied($1::uuid) AS name", [owner]);

    if (occupied.length) return yield* new Refused({ reason: "occupied" });
  });

/** Reserves the empty server for the owner's session and adds one invitation, atomically with the check. */
export function reserveInvitation(store: MigrationStore, versions: Versions, codeHash: string, sessionId: string) {
  const { owner } = store;

  return store.transaction((sql) =>
    Effect.gen(function* () {
      const reservation = (yield* lock(sql))[0]!;
      // A session that never paired stops reserving the server once its invitations expire.
      yield* sql.unsafe(
        `UPDATE server_migration_sessions s SET state='aborted', closed_reason='expired', closed_at=now(),
          updated_at=now()
        WHERE s.owner_user_id=$1::uuid AND s.role='target' AND s.state='invited' AND NOT EXISTS (
          SELECT 1 FROM server_migration_sources x WHERE x.session_id=s.id AND x.revoked_at IS NULL
            AND x.invitation_expires_at > clock_timestamp())`,
        [owner],
      );

      let session = (yield* sql.unsafe<SessionRow>(
        `SELECT * FROM server_migration_sessions WHERE owner_user_id=$1::uuid AND role='target' AND ${OPEN}`,
        [owner],
      ))[0];

      // Another owner's live reservation is data this owner may not import over.
      if (reservation.active && reservation.session_id !== session?.id)
        return yield* new Refused({ reason: "occupied" });

      if (session && session.state !== "invited" && session.state !== "paired")
        return yield* new Refused({ reason: "copying" });
      yield* requireEmpty(sql, owner);

      if (!session)
        session = (yield* sql.unsafe<SessionRow>(
          `INSERT INTO server_migration_sessions (id, owner_user_id, role, state, protocol, build_version,
            schema_version) VALUES ($1::uuid, $2::uuid, 'target', 'invited', $3, $4, $5) RETURNING *`,
          [sessionId, owner, versions.protocol, versions.build, versions.schema],
        ))[0]!;

      const source = (yield* sql.unsafe<SourceRow>(
        `INSERT INTO server_migration_sources (id, session_id, owner_user_id, invitation_hash, invitation_expires_at)
        VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, clock_timestamp() + interval '${INVITATION_MINUTES} minutes')
        RETURNING *`,
        [session.id, owner, codeHash],
      ))[0]!;

      // Paired: until the session ends. Invited only: until the last invitation expires.
      yield* sql.unsafe(
        `UPDATE server_migration_reservation SET session_id=$1::uuid,
          expires_at=CASE WHEN $2 = 'paired' THEN NULL ELSE $3::timestamptz END WHERE singleton`,
        [session.id, session.state, source.invitation_expires_at],
      );

      return { session, source };
    }),
  );
}

/** Consumes the invitation and makes the reservation last until the session ends, atomically with a new
 * emptiness check. Undefined: wrong, expired, revoked, exhausted or used code. */
export async function exchangeInvitation(store: MigrationStore, e: Exchange) {
  const result = await store.transaction((sql) =>
    Effect.gen(function* () {
      const reservation = (yield* lock(sql))[0]!;

      const paired = yield* sql.unsafe<SourceRow>(
        `WITH x AS (
          UPDATE server_migration_sources x SET exchanged_at=now(), source_node_id=$4, source_name=$5,
            source_owner_id=$6::uuid, source_build=$7, source_schema=$8, certificate=$9, certificate_pin=$10,
            credential_expires_at=now() + interval '${CREDENTIAL_DAYS} days'
          FROM server_migration_sessions s
          WHERE x.id=$2::uuid AND x.session_id=$1::uuid AND s.id=x.session_id AND s.role='target'
            AND s.state IN ('invited', 'paired') AND x.exchanged_at IS NULL AND x.revoked_at IS NULL
            AND x.invitation_expires_at > clock_timestamp() AND x.invitation_attempts < ${INVITATION_ATTEMPTS}
            AND x.invitation_hash=$3
          RETURNING x.*
        ), s AS (
          UPDATE server_migration_sessions SET state='paired', updated_at=now()
          WHERE id IN (SELECT session_id FROM x) AND state='invited'
        ) SELECT * FROM x`,
        [
          e.sessionId,
          e.sourceId,
          e.codeHash,
          e.nodeId,
          e.name,
          e.ownerId,
          e.versions.build,
          e.versions.schema,
          e.certificate,
          e.pin,
        ],
      );

      const row = paired[0];

      if (!row) return undefined;

      if (!reservation.active || reservation.session_id !== row.session_id)
        return yield* new Refused({ reason: "lapsed" });
      yield* requireEmpty(sql, row.owner_user_id);
      yield* sql.unsafe("UPDATE server_migration_reservation SET expires_at=NULL WHERE singleton");

      return { row, replay: false };
    }),
  );

  if (result instanceof Refused || result) return result;

  const replay = await store.query<SourceRow>(
    `SELECT x.* FROM server_migration_sources x JOIN server_migration_sessions s ON s.id=x.session_id
    WHERE x.id=$2::uuid AND x.session_id=$1::uuid AND x.invitation_hash=$3 AND x.certificate_pin=$4
      AND x.revoked_at IS NULL AND s.${OPEN}`,
    [e.sessionId, e.sourceId, e.codeHash, e.pin],
  );

  if (replay[0]) return { row: replay[0], replay: true };

  await store.query(
    `UPDATE server_migration_sources SET invitation_attempts=invitation_attempts+1,
      revoked_at=CASE WHEN invitation_attempts + 1 >= ${INVITATION_ATTEMPTS} THEN now() ELSE revoked_at END
    WHERE id=$1::uuid AND exchanged_at IS NULL AND revoked_at IS NULL`,
    [e.sourceId],
  );

  return undefined;
}

/** Ends the owner's session on this gateway, revokes its credentials and lifts its reservation. */
export function closeSession(store: MigrationStore, sessionId: string, reason: string) {
  return store.transaction((sql) =>
    Effect.gen(function* () {
      yield* lock(sql);

      const closed = yield* sql.unsafe<{ id: string }>(
        `UPDATE server_migration_sessions SET state='aborted', closed_reason=$3, closed_at=now(), updated_at=now()
        WHERE owner_user_id=$1::uuid AND id=$2::uuid AND ${OPEN} RETURNING id`,
        [store.owner, sessionId, reason],
      );

      if (!closed.length) return false;
      yield* sql.unsafe(
        "UPDATE server_migration_sources SET revoked_at=now() WHERE session_id=$1::uuid AND revoked_at IS NULL",
        [sessionId],
      );
      yield* sql.unsafe(
        "UPDATE server_migration_targets SET revoked_at=now() WHERE session_id=$1::uuid AND revoked_at IS NULL",
        [sessionId],
      );
      yield* sql.unsafe(
        "UPDATE server_migration_reservation SET session_id=NULL, expires_at=NULL WHERE singleton AND session_id=$1::uuid",
        [sessionId],
      );

      return true;
    }),
  );
}
