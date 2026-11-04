import { createHash, randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { ui, WorkerEnrollmentService, EnrollResponseSchema, type EnrollRequest } from "@canopy/contracts";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GatewayStore, InstanceStore, SettingsStore } from "../store/index.ts";
import type { WorkerLink } from "../worker-link/index.ts";
import type { CoreRuntime } from "./core.ts";
import type { NetworkAccess } from "../network/network.ts";
import { manualTags } from "../agent-environment/composition.ts";
import { enrollTags } from "../agent-environment/enrollment.ts";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

// Pasted into `canopy-worker enroll --token …`: a base64url value may start with "-", which CLI parsers read as a flag.
const enrollmentSecret = () => `canopy_enroll_${secret()}`;
const uuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

type EnrollmentRow = {
  id: string;
  name: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  worker_id: string | null;
};

const metadata = (row: EnrollmentRow) =>
  create(ui.WorkerEnrollmentSchema, {
    id: row.id,
    name: row.name,
    expiresAt: timestampFromDate(new Date(row.expires_at)),
    workerId: row.worker_id ?? "",
    ...(row.used_at && { usedAt: timestampFromDate(new Date(row.used_at)) }),
    ...(row.revoked_at && { revokedAt: timestampFromDate(new Date(row.revoked_at)) }),
  });

/** Secret boundary: never expose driver errors, request bodies, tokens or credentials in diagnostics. */
export async function workerGuard<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    throw new ConnectError("Worker operation failed. Refresh and try again.", Code.FailedPrecondition);
  }
}

export class WorkerAdministration {
  // A process-wide budget (single gateway), independent of spoofable forwarded headers or token values.
  #window = 0;
  #attempts = 0;
  constructor(
    readonly options: {
      runtime: CoreRuntime;
      userId: string;
      link: WorkerLink;
      network?: () => NetworkAccess | undefined;
      disconnectUpdates?: (workerId: string) => void;
      publish: (enrollment: ui.WorkerEnrollment) => void;
      changed: () => Promise<void>;
      removed: (workerId: string) => void | Promise<void>;
    },
  ) {}

  routes = (router: ConnectRouter) =>
    router.service(WorkerEnrollmentService, {
      enroll: (request) => workerGuard(() => this.enroll(request)),
    });

