import type { JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ThreadSecretDelivery, ThreadSecretReceipt } from "@canopy/contracts";
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import { isUuid } from "./agent-bus-queries.ts";
import type { CallSource } from "./agent-bus.ts";
import { Invalid, NotFound } from "./errors.ts";
import { lockedOwnerModule, moduleDisabledMessage } from "./module-access.ts";
import { decryptSecret } from "./secrets.ts";
import { loginMetadata, loginValue } from "./project-logins.ts";
import { decideLogin, lockedLogin, type LoginLeaseOpened } from "./project-login-leases.ts";

export interface ProjectSecretWorker {
  workerId: string;
  epoch: bigint;
}

export interface ProjectSecretLease {
  id: string;
  thread_id: string;
  name: string;
  status: string;
  expires_at: Date;
  memory_only: boolean;
  login: boolean;
  origin: string | null;
}

type LeaseRow = ProjectSecretLease & {
  turn_id: string;
  revision: number;
  applied_revision: number;
  current_receipt: boolean;
  file_path: string | null;
};

export function lockWorker(sql: SqlClient.SqlClient, owner: string, { workerId, epoch }: ProjectSecretWorker) {
  return sql`SELECT c.epoch FROM workers w JOIN worker_connections c ON c.worker_id=w.id
    WHERE c.worker_id=${workerId}::uuid AND c.epoch=${epoch}
      AND (w.owner_user_id IS NULL OR w.owner_user_id=${owner}::uuid)
      AND w.revoked_at IS NULL AND w.archived_at IS NULL FOR SHARE OF w,c`;
}

export function leaseForCall(
  sql: SqlClient.SqlClient,
  owner: string,
  worker: ProjectSecretWorker,
  source: CallSource,
  id: string,
  name: string,
) {
  return sql<LeaseRow>`SELECT id,thread_id,turn_id,name,expires_at,revision,applied_revision,file_path,memory_only,login,
      origin,
      CASE WHEN status='saved' AND worker_epoch<>${worker.epoch} THEN 'revoked' ELSE status END AS status,
      coalesce(applied_epoch=${worker.epoch},false) AND EXISTS(SELECT 1 FROM worker_connections c
        WHERE c.worker_id=project_secret_leases.worker_id AND c.epoch=${worker.epoch}) AS current_receipt
    FROM project_secret_leases WHERE id=${id}::uuid AND owner_user_id=${owner}::uuid
      AND thread_id=${source.threadId}::uuid AND turn_id=${source.turnId}::uuid
      AND worker_id=${worker.workerId}::uuid AND name=${name}`.pipe(Effect.map((rows) => rows[0]));
}

type SecretLeaseOpened = LoginLeaseOpened;

