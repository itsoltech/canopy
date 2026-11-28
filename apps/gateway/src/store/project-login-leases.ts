import type { JsonValue } from "@bufbuild/protobuf";
import { loginAllowsOrigin, type ProjectLoginMetadata } from "@canopy/domain/project-logins";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { isUuid } from "./agent-bus-queries.ts";
import type { CallSource } from "./agent-bus.ts";
import { Invalid, NotFound } from "./errors.ts";
import { lockedOwnerModule, moduleDisabledMessage } from "./module-access.ts";
import { leaseForCall, lockWorker, type ProjectSecretWorker } from "./project-secret-leases.ts";
import { loginMetadata } from "./project-logins.ts";

export type LoginAccess = "browser" | "file";

/** The owner's answer for one login, kind of access and turn. A login that does not ask is allowed at once. */
export interface LoginDecision {
  id: string;
  thread_id: string;
  name: string;
  access: LoginAccess;
  origin: string | null;
  status: string;
}

export type LoginLeaseOpened = { lease: string } | { decision: LoginDecision };

const DECISION_COLUMNS = "id,thread_id,name,access,origin,status";

/** Lock the thread's running turn and its project login, as a lease for `worker` requires. */
export function lockedLogin(
  sql: SqlClient.SqlClient,
  owner: string,
  worker: ProjectSecretWorker,
  source: CallSource,
  name: string,
) {
  return sql<{ project_id: string; login: JsonValue }>`SELECT p.id AS project_id,s.login FROM threads t
      JOIN turns u ON u.thread_id=t.id AND u.id=${source.turnId}::uuid
      JOIN projects p ON p.id=t.project_id
      JOIN project_logins s ON s.project_id=p.id AND s.name=${name}
      WHERE t.id=${source.threadId}::uuid AND t.worker_id=${worker.workerId}::uuid
        AND t.owner_user_id=${owner}::uuid AND p.owner_user_id=t.owner_user_id AND p.kind='project'
        AND t.runtime='worker' AND t.deleted_at IS NULL AND t.archived_at IS NULL
        AND p.archived_at IS NULL AND t.moved_to IS NULL AND t.rewind_pending_id IS NULL
        AND u.status='running' AND u.rewind_id IS NULL FOR SHARE OF t,u,p,s`.pipe(
    Effect.map(([row]) => row && { projectId: row.project_id, metadata: loginMetadata(row.login) }),
  );
}

/** One decision per turn, login and access: concurrent requests share the first one. */
export function decideLogin(
  sql: SqlClient.SqlClient,
  owner: string,
  source: CallSource,
  login: { projectId: string; name: string; metadata: ProjectLoginMetadata },
  access: LoginAccess,
  origin: string | null,
) {
  const status = login.metadata.ask_each_time ? "pending" : "allowed";

  return Effect.gen(function* () {
    yield* sql`INSERT INTO project_login_decisions(id,owner_user_id,project_id,thread_id,turn_id,name,access,origin,status)
      VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,${login.projectId}::uuid,${source.threadId}::uuid,
        ${source.turnId}::uuid,${login.name},${access},${origin},${status})
      ON CONFLICT(turn_id,name,access) DO NOTHING`;

    const [decision] = yield* sql<LoginDecision>`SELECT ${sql.literal(DECISION_COLUMNS)}
      FROM project_login_decisions WHERE turn_id=${source.turnId}::uuid AND name=${login.name} AND access=${access}
      FOR SHARE`;

    return decision!;
  });
}

function requireRunningTurn(sql: SqlClient.SqlClient, owner: string, source: CallSource) {
  return Effect.gen(function* () {
    if (!isUuid(source.callId) || !isUuid(source.turnId))
      return yield* Effect.fail(new Invalid("A project login requires a running turn."));

    if (!(yield* lockedOwnerModule(sql, owner, "threads")))
      return yield* Effect.fail(new Invalid(moduleDisabledMessage("threads")));
  });
}

/**
 * Agent Browser asks for one login on one website for the current turn. The value stays in worker memory.
 * A login that asks each time first needs the owner's answer for this turn.
 */
function openLoginLease(
  sql: SqlClient.SqlClient,
  owner: string,
  worker: ProjectSecretWorker,
  source: CallSource,
  name: string,
  origin: string,
  authorization: string,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      yield* requireRunningTurn(sql, owner, source);

      if (!(yield* lockWorker(sql, owner, worker)).length) return;
      const login = yield* lockedLogin(sql, owner, worker, source, name);

      if (!login) return yield* Effect.fail(new NotFound(`Project login ${name} is unavailable in this thread.`));

      if (!loginAllowsOrigin(login.metadata.websites, origin))
        return yield* Effect.fail(
          new Invalid(
            `Login ${name} is not for ${origin}. Its websites: ${login.metadata.websites.join(", ")}. Ask the owner to add this website in project settings.`,
          ),
        );
      const decision = yield* decideLogin(sql, owner, source, { ...login, name }, "browser", origin);

      if (decision.status !== "allowed") return { decision } satisfies LoginLeaseOpened;

      // Later fills in the turn reuse the lease while this connection holds it.
      const [reused] = yield* sql<{ id: string }>`SELECT id FROM project_secret_leases
        WHERE owner_user_id=${owner}::uuid AND thread_id=${source.threadId}::uuid
          AND turn_id=${source.turnId}::uuid AND worker_id=${worker.workerId}::uuid AND worker_epoch=${worker.epoch}
          AND name=${name} AND login AND memory_only AND status='saved'
          AND expires_at>clock_timestamp()+interval '30 seconds'
        ORDER BY created_at DESC LIMIT 1`;

      if (reused) {
        // A lease not delivered yet now belongs to this action.
        yield* sql`UPDATE project_secret_leases SET admission=${authorization} WHERE id=${reused.id}::uuid`;

        return { lease: reused.id } satisfies LoginLeaseOpened;
      }

      yield* sql`INSERT INTO project_secret_leases(id,owner_user_id,project_id,thread_id,turn_id,worker_id,worker_epoch,
          name,login,memory_only,origin,admission)
        VALUES (${source.callId}::uuid,${owner}::uuid,${login.projectId}::uuid,${source.threadId}::uuid,
          ${source.turnId}::uuid,${worker.workerId}::uuid,${worker.epoch},${name},true,true,${origin},${authorization})
        ON CONFLICT(id) DO NOTHING`;

      return { lease: source.callId } satisfies LoginLeaseOpened;
    }),
  );
}

