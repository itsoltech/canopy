import { Effect } from "effect";
import { OPEN, Refused, type MigrationStore, type SessionRow, type TargetRow } from "./store.ts";
import type { Versions } from "./versions.ts";

/** One pairing attempt: the invitation it answers and the key it created. Persisted before the exchange. */
export type Attempt = Pick<
  TargetRow,
  | "source_id"
  | "origins"
  | "target_fingerprint"
  | "certificate"
  | "certificate_pin"
  | "private_key"
  | "credential_expires_at"
>;

export type Prepared = { kind: "retry" | "replaced" | "created"; target: TargetRow };

/** The desktop side's rows (server_migration_targets): the server it moves to and its own session key. */
export class SourceStore {
  constructor(readonly store: MigrationStore) {}

  async target(sessionId: string) {
    return (
      await this.store.query<TargetRow>(
        "SELECT * FROM server_migration_targets WHERE owner_user_id=$1::uuid AND session_id=$2::uuid",
        [this.store.owner, sessionId],
      )
    )[0];
  }

  /** Atomically binds this invitation to an attempt (docs/desktop-server-migration.md §5):
   * - the same invitation again (a lost reply): the stored key and attempt, unchanged;
   * - another invitation while nothing was exchanged: the old attempt is replaced, with a new key, and the
   *   session pins this build's versions (an update between attempts is no downgrade: nothing was paired);
   * - an exchanged session: never replaced; the owner cancels it first.
   * `fresh` creates the key only when one is needed. */
  async prepare(
    invite: { sessionId: string; sourceId: string; fingerprint: string },
    versions: Versions,
    fresh: () => Promise<Attempt>,
  ): Promise<Prepared | "busy" | "mismatch"> {
    const { owner } = this.store;
    const open = await this.store.openSession("source");
    const current = open && (await this.target(open.id));

    if (open && (open.state !== "pairing" || !current || current.exchanged_at)) return "busy";

    if (current && open.id === invite.sessionId && current.source_id === invite.sourceId) {
      if (current.target_fingerprint !== invite.fingerprint) return "mismatch";
      await this.store.query(
        `UPDATE server_migration_sessions SET protocol=$3, build_version=$4, schema_version=$5, updated_at=now()
        WHERE owner_user_id=$1::uuid AND id=$2::uuid AND state='pairing'`,
        [owner, open.id, versions.protocol, versions.build, versions.schema],
      );

      return { kind: "retry", target: current };
    }

    const attempt = await fresh();

    const result = await this.store.transaction((sql) =>
      Effect.gen(function* () {
        const session = (yield* sql.unsafe<SessionRow>(
          `SELECT * FROM server_migration_sessions WHERE owner_user_id=$1::uuid AND role='source' AND ${OPEN} FOR UPDATE`,
          [owner],
        ))[0];

        if (session && session.state !== "pairing") return "busy" as const;

        // A different server session: the unexchanged attempt is abandoned.
        if (session && session.id !== invite.sessionId) {
          yield* sql.unsafe(
            `UPDATE server_migration_sessions SET state='aborted', closed_reason='replaced', closed_at=now(),
              updated_at=now() WHERE id=$1::uuid`,
            [session.id],
          );
          yield* sql.unsafe("UPDATE server_migration_targets SET revoked_at=now() WHERE session_id=$1::uuid", [
            session.id,
          ]);
        }

        if (session?.id === invite.sessionId)
          yield* sql.unsafe(
            `UPDATE server_migration_sessions SET protocol=$2, build_version=$3, schema_version=$4, updated_at=now()
            WHERE id=$1::uuid AND state='pairing'`,
            [session.id, versions.protocol, versions.build, versions.schema],
          );
        else
          yield* sql.unsafe(
            `INSERT INTO server_migration_sessions (id, owner_user_id, role, state, protocol, build_version,
              schema_version) VALUES ($1::uuid, $2::uuid, 'source', 'pairing', $3, $4, $5)`,
            [invite.sessionId, owner, versions.protocol, versions.build, versions.schema],
          );

        const rows = yield* sql.unsafe<TargetRow>(
          `INSERT INTO server_migration_targets (session_id, owner_user_id, source_id, origins, target_fingerprint,
            certificate, certificate_pin, private_key, key_id, credential_expires_at)
          VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, 'env-v1', $9)
          ON CONFLICT (session_id) DO UPDATE SET source_id=EXCLUDED.source_id, origins=EXCLUDED.origins,
            target_fingerprint=EXCLUDED.target_fingerprint, certificate=EXCLUDED.certificate,
            certificate_pin=EXCLUDED.certificate_pin, private_key=EXCLUDED.private_key,
            credential_expires_at=EXCLUDED.credential_expires_at, created_at=now()
            WHERE server_migration_targets.exchanged_at IS NULL
          RETURNING *`,
          [
            invite.sessionId,
            owner,
            attempt.source_id,
            attempt.origins,
            attempt.target_fingerprint,
            attempt.certificate,
            attempt.certificate_pin,
            attempt.private_key,
            attempt.credential_expires_at,
          ],
        );

        if (!rows[0]) return "busy" as const;

        return {
          kind: session?.id === invite.sessionId ? ("replaced" as const) : ("created" as const),
          target: rows[0],
        };
      }),
    );

    if (result === "busy" || result instanceof Refused) return "busy";

    return result;
  }

  async paired(sessionId: string, reply: Pick<TargetRow, "target_node_id" | "target_name" | "target_owner_id">) {
    await this.store.query(
      `WITH t AS (
        UPDATE server_migration_targets SET exchanged_at=COALESCE(exchanged_at, now()), target_node_id=$3,
          target_name=$4, target_owner_id=$5::uuid
        WHERE owner_user_id=$1::uuid AND session_id=$2::uuid AND revoked_at IS NULL RETURNING session_id
      ) UPDATE server_migration_sessions SET state='paired', updated_at=now()
        WHERE id IN (SELECT session_id FROM t) AND state='pairing'`,
      [this.store.owner, sessionId, reply.target_node_id, reply.target_name, reply.target_owner_id],
    );
  }

  async mark(sessionId: string, column: "confirmed_at" | "negotiated_at", versions?: Versions) {
    await this.store.query(
      `UPDATE server_migration_targets SET ${column}=COALESCE(${column}, now()),
        target_build=COALESCE($3, target_build), target_schema=COALESCE($4, target_schema)
      WHERE owner_user_id=$1::uuid AND session_id=$2::uuid AND revoked_at IS NULL`,
      [this.store.owner, sessionId, versions?.build ?? null, versions?.schema ?? null],
    );
  }
}