/** A project secret, or a login allowed outside the browser, as a private file for the current turn. */
function openLease(
  sql: SqlClient.SqlClient,
  owner: string,
  worker: ProjectSecretWorker,
  source: CallSource,
  name: string,
  retryId?: string,
  logins = true,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      if (!isUuid(source.callId) || !isUuid(source.turnId))
        return yield* Effect.fail(new Invalid("A project secret requires a running turn."));

      if (!(yield* lockedOwnerModule(sql, owner, "threads")))
        return yield* Effect.fail(new Invalid(moduleDisabledMessage("threads")));

      if (!(yield* lockWorker(sql, owner, worker)).length) return;

      if (retryId && (yield* leaseForCall(sql, owner, worker, source, retryId, name)))
        return { lease: retryId } satisfies SecretLeaseOpened;

      // A retry continues its own lease, or the owner's answer about a login file in this turn.
      if (
        retryId &&
        !(yield* sql`SELECT 1 FROM project_login_decisions WHERE id=${retryId}::uuid AND owner_user_id=${owner}::uuid
          AND turn_id=${source.turnId}::uuid AND thread_id=${source.threadId}::uuid AND name=${name}`).length
      )
        return yield* Effect.fail(new NotFound("Project secret request not found in this turn."));
      const id = source.callId;

      if (yield* leaseForCall(sql, owner, worker, source, id, name)) return { lease: id } satisfies SecretLeaseOpened;

      const [project] = yield* sql<{ id: string }>`SELECT p.id FROM threads t
        JOIN turns u ON u.thread_id=t.id AND u.id=${source.turnId}::uuid
        JOIN projects p ON p.id=t.project_id JOIN project_secrets s ON s.project_id=p.id AND s.name=${name}
        WHERE t.id=${source.threadId}::uuid AND t.worker_id=${worker.workerId}::uuid
          AND t.owner_user_id=${owner}::uuid AND p.owner_user_id=t.owner_user_id AND p.kind='project'
          AND t.runtime='worker' AND t.deleted_at IS NULL AND t.archived_at IS NULL
          AND p.archived_at IS NULL AND t.moved_to IS NULL AND t.rewind_pending_id IS NULL
          AND u.status='running' AND u.rewind_id IS NULL FOR SHARE OF t,u,p,s`;

      const login = project ? undefined : yield* lockedLogin(sql, owner, worker, source, name);

      if (login && !logins)
        return yield* Effect.fail(new Invalid("Update Canopy on this computer to use project logins."));

      if (!project && !login?.metadata.outside_browser)
        return yield* Effect.fail(
          new NotFound(
            login
              ? `Login ${name} is for Agent Browser only. Ask the owner to allow it outside the browser in project settings.`
              : "Project secret unavailable in this turn.",
          ),
        );

      if (login) {
        const decision = yield* decideLogin(sql, owner, source, { ...login, name }, "file", null);

        if (decision.status !== "allowed") return { decision } satisfies SecretLeaseOpened;
      }

      yield* sql`INSERT INTO project_secret_leases(id,owner_user_id,project_id,thread_id,turn_id,worker_id,worker_epoch,
          name,login)
        VALUES (${id}::uuid,${owner}::uuid,${project?.id ?? login!.projectId}::uuid,${source.threadId}::uuid,
          ${source.turnId}::uuid,${worker.workerId}::uuid,${worker.epoch},${name},${Boolean(login)})
        ON CONFLICT(id) DO NOTHING`;

      if (!(yield* leaseForCall(sql, owner, worker, source, id, name)))
        return yield* Effect.fail(new NotFound("Project secret request not found in this turn."));

      return { lease: id } satisfies SecretLeaseOpened;
    }),
  );
}

function pendingDeliveries(sql: SqlClient.SqlClient, owner: string, worker: ProjectSecretWorker) {
  const { workerId, epoch } = worker;

  return sql<LeaseRow & { cwd: string | null }>`WITH due AS MATERIALIZED (
      SELECT l.id,t.cwd
      FROM project_secret_leases l JOIN threads t ON t.id=l.thread_id
      WHERE l.owner_user_id=${owner}::uuid AND l.worker_id=${workerId}::uuid
        AND l.applied_revision<l.revision
        AND (l.last_delivery_epoch IS DISTINCT FROM ${epoch} OR l.last_delivery_revision IS DISTINCT FROM l.revision
          OR l.last_delivery_at <= clock_timestamp()-interval '1 second')
      ORDER BY l.last_delivery_at NULLS FIRST, l.id LIMIT 64 FOR UPDATE OF l SKIP LOCKED
    )
    UPDATE project_secret_leases l SET last_delivery_at=clock_timestamp(),last_delivery_epoch=${epoch},
      last_delivery_revision=l.revision FROM due WHERE l.id=due.id RETURNING l.*,due.cwd`;
}

/** Leases to revoke for an older connection or to deliver, read without locks (same conditions as below). */
function deliveryWork(sql: SqlClient.SqlClient, owner: string, { workerId, epoch }: ProjectSecretWorker) {
  return sql<{ due: boolean }>`SELECT EXISTS(SELECT 1 FROM project_secret_leases l
    WHERE l.owner_user_id=${owner}::uuid AND l.worker_id=${workerId}::uuid
      AND ((l.worker_epoch<>${epoch} AND l.status='saved') OR (l.applied_revision<l.revision
        AND (l.last_delivery_epoch IS DISTINCT FROM ${epoch} OR l.last_delivery_revision IS DISTINCT FROM l.revision
          OR l.last_delivery_at <= clock_timestamp()-interval '1 second')))) AS due`.pipe(
    Effect.map((rows) => rows[0]?.due === true),
  );
}

/** Queue metadata only. The stream checks the lease again as it takes each grant out of its queue. */
function deliverLeases(
  sql: SqlClient.SqlClient,
  owner: string,
  worker: ProjectSecretWorker,
  send: (delivery: ThreadSecretDelivery) => boolean,
) {
  // Polled every second for every connected worker: with nothing due, take no row locks, which write WAL.
  return Effect.flatMap(deliveryWork(sql, owner, worker), (due) =>
    due ? deliverDue(sql, owner, worker, send) : Effect.void,
  );
}

