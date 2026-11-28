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
    (file.scope === "device" || (file.scope === "platform" && Boolean(file.skillId))) &&
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
    skill &&
    (file.scope === "device" ? skill.deviceHome : skill.platformHome) &&
    skill.harnesses.includes(file.harness) &&
    skill.version === file.version &&
    skill.artifact?.name === file.localName &&
    skill.artifact.checksum === file.desiredChecksum
  );
}

export function archiveSkill(environment: AgentEnvironment, request: ui.ResolveSkillDriftRequest) {
  return archiveCopies(environment, {
    workerId: request.workerId,
    expectedRevision: request.expectedRevision,
    targets: [{ targetId: request.targetId, archiveToken: request.observedChecksum }],
  });
}

export function useLibrarySkillVersion(environment: AgentEnvironment, request: ui.UseLibrarySkillVersionRequest) {
  if (!request.skillId || !request.reportId || !request.targets.length || request.targets.length > 512)
    throw new ConnectError("Choose the skill copies from a current report.", Code.InvalidArgument);

  return archiveCopies(environment, request);
}

interface ArchiveRequest {
  workerId: string;
  skillId?: string;
  reportId?: string;
  expectedRevision: bigint;
  targets: readonly { targetId: string; archiveToken: string }[];
}

/** Claim every reviewed target in this worker's report together. Moves never enter reconnectable desired state. */
async function archiveCopies(environment: AgentEnvironment, request: ArchiveRequest) {
  const connection = environment.options.link.connections.get(request.workerId);
  const currentReport = connection && environment.skillReports.get(connection);
  const epoch = connection?.registrationEpoch;
  const snapshot = await environment.snapshot();
  const worker = snapshot.workers.find((w) => w.workerId === request.workerId);

  if (!worker) throw new ConnectError("Worker not found.", Code.NotFound);

  if (
    !connection?.isOpen ||
    !epoch ||
    !currentReport ||
    currentReport.id !== worker.skillReportId ||
    (request.reportId && request.reportId !== currentReport.id) ||
    !worker.skillsSupported ||
    !worker.supported ||
    worker.compositionError ||
    request.expectedRevision !== snapshot.revision ||
    worker.report?.revision !== snapshot.revision ||
    currentReport.revision !== snapshot.revision
  )
    throw stale();

  const desired = await environment.desired(snapshot, worker, connection);
  const reported = new Map(worker.report.skills.map((file) => [file.targetId, file]));

  const copies = request.targets.map(({ targetId, archiveToken }) => {
    const file = reported.get(targetId);
    reported.delete(targetId); // A target can only occur once in the group.

    if (
      !file ||
      !archiveCandidate(file) ||
      (request.skillId ? file.skillId !== request.skillId : file.scope !== "device") ||
      archiveToken !== file.archiveToken ||
      archiveToken !== currentReport.tokens.get(targetId) ||
      !desiredMatches(file, desired.skills)
    )
      throw stale();

    return file;
  });

  const current = () =>
    connection.isOpen &&
    currentReport === environment.skillReports.get(connection) &&
    environment.options.link.connections.get(worker.workerId) === connection;

  const owner = environment.options.userId;
  await environment.db.run(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const revision = yield* sql`SELECT 1 FROM agent_environments WHERE owner_user_id=${owner}::uuid
            AND revision=${snapshot.revision} FOR UPDATE`;

          if (!revision.length || !current()) return yield* Effect.fail(stale());
          const tokens = JSON.stringify(Object.fromEntries(copies.map((file) => [file.targetId, file.archiveToken])));

          const claimed = yield* sql`WITH reviewed AS (
              SELECT key, value FROM jsonb_each_text(${tokens}::jsonb)
            ), remaining AS (
              SELECT jsonb_agg(CASE WHEN r.key IS NULL THEN item ELSE item - 'archiveToken' END ORDER BY idx) AS skills,
                count(r.key) AS matched
              FROM worker_environments e
              CROSS JOIN LATERAL jsonb_array_elements(e.report->'skills') WITH ORDINALITY AS s(item, idx)
              LEFT JOIN reviewed r ON r.key=item->>'targetId' AND r.value=item->>'archiveToken'
              WHERE e.worker_id=${worker.workerId}::uuid
            )
            UPDATE worker_environments e SET report=jsonb_set(e.report,'{skills}',remaining.skills)
            FROM remaining, workers w JOIN worker_connections c ON c.worker_id=w.id
            WHERE w.id=e.worker_id AND w.id=${worker.workerId}::uuid AND w.owner_user_id=${owner}::uuid
              AND w.revoked_at IS NULL AND w.archived_at IS NULL AND c.epoch=${epoch}
              AND e.reported_at::text=${currentReport.id} AND remaining.matched=${copies.length}
            RETURNING e.worker_id`;

          if (!claimed.length) return yield* Effect.fail(stale());
          const audit = JSON.stringify(copies.map(({ targetId, skillId }) => ({ targetId, skillId })));
          yield* sql`INSERT INTO audit_log(id,actor_user_id,action,target_type,target_id,details)
            SELECT gen_random_uuid(),${owner}::uuid,'environment.skill.archive','worker',${worker.workerId}::uuid, entry
            FROM jsonb_array_elements(${audit}::jsonb) AS entry`;
        }),
      );
    }),
  );

  if (!current()) throw stale();
  desired.skillResolutions = copies.map((file) =>
    create(EnvironmentResolutionSchema, {
      targetId: file.targetId,
      action: "archive",
      observedChecksum: file.archiveToken,
      desiredChecksum: file.desiredChecksum,
    }),
  );
  connection.send({ case: "agentEnvironment", value: desired });
  environment.options.changed();

  return environment.snapshot();
}
