import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { CoreRuntime } from "../core/core.ts";
import { queryFamily, queryRpc } from "../diagnostics/query-context.ts";
import type { Versions } from "./versions.ts";

/** Days a session certificate may resume its session (docs/desktop-server-migration.md §5). */
export const CREDENTIAL_DAYS = 30;

/** Minutes a one-time invitation code stays valid. */
export const INVITATION_MINUTES = 10;

/** Wrong codes for one invitation before it is revoked. */
export const INVITATION_ATTEMPTS = 5;

export type SessionRow = {
  id: string;
  owner_user_id: string;
  role: "target" | "source";
  state: string;
  generation: number;
  protocol: number;
  build_version: string;
  schema_version: string;
  created_at: Date;
};

/** Target side: one invited home. */
export type SourceRow = {
  id: string;
  session_id: string;
  owner_user_id: string;
  invitation_expires_at: Date;
  exchanged_at: Date | null;
  source_node_id: string | null;
  source_name: string;
  source_owner_id: string | null;
  source_build: string;
  source_schema: string;
  certificate_pin: string | null;
  credential_expires_at: Date | null;
  confirmed_at: Date | null;
  negotiated_at: Date | null;
  revoked_at: Date | null;
};

/** Source side: the server this home moves to, with the home's encrypted session key. */
export type TargetRow = {
  session_id: string;
  owner_user_id: string;
  source_id: string;
  origins: string[];
  target_fingerprint: string;
  target_node_id: string;
  target_name: string;
  target_owner_id: string | null;
  target_build: string;
  target_schema: string;
  certificate: string;
  certificate_pin: string;
  private_key: Uint8Array;
  credential_expires_at: Date;
  exchanged_at: Date | null;
  confirmed_at: Date | null;
  negotiated_at: Date | null;
  revoked_at: Date | null;
};

export type Exchange = {
  sessionId: string;
  sourceId: string;
  codeHash: string;
  nodeId: string;
  name: string;
  ownerId: string;
  versions: Versions;
  certificate: string;
  pin: string;
};

const OPEN = "state NOT IN ('aborted', 'done')";

/** Durable migration sessions. Every query names the owner, except the two pre-authentication lookups
 * (an invitation and a session certificate), which return the owner they belong to. */
export class MigrationStore {
  constructor(
    readonly runtime: CoreRuntime,
    readonly owner: string,
  ) {}