function deliverDue(
  sql: SqlClient.SqlClient,
  owner: string,
  worker: ProjectSecretWorker,
  send: (delivery: ThreadSecretDelivery) => boolean,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* lockWorker(sql, owner, worker)).length) return;

      yield* sql`UPDATE project_secret_leases SET status='revoked',revision=revision+1,file_path=NULL
        WHERE owner_user_id=${owner}::uuid AND worker_id=${worker.workerId}::uuid
          AND worker_epoch<>${worker.epoch} AND status='saved'`;
      const rows = yield* pendingDeliveries(sql, owner, worker);

      for (const row of rows) {
        const expiresAt = new Date(row.expires_at);
        const live = row.status === "saved" && expiresAt.getTime() > Date.now();

        const message: ThreadSecretDelivery = {
          $typeName: "canopy.worker.v1.ThreadSecretDelivery",
          requestId: row.id,
          threadId: row.thread_id,
          turnId: row.turn_id,
          revision: row.revision,
          cwd: row.cwd ?? "",
          expiresAt: timestampFromDate(expiresAt),
          value: "",
          remove: !live,
          memoryOnly: row.memory_only,
          login: row.login,
        };

        if (!send(message)) return;
      }
    }),
  );
}

function deliveryValue(
  sql: SqlClient.SqlClient,
  key: Buffer,
  owner: string,
  worker: ProjectSecretWorker,
  delivery: ThreadSecretDelivery,
  admitted: (authorization: string, name: string) => boolean,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      if (!(yield* lockWorker(sql, owner, worker)).length) return;

      const [secret] = yield* sql<{
        ciphertext: Uint8Array;
        login: JsonValue | null;
        name: string;
        admission: string | null;
      }>`SELECT coalesce(g.ciphertext,s.ciphertext) AS ciphertext,g.login,l.name,l.admission
        FROM project_secret_leases l
        LEFT JOIN project_secrets s ON NOT l.login AND s.project_id=l.project_id AND s.name=l.name
        LEFT JOIN project_logins g ON l.login AND g.project_id=l.project_id AND g.name=l.name
        WHERE (s.name IS NOT NULL OR g.name IS NOT NULL) AND l.id=${delivery.requestId}::uuid AND l.thread_id=${delivery.threadId}::uuid AND l.turn_id=${delivery.turnId}::uuid
          AND l.owner_user_id=${owner}::uuid AND l.worker_id=${worker.workerId}::uuid AND l.worker_epoch=${worker.epoch}
          AND l.revision=${delivery.revision} AND l.status='saved' AND l.expires_at>clock_timestamp()
          AND l.last_delivery_revision=l.revision AND l.last_delivery_epoch=${worker.epoch}
        FOR SHARE OF l`;

      if (!secret) return;

      // A browser lease leaves the gateway only while the browser action that asked for it runs.
      if (secret.admission && !admitted(secret.admission, secret.name)) {
        yield* sql`UPDATE project_secret_leases SET status='revoked',revision=revision+1,file_path=NULL
          WHERE id=${delivery.requestId}::uuid AND owner_user_id=${owner}::uuid AND status='saved'`;

        return;
      }

      return secret.login === null
        ? decryptSecret(key, secret.ciphertext)
        : loginValue(key, secret.name, loginMetadata(secret.login), secret.ciphertext);
    }),
  );
}

function receiptLease(
  sql: SqlClient.SqlClient,
  owner: string,
  worker: ProjectSecretWorker,
  receipt: ThreadSecretReceipt,
) {
  return sql.withTransaction(
    Effect.gen(function* () {
      if (
        receipt.applied === receipt.rejected ||
        receipt.file.length > 4096 ||
        !isUuid(receipt.requestId) ||
        !isUuid(receipt.threadId) ||
        !isUuid(receipt.turnId) ||
        !(yield* lockWorker(sql, owner, worker)).length
      )
        return;

      yield* sql`UPDATE project_secret_leases SET
        applied_revision=CASE WHEN ${receipt.applied} THEN revision ELSE applied_revision END,
        applied_epoch=CASE WHEN ${receipt.applied} THEN ${worker.epoch} ELSE applied_epoch END,
        file_path=CASE WHEN status='saved' AND ${receipt.applied} AND NOT memory_only THEN ${receipt.file} ELSE NULL END,
        status=CASE WHEN ${receipt.rejected} THEN 'revoked' ELSE status END,
        revision=CASE WHEN ${receipt.rejected} THEN revision+1 ELSE revision END
        WHERE id=${receipt.requestId}::uuid AND thread_id=${receipt.threadId}::uuid
          AND turn_id=${receipt.turnId}::uuid AND worker_id=${worker.workerId}::uuid AND owner_user_id=${owner}::uuid
          AND revision=${receipt.revision} AND last_delivery_revision=revision AND last_delivery_epoch=${worker.epoch}
          AND (CASE WHEN status='saved' THEN expires_at>clock_timestamp()
            AND (${receipt.rejected} OR (${receipt.file} <> '') <> memory_only)
            ELSE ${receipt.applied} AND ${receipt.file} = '' END)`;
    }),
  );
}

