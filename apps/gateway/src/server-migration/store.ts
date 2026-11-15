import { Data, Effect } from "effect";
import { SqlClient, type SqlError } from "effect/sql";
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
  /** Encrypted: the server's private addresses (secrets.ts envelope). */
  origins: Uint8Array;
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

export const OPEN = "state NOT IN ('aborted', 'done')";

/** A reservation step refused inside its transaction, which is rolled back. */
export class Refused extends Data.TaggedError("ServerMigrationRefused")<{
  reason: "occupied" | "copying" | "lapsed";
}> {}

export type Sql = SqlClient.SqlClient;

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

  /** One READ COMMITTED transaction: each statement sees what committed before it started. A refusal rolls
   * it back and is returned, not thrown. */
  transaction<A>(body: (sql: Sql) => Effect.Effect<A, SqlError.SqlError | Refused>): Promise<A | Refused> {
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(body(sql));
      }).pipe(
        Effect.catchTag("ServerMigrationRefused", (refused) => Effect.succeed(refused)),
        queryFamily("other"),
        queryRpc,
      ),
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

  sources(sessionId: string) {
    return this.query<SourceRow>(
      "SELECT * FROM server_migration_sources WHERE owner_user_id=$1::uuid AND session_id=$2::uuid ORDER BY created_at, id",
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

  /** Audit (§10): actor, session, phase and classified results. Never codes, keys, addresses or data.
   * clock_timestamp() orders the records of one transaction; ties are broken by id. */
  async audit(action: string, sessionId: string, details: Record<string, string | number | boolean>) {
    await this.query(
      `INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id, details, created_at)
      VALUES (gen_random_uuid(), $1::uuid, $2, 'server_migration', $3::uuid, $4::jsonb, clock_timestamp())`,
      [this.owner, `server_migration.${action}`, sessionId, JSON.stringify(details)],
    );
  }

  /** Tables that make this server non-empty for its owner (0147 server_migration_occupied). */
  async occupied() {
    const rows = await this.query<{ name: string }>("SELECT server_migration_occupied($1::uuid) AS name", [this.owner]);

    return rows.map((row) => row.name);
  }
}