  async setup(): Promise<ui.GetWorkerSetupResponse> {
    const { runtime, userId } = this.options;

    const [settings, enrollments] = await Promise.all([
      runtime.runPromise(SettingsStore.use((s) => s.user(userId))),
      runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return (yield* sql<EnrollmentRow>`SELECT id, name, expires_at, used_at, revoked_at, worker_id FROM worker_enrollments
          WHERE owner_user_id = ${userId}::uuid AND created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 100`).map(
            metadata,
          );
        }),
      ),
    ]);

    const network = this.options.network?.();
    const gatewayUrl = settings.workerGatewayUrl || network?.addresses()[0]?.origin || "";

    return create(ui.GetWorkerSetupResponseSchema, {
      gatewayUrl,
      gatewayFingerprint: network?.listening && gatewayUrl.startsWith("https://") ? network.fingerprint : "",
      enrollments,
    });
  }

  async create(name: string, requestedTags: readonly string[] = []): Promise<ui.CreateWorkerEnrollmentResponse> {
    name = machineName(name);
    const tags = manualTags(requestedTags);
    const { runtime, userId } = this.options;
    const token = enrollmentSecret();

    const enrollment = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        // Bound outstanding invitations, including requests from several tabs at once.
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;

            const pending = yield* sql`SELECT id FROM worker_enrollments WHERE owner_user_id = ${userId}::uuid
          AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()`;

            if (pending.length >= 20) return yield* Effect.fail(new Error("too many pending invitations"));

            const rows =
              yield* sql<EnrollmentRow>`INSERT INTO worker_enrollments (id, owner_user_id, name, token_hash, expires_at, tags)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, ${name}, ${digest(token)}, now() + interval '30 minutes', ${tags}::text[])
          RETURNING id, name, expires_at, used_at, revoked_at, worker_id`;

            yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, 'worker.enrollment.create', 'worker_enrollment', ${rows[0]!.id}::uuid)`;

            return metadata(rows[0]!);
          }),
        );
      }),
    );

    this.options.publish(enrollment);

    return create(ui.CreateWorkerEnrollmentResponseSchema, { enrollment, token });
  }

  async revokeEnrollment(id: string): Promise<void> {
    if (!uuid(id)) throw new ConnectError("Enrollment not found", Code.NotFound);
    const { runtime, userId } = this.options;

    const rows = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<EnrollmentRow>`UPDATE worker_enrollments SET revoked_at = now()
        WHERE id = ${id}::uuid AND owner_user_id = ${userId}::uuid AND used_at IS NULL
        RETURNING id, name, expires_at, used_at, revoked_at, worker_id`;

            if (rows[0])
              yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, 'worker.enrollment.revoke', 'worker_enrollment', ${id}::uuid)`;

            return rows;
          }),
        );
      }),
    );

    if (!rows[0]) throw new ConnectError("Pending enrollment not found", Code.NotFound);
    this.options.publish(metadata(rows[0]));
  }

  async enroll(request: EnrollRequest) {
    const now = Date.now();

    if (now - this.#window >= 60_000) {
      this.#window = now;
      this.#attempts = 0;
    }

    if (++this.#attempts > 60)
      throw new ConnectError("Too many enrollment attempts. Try again in one minute.", Code.ResourceExhausted);

    const invalid = () =>
      new ConnectError("Enrollment token is invalid, expired, revoked or already used", Code.Unauthenticated);

    if (!/^canopy_enroll_[A-Za-z0-9_-]{43}$/.test(request.enrollmentToken)) throw invalid();
    const host = request.host;

    if (
      !host?.hostname ||
      host.hostname.length > 255 ||
      /[\p{Cc}]/u.test(host.hostname) ||
      !["linux", "darwin", "win32"].includes(host.os) ||
      host.arch.length > 40
    ) {
      throw new ConnectError("Valid machine hostname and OS are required", Code.InvalidArgument);
    }

    const { runtime } = this.options;

    const result = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            // UPDATE takes the row lock and rechecks eligibility after concurrent exchange/revoke.
            const rows = yield* sql<
              EnrollmentRow & { owner_user_id: string; tags: string[] }
            >`SELECT * FROM worker_enrollments
          WHERE token_hash = ${digest(request.enrollmentToken)} AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`;

            const row = rows[0];

            if (!row) return undefined;

            // Check expiry again after taking the lock (clock_timestamp is not transaction-start time).
            const eligible =
              yield* sql`SELECT id FROM worker_enrollments WHERE id = ${row.id}::uuid AND expires_at > clock_timestamp()`;

            if (!eligible.length) return undefined;

            const { workerId, credential } = yield* GatewayStore.use((s) =>
              s.addWorker({ name: row.name, ownerUserId: row.owner_user_id }),
            );

            yield* sql`UPDATE workers SET os = ${host.os}, arch = ${host.arch}, capabilities = ${JSON.stringify({ hostname: host.hostname })}::jsonb WHERE id = ${workerId}::uuid`;
            yield* enrollTags(sql, row.owner_user_id, workerId, row.tags);
            yield* GatewayStore.use((s) =>
              s.setWorkerConfig(
                workerId,
                { claude: { enabled: true }, codex: { enabled: true }, grok: { enabled: true } },
                row.owner_user_id,
              ),
            );
            yield* InstanceStore.use((s) => s.sync(row.owner_user_id, [workerId]));

            const updated =
              yield* sql<EnrollmentRow>`UPDATE worker_enrollments SET used_at = clock_timestamp(), worker_id = ${workerId}::uuid
          WHERE id = ${row.id}::uuid RETURNING id, name, expires_at, used_at, revoked_at, worker_id`;

            yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${row.owner_user_id}::uuid, 'worker.enroll', 'worker', ${workerId}::uuid)`;

            return { workerId, credential, enrollment: metadata(updated[0]!) };
          }),
        );
      }),
    );

    if (!result) throw invalid();
    this.options.publish(result.enrollment);
    await this.options.changed();

    return create(EnrollResponseSchema, { workerId: result.workerId, workerCredential: result.credential });
  }

  async manage(workerId: string, action: "rename" | "rotate" | "revoke" | "archive", name?: string): Promise<string> {
    if (!uuid(workerId)) throw new ConnectError("Worker not found", Code.NotFound);
    const { runtime, userId, link } = this.options;
    const nextName = action === "rename" ? machineName(name ?? "") : "";
    const credential = action === "rotate" ? secret() : "";

    const found = await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT id FROM workers WHERE id = ${workerId}::uuid AND owner_user_id = ${userId}::uuid AND archived_at IS NULL FOR UPDATE`;

            if (!rows.length) return false;

            if (action === "rename") yield* sql`UPDATE workers SET name = ${nextName} WHERE id = ${workerId}::uuid`;

            if (action === "rotate") {
              const active =
                yield* sql`UPDATE workers SET credential_hash = ${digest(credential)} WHERE id = ${workerId}::uuid AND revoked_at IS NULL RETURNING id`;

              if (!active.length) return false;
            }

            if (action === "revoke")
              yield* sql`UPDATE workers SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${workerId}::uuid`;

            if (action === "archive") {
              yield* sql`UPDATE workers SET archived_at = now(), revoked_at = coalesce(revoked_at, now()) WHERE id = ${workerId}::uuid`;
              yield* sql`UPDATE project_workspaces SET archived_at = coalesce(archived_at, now()) WHERE worker_id = ${workerId}::uuid`;
            }

            yield* sql`INSERT INTO audit_log (id, actor_user_id, action, target_type, target_id)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${userId}::uuid, ${`worker.${action}`}, 'worker', ${workerId}::uuid)`;

            return true;
          }),
        );
      }),
    );

    if (!found) throw new ConnectError("Active worker not found", Code.NotFound);

    if (action !== "rename") {
      link.disconnect(workerId);
      this.options.disconnectUpdates?.(workerId);
    }

    if (action === "archive") await this.options.removed(workerId);
    await this.options.changed();

    return credential;
  }
}

function machineName(value: string): string {
  const name = value.trim();

  if (!name || name.length > 200 || /[\p{Cc}]/u.test(name))
    throw new ConnectError("Use a machine name with 1–200 characters on one line", Code.InvalidArgument);

  return name;
}

export function checkWorkerGatewayUrl(value: string): void {
  if (!value) return; // Clears the override, reverting to automatic Network access addresses.

  try {
    const url = new URL(value);

    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      value.length > 500
    )
      throw new Error();
  } catch {
    throw new ConnectError(
      "Use a gateway origin with its gRPC port, e.g. http://my-machine:7443",
      Code.InvalidArgument,
    );
  }
}