function loginLeaseResult(
  sql: SqlClient.SqlClient,
  owner: string,
  worker: ProjectSecretWorker,
  source: CallSource,
  id: string,
  name: string,
) {
  return leaseForCall(sql, owner, worker, source, id, name).pipe(
    Effect.map((row) => {
      if (!row || (row.status === "saved" && new Date(row.expires_at).getTime() <= Date.now()))
        return { request_id: id, status: "expired" };

      if (row.status === "saved" && (!row.current_receipt || row.applied_revision !== row.revision))
        return { request_id: id, status: "pending", delivery: "waiting_for_worker" };

      return { request_id: id, status: row.status };
    }),
  );
}

/** The agent's view of a decision that is not allowed yet. */
export function decisionResult(decision: LoginDecision) {
  return {
    request_id: decision.id,
    status: decision.status === "pending" ? "pending" : decision.status,
    ...(decision.status === "pending" && { approval: "waiting_for_owner" }),
  };
}

export function projectLoginLeasesStore(sql: SqlClient.SqlClient) {
  return {
    openProjectLoginLease: (
      owner: string,
      worker: ProjectSecretWorker,
      source: CallSource,
      name: string,
      origin: string,
      authorization: string,
    ) => openLoginLease(sql, owner, worker, source, name, origin, authorization),
    projectLoginLeaseResult: (
      owner: string,
      worker: ProjectSecretWorker,
      source: CallSource,
      id: string,
      name: string,
    ) => loginLeaseResult(sql, owner, worker, source, id, name),
    projectLoginDecision: (owner: string, threadId: string, id: string) =>
      sql<LoginDecision>`SELECT ${sql.literal(DECISION_COLUMNS)} FROM project_login_decisions
        WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid AND thread_id=${threadId}::uuid`.pipe(
        Effect.map((rows) => rows[0]),
      ),
    /** The owner allows or declines a login that asks each time. */
    answerProjectLoginDecision: (owner: string, id: string, decline: boolean) =>
      sql<LoginDecision>`UPDATE project_login_decisions d
          SET status=CASE WHEN ${decline} THEN 'declined' ELSE 'allowed' END, revision=d.revision+1
        FROM threads t WHERE t.id=d.thread_id AND t.owner_user_id=d.owner_user_id AND t.deleted_at IS NULL
          AND d.owner_user_id=${owner}::uuid AND d.id=${id}::uuid AND d.status='pending'
        RETURNING d.id,d.thread_id,d.name,d.access,d.origin,d.status`.pipe(Effect.map((rows) => rows[0])),
    /** Revoking a login for the turn also removes the values the worker holds for it. */
    revokeProjectLoginDecision: (owner: string, id: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const [decision] = yield* sql<LoginDecision & { turn_id: string }>`UPDATE project_login_decisions d
              SET status=CASE WHEN d.status IN ('pending','allowed') THEN 'revoked' ELSE d.status END,
                revision=CASE WHEN d.status IN ('pending','allowed') THEN d.revision+1 ELSE d.revision END
            FROM threads t WHERE t.id=d.thread_id AND t.owner_user_id=d.owner_user_id AND t.deleted_at IS NULL
              AND d.owner_user_id=${owner}::uuid AND d.id=${id}::uuid
            RETURNING d.id,d.thread_id,d.turn_id,d.name,d.access,d.origin,d.status`;

          if (!decision) return;
          yield* sql`UPDATE project_secret_leases SET status='revoked',revision=revision+1,file_path=NULL
            WHERE owner_user_id=${owner}::uuid AND turn_id=${decision.turn_id}::uuid AND name=${decision.name}
              AND login AND memory_only=${decision.access === "browser"} AND status='saved'`;

          return decision;
        }),
      ),
    projectLoginDecisionUpdates: (owner: string) =>
      sql<LoginDecision>`UPDATE project_login_decisions SET published_revision=revision WHERE id IN (
        SELECT id FROM project_login_decisions WHERE owner_user_id=${owner}::uuid AND published_revision<revision
          ORDER BY id LIMIT 256 FOR UPDATE SKIP LOCKED) RETURNING ${sql.literal(DECISION_COLUMNS)}`,
  };
}