  query<A extends object>(text: string, params: unknown[] = []) {
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params);
      }).pipe(queryFamily("other"), queryRpc),
    );
  }

  async schemaVersion() {
    const rows = await this.query<{ migration_id: number; name: string }>(
      "SELECT migration_id, name FROM schema_migrations ORDER BY migration_id DESC LIMIT 1",
    );

    return rows[0] ? `${rows[0].migration_id}_${rows[0].name}` : "";
  }

  async openSession(role: SessionRow["role"]) {
    return (
      await this.query<SessionRow>(
        `SELECT * FROM server_migration_sessions WHERE owner_user_id=$1::uuid AND role=$2 AND ${OPEN}`,
        [this.owner, role],
      )
    )[0];
  }

  async session(id: string) {
    return (
      await this.query<SessionRow>(
        `SELECT * FROM server_migration_sessions WHERE owner_user_id=$1::uuid AND id=$2::uuid AND ${OPEN}`,
        [this.owner, id],
      )
    )[0];
  }

  /** An invitation that was never used stops reserving the server once it expires. */
  async closeUnpairedTarget() {
    await this.query(
      `UPDATE server_migration_sessions s SET state='aborted', closed_reason='expired', closed_at=now(), updated_at=now()
      WHERE s.owner_user_id=$1::uuid AND s.role='target' AND s.state='invited' AND NOT EXISTS (
        SELECT 1 FROM server_migration_sources x WHERE x.session_id=s.id AND x.revoked_at IS NULL
          AND x.invitation_expires_at > now())`,
      [this.owner],
    );
  }

  async createSession(role: SessionRow["role"], id: string, state: string, versions: Versions) {
    await this.query(
      `INSERT INTO server_migration_sessions (id, owner_user_id, role, state, protocol, build_version, schema_version)
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
      [id, this.owner, role, state, versions.protocol, versions.build, versions.schema],
    );
  }

  async addSource(sessionId: string, codeHash: string) {
    return (
      await this.query<SourceRow>(
        `INSERT INTO server_migration_sources (id, session_id, owner_user_id, invitation_hash, invitation_expires_at)
        VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, now() + interval '${INVITATION_MINUTES} minutes') RETURNING *`,
        [sessionId, this.owner, codeHash],
      )
    )[0]!;
  }

  sources(sessionId: string) {
    return this.query<SourceRow>(
      "SELECT * FROM server_migration_sources WHERE owner_user_id=$1::uuid AND session_id=$2::uuid ORDER BY created_at",
      [this.owner, sessionId],
    );
  }

  async source(sessionId: string, sourceId: string) {
    return (
      await this.query<SourceRow>(
        "SELECT * FROM server_migration_sources WHERE owner_user_id=$1::uuid AND session_id=$2::uuid AND id=$3::uuid",
        [this.owner, sessionId, sourceId],
      )
    )[0];
  }

  /** Consumes the invitation atomically and pairs the session. Nothing is returned for a wrong,
   * expired, revoked, exhausted or used code; a retry with the same certificate gets the same row. */
  async exchange(e: Exchange): Promise<{ row: SourceRow; replay: boolean } | undefined> {
    const paired = await this.query<SourceRow>(
      `WITH x AS (
        UPDATE server_migration_sources x SET exchanged_at=now(), source_node_id=$4, source_name=$5,
          source_owner_id=$6::uuid, source_build=$7, source_schema=$8, certificate=$9, certificate_pin=$10,
          credential_expires_at=now() + interval '${CREDENTIAL_DAYS} days'
        FROM server_migration_sessions s
        WHERE x.id=$2::uuid AND x.session_id=$1::uuid AND s.id=x.session_id AND s.role='target'
          AND s.state IN ('invited', 'paired') AND x.exchanged_at IS NULL AND x.revoked_at IS NULL
          AND x.invitation_expires_at > now() AND x.invitation_attempts < ${INVITATION_ATTEMPTS}
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

    if (paired[0]) return { row: paired[0], replay: false };

    const replay = await this.query<SourceRow>(
      `SELECT x.* FROM server_migration_sources x JOIN server_migration_sessions s ON s.id=x.session_id
      WHERE x.id=$2::uuid AND x.session_id=$1::uuid AND x.invitation_hash=$3 AND x.certificate_pin=$4
        AND x.revoked_at IS NULL AND s.${OPEN}`,
      [e.sessionId, e.sourceId, e.codeHash, e.pin],
    );

    if (replay[0]) return { row: replay[0], replay: true };

    await this.query(
      `UPDATE server_migration_sources SET invitation_attempts=invitation_attempts+1,
        revoked_at=CASE WHEN invitation_attempts + 1 >= ${INVITATION_ATTEMPTS} THEN now() ELSE revoked_at END
      WHERE id=$1::uuid AND exchanged_at IS NULL AND revoked_at IS NULL`,
      [e.sourceId],
    );

    return undefined;
  }

  /** The session certificate presented over mutual TLS, if it may still use its session. */
  async credential(pin: string) {
    return (
      await this.query<SourceRow & { generation: number; state: string }>(
        `SELECT x.*, s.generation, s.state FROM server_migration_sources x
        JOIN server_migration_sessions s ON s.id=x.session_id
        WHERE x.certificate_pin=$1 AND x.revoked_at IS NULL AND x.credential_expires_at > now() AND s.${OPEN}`,
        [pin],
      )
    )[0];
  }

  async markSource(sessionId: string, sourceId: string, column: "confirmed_at" | "negotiated_at" | "revoked_at") {
    const rows = await this.query<SourceRow>(
      `UPDATE server_migration_sources SET ${column}=COALESCE(${column}, now())
      WHERE owner_user_id=$1::uuid AND session_id=$2::uuid AND id=$3::uuid AND revoked_at IS NULL RETURNING *`,
      [this.owner, sessionId, sourceId],
    );

    return rows[0];
  }

  async close(sessionId: string, reason: string) {
    await this.query(
      `WITH s AS (
        UPDATE server_migration_sessions SET state='aborted', closed_reason=$3, closed_at=now(), updated_at=now()
        WHERE owner_user_id=$1::uuid AND id=$2::uuid AND ${OPEN} RETURNING id
      ), x AS (
        UPDATE server_migration_sources SET revoked_at=now()
        WHERE session_id IN (SELECT id FROM s) AND revoked_at IS NULL
      ) UPDATE server_migration_targets SET revoked_at=now()
        WHERE session_id IN (SELECT id FROM s) AND revoked_at IS NULL`,
      [this.owner, sessionId, reason],
    );
  }

  /** Source side: the session and its key are stored before the exchange, so a lost reply can be retried. */
  async createTarget(session: { id: string; versions: Versions }, target: Omit<TargetRow, "owner_user_id">) {
    await this.query(
      `WITH s AS (
        INSERT INTO server_migration_sessions (id, owner_user_id, role, state, protocol, build_version, schema_version)
        VALUES ($1::uuid, $2::uuid, 'source', 'pairing', $3, $4, $5) RETURNING id
      ) INSERT INTO server_migration_targets (session_id, owner_user_id, source_id, origins, target_fingerprint,
        certificate, certificate_pin, private_key, key_id, credential_expires_at)
      SELECT s.id, $2::uuid, $6::uuid, $7::text[], $8, $9, $10, $11, 'env-v1', $12 FROM s`,
      [
        session.id,
        this.owner,
        session.versions.protocol,
        session.versions.build,
        session.versions.schema,
        target.source_id,
        target.origins,
        target.target_fingerprint,
        target.certificate,
        target.certificate_pin,
        target.private_key,
        target.credential_expires_at,
      ],
    );
  }

  async target(sessionId: string) {
    return (
      await this.query<TargetRow>(
        "SELECT * FROM server_migration_targets WHERE owner_user_id=$1::uuid AND session_id=$2::uuid",
        [this.owner, sessionId],
      )
    )[0];
  }

  async pairedTarget(sessionId: string, reply: Pick<TargetRow, "target_node_id" | "target_name" | "target_owner_id">) {
    await this.query(
      `WITH t AS (
        UPDATE server_migration_targets SET exchanged_at=COALESCE(exchanged_at, now()), target_node_id=$3,
          target_name=$4, target_owner_id=$5::uuid
        WHERE owner_user_id=$1::uuid AND session_id=$2::uuid AND revoked_at IS NULL RETURNING session_id
      ) UPDATE server_migration_sessions SET state='paired', updated_at=now()
        WHERE id IN (SELECT session_id FROM t) AND state='pairing'`,
      [this.owner, sessionId, reply.target_node_id, reply.target_name, reply.target_owner_id],
    );
  }

  async markTarget(sessionId: string, column: "confirmed_at" | "negotiated_at", versions?: Versions) {
    await this.query(
      `UPDATE server_migration_targets SET ${column}=COALESCE(${column}, now()),
        target_build=COALESCE($3, target_build), target_schema=COALESCE($4, target_schema)
      WHERE owner_user_id=$1::uuid AND session_id=$2::uuid AND revoked_at IS NULL`,
      [this.owner, sessionId, versions?.build ?? null, versions?.schema ?? null],
    );
  }

  /** Audit (§10): actor, session, phase and classified results. Never codes, keys, addresses or data. */
  async audit(action: string, sessionId: string, details: Record<string, string | number | boolean>) {
    await this.query(
      `INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details)
      VALUES (gen_random_uuid(), $1::uuid, $2, 'server_migration', $3::uuid, $4::jsonb)`,
      [this.owner, `server_migration.${action}`, sessionId, JSON.stringify(details)],
    );
  }

  /** Tables with rows, except the given bootstrap ones (deny by default). */
  async occupied(allowed: readonly string[]) {
    const rows = await this.query<{ name: string }>("SELECT server_migration_occupied($1::text[]) AS name", [
      [...allowed],
    ]);

    return rows.map((row) => row.name);
  }
}