export function projectSecretLeasesStore(sql: SqlClient.SqlClient, key: Buffer) {
  return {
    openProjectSecretLease: (
      owner: string,
      worker: ProjectSecretWorker,
      source: CallSource,
      name: string,
      retryId?: string,
      logins?: boolean,
    ) => openLease(sql, owner, worker, source, name, retryId, logins),
    projectSecretLeaseResult: (
      owner: string,
      worker: ProjectSecretWorker,
      source: CallSource,
      id: string,
      name: string,
    ) =>
      leaseForCall(sql, owner, worker, source, id, name).pipe(
        Effect.map((row) => {
          const base = { request_id: id, status: row?.status ?? "expired" };

          if (!row || row.status !== "saved") return base;
          const expiresAt = new Date(row.expires_at);

          if (expiresAt.getTime() <= Date.now()) return { ...base, status: "expired" };

          if (!row.current_receipt || row.applied_revision !== row.revision || !row.file_path)
            return { ...base, status: "pending", delivery: "waiting_for_worker" };

          return {
            ...base,
            file: row.file_path,
            name: row.name,
            expires_at: expiresAt.toISOString(),
            ...(row.login && {
              format: "JSON with username, password, websites, hide_username and an optional one_time_code_setup",
            }),
          };
        }),
      ),
    revokeProjectSecretLease: (owner: string, id: string) =>
      sql<ProjectSecretLease>`UPDATE project_secret_leases l
          SET status=CASE WHEN l.status='saved' THEN 'revoked' ELSE l.status END,
          revision=CASE WHEN l.status='saved' THEN l.revision+1 ELSE l.revision END, file_path=NULL
        FROM threads t WHERE t.id=l.thread_id AND t.owner_user_id=l.owner_user_id AND t.deleted_at IS NULL
          AND l.owner_user_id=${owner}::uuid AND l.id=${id}::uuid RETURNING l.*`.pipe(Effect.map((rows) => rows[0])),
    expireProjectSecretLeases: (owner: string) =>
      sql`UPDATE project_secret_leases SET status='expired',revision=revision+1,file_path=NULL WHERE id IN (
        SELECT id FROM project_secret_leases WHERE owner_user_id=${owner}::uuid
          AND status='saved' AND expires_at<=clock_timestamp() ORDER BY expires_at LIMIT 256
        FOR UPDATE SKIP LOCKED)`.pipe(Effect.asVoid),
    projectSecretLeaseUpdates: (owner: string) =>
      sql<ProjectSecretLease>`UPDATE project_secret_leases SET published_revision=revision WHERE id IN (
        SELECT id FROM project_secret_leases WHERE owner_user_id=${owner}::uuid AND published_revision<revision
          ORDER BY id LIMIT 256 FOR UPDATE SKIP LOCKED)
        RETURNING id,thread_id,name,status,expires_at,memory_only,login,origin`,
    deliverProjectSecretLeases: (
      owner: string,
      worker: ProjectSecretWorker,
      send: (delivery: ThreadSecretDelivery) => boolean,
    ) => deliverLeases(sql, owner, worker, send),
    projectSecretDeliveryValue: (
      owner: string,
      worker: ProjectSecretWorker,
      delivery: ThreadSecretDelivery,
      admitted: (authorization: string, name: string) => boolean,
    ) => deliveryValue(sql, key, owner, worker, delivery, admitted),
    receiptProjectSecretLease: (owner: string, worker: ProjectSecretWorker, receipt: ThreadSecretReceipt) =>
      receiptLease(sql, owner, worker, receipt),
  };
}
