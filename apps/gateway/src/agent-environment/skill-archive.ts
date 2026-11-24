import { isHarness } from "@canopy/domain/harnesses";
import { create } from "@bufbuild/protobuf";
import {
  EnvironmentResolutionSchema,
  type EnvironmentSkill,
  type EnvironmentSkillStatus,
  type ui,
} from "@canopy/contracts";
import { environmentDigest } from "@canopy/domain/agent-environment";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { posix, win32 } from "node:path";
import type { AgentEnvironment } from "./service.ts";

const stale = () =>
  new ConnectError("This skill copy changed. Refresh the computer before moving it.", Code.FailedPrecondition);

const digest = /^[a-f0-9]{64}$/;

function archiveCandidate(file: EnvironmentSkillStatus) {
  return (
    file.scope === "device" &&
    !file.owned &&
    !file.importable &&
    !file.managedFiles.length &&
    ["local", "kept", "drift", "error"].includes(file.status) &&
    digest.test(file.archiveToken)
  );
}

/** Previous workers have neither inventory names nor tokens. Apply inventory rules only to the new records. */
export function validSkillInventory(files: readonly EnvironmentSkillStatus[]): boolean {
  const ids = new Set<string>();

  for (const file of files) {
    if (file.targetId && ids.has(file.targetId)) return false;
    ids.add(file.targetId);

    if (!file.localName && !file.archiveToken && file.status !== "local") continue;
    const path = posix.isAbsolute(file.path) ? posix : win32;

    if (
      !file.localName ||
      file.localName.length > 255 ||
      file.path.length > 32767 ||
      !path.isAbsolute(file.path) ||
      path.basename(file.path) !== file.localName ||
      file.localName === "." ||
      file.localName === ".." ||
      file.path.includes("\0") ||
      file.targetId !== environmentDigest(`skill:${file.path}`) ||
      !isHarness(file.harness)
    )
      return false;

    if (!["local", "applied", "drift", "kept", "error", "removed"].includes(file.status)) return false;

    if (file.status === "local" && file.skillId) return false;

    if (
      !file.skillId &&
      (file.scope !== "device" ||
        file.owned ||
        !["local", "error"].includes(file.status) ||
        file.importable ||
        file.managedFiles.length ||
        file.desiredFiles.length ||
        file.desiredChecksum ||
        file.version)
    )
      return false;

    if (file.archiveToken && !archiveCandidate(file)) return false;
  }

  return true;
}

function desiredMatches(file: EnvironmentSkillStatus, skills: readonly EnvironmentSkill[]) {
  if (!file.skillId) return !file.desiredChecksum && !file.version;
  const skill = skills.find((s) => s.id === file.skillId);

  return (
    skill?.deviceHome &&
    skill.harnesses.includes(file.harness) &&
    skill.version === file.version &&
    skill.artifact?.name === file.localName &&
    skill.artifact.checksum === file.desiredChecksum
  );
}

/** A move is a one-shot authorization for the reporting connection. It must never enter reconnectable desired state. */
export async function archiveSkill(environment: AgentEnvironment, request: ui.ResolveSkillDriftRequest) {
  const connection = environment.options.link.connections.get(request.workerId);
  const currentReport = connection && environment.skillReports.get(connection);
  const epoch = connection?.registrationEpoch;
  const snapshot = await environment.snapshot();
  const worker = snapshot.workers.find((w) => w.workerId === request.workerId);

  if (!worker) throw new ConnectError("Worker not found.", Code.NotFound);
  const index = worker.report?.skills.findIndex((s) => s.targetId === request.targetId) ?? -1;
  const file = worker.report?.skills[index];

  if (
    !connection?.isOpen ||
    !epoch ||
    !currentReport ||
    !worker.skillsSupported ||
    !worker.supported ||
    worker.compositionError ||
    !file ||
    !archiveCandidate(file) ||
    request.observedChecksum !== file.archiveToken ||
    request.expectedRevision !== snapshot.revision ||
    worker.report?.revision !== snapshot.revision
  )
    throw stale();

  const desired = await environment.desired(snapshot, worker, connection);

  if (!desiredMatches(file, desired.skills)) throw stale();
  const owner = environment.options.userId;

  const current = () =>
    connection.isOpen &&
    currentReport === environment.skillReports.get(connection) &&
    environment.options.link.connections.get(worker.workerId) === connection;

  await environment.db.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          // Report acceptance and library mutations lock this row first. Concurrent claims consume the token once.
          const revision = yield* sql`SELECT 1 FROM agent_environments WHERE owner_user_id=${owner}::uuid
        AND revision=${snapshot.revision} FOR UPDATE`;

          if (!revision.length || !current()) return yield* Effect.fail(stale());
          const offset = String(index);

          const claimed =
            yield* sql`UPDATE worker_environments e SET report=report #- ARRAY['skills',${offset},'archiveToken']
        FROM workers w JOIN worker_connections c ON c.worker_id=w.id
        WHERE w.id=e.worker_id AND w.id=${worker.workerId}::uuid AND w.owner_user_id=${owner}::uuid
        AND w.revoked_at IS NULL AND w.archived_at IS NULL AND c.epoch=${epoch}
        AND COALESCE((e.report->>'revision')::bigint,0)=${snapshot.revision}
        AND e.report #>> ARRAY['skills',${offset},'targetId']=${file.targetId}
        AND e.report #>> ARRAY['skills',${offset},'archiveToken']=${file.archiveToken} RETURNING e.worker_id`;

          if (!claimed.length) return yield* Effect.fail(stale());
          yield* sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
        VALUES (${Bun.randomUUIDv7()}::uuid,${owner}::uuid,'environment.skill.archive','worker',${worker.workerId}::uuid,
        ${JSON.stringify({ targetId: file.targetId, skillId: file.skillId })}::jsonb)`;
        }),
      );
    }),
  );

  if (!current()) throw stale();
  desired.skillResolutions = [
    create(EnvironmentResolutionSchema, {
      targetId: file.targetId,
      action: "archive",
      observedChecksum: file.archiveToken,
      desiredChecksum: file.desiredChecksum,
    }),
  ];
  connection.send({ case: "agentEnvironment", value: desired });
  environment.options.changed();

  return environment.snapshot();
}
