import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { canPreviewSkillConflict } from "@canopy/domain/environment-library";
import { validateSkillFiles } from "@canopy/domain/skill-artifact";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AgentEnvironment } from "./service.ts";

const stale = () =>
  new ConnectError("This skill copy changed. Refresh the computer and try again.", Code.FailedPrecondition);

export async function previewWorkerSkill(environment: AgentEnvironment, request: ui.PreviewWorkerSkillRequest) {
  const { workerId, targetId, archiveToken, expectedRevision, skillId } = request;
  const connections = environment.options.link.connections;
  const connection = connections.get(workerId);
  const snapshot = await environment.snapshot();
  const worker = snapshot.workers.find((w) => w.workerId === workerId);

  if (!worker) throw new ConnectError("Computer not found. Choose another computer.", Code.NotFound);

  if (!connection?.isOpen)
    throw new ConnectError("This computer is offline. Reconnect and try again.", Code.Unavailable);

  if (!(skillId ? worker.conflictSkillImportSupported : worker.localSkillImportSupported))
    throw new ConnectError("Update the worker on this computer to import local skills.", Code.FailedPrecondition);

  const file = worker.report?.skills.find((s) => s.targetId === targetId);
  const skill = skillId ? snapshot.skills.find((entry) => entry.id === skillId) : undefined;
  // Read after the snapshot: a report stored since then still has to list the same copy, while a repeated one is harmless.
  const accepted = environment.skillReports.get(connection);

  if (
    !accepted ||
    accepted.revision !== snapshot.revision ||
    accepted.tokens.get(targetId) !== archiveToken ||
    connections.get(workerId) !== connection ||
    worker.compositionError ||
    !worker.skillsSupported ||
    worker.report?.revision !== snapshot.revision ||
    expectedRevision !== snapshot.revision ||
    !file ||
    file.scope !== "device" ||
    file.skillId !== skillId ||
    file.owned ||
    (skillId
      ? !canPreviewSkillConflict(file) ||
        !worker.skillIds.includes(skillId) ||
        !skill?.deviceHome ||
        !skill.harnesses.includes(file.harness) ||
        skill.artifact?.name !== file.localName ||
        file.version !== (skill.overrides.find((o) => o.workerId === workerId)?.version || skill.version)
      : file.status !== "local") ||
    !archiveToken ||
    archiveToken !== file.archiveToken
  )
    throw stale();

  const result = await connection.sendCommand({
    case: "previewLocalSkill",
    value: { targetId, archiveToken, expectedRevision, skillId },
  });

  if (!connection.isOpen || connections.get(workerId) !== connection) throw stale();

  if (!result.ok || !result.localSkillPreview)
    throw new ConnectError(
      result.errorMessage || "Could not read this skill. Refresh the computer and try again.",
      Code.FailedPrecondition,
    );

  let artifact;

  try {
    artifact = validateSkillFiles(result.localSkillPreview.files);
  } catch {
    throw new ConnectError(
      "This computer returned invalid skill files. Refresh and try again.",
      Code.FailedPrecondition,
    );
  }

  if (skillId && artifact.name !== skill?.artifact?.name)
    throw new ConnectError(
      "The name in SKILL.md must match the library skill’s folder name. Check the local copy and try again.",
      Code.FailedPrecondition,
    );

  return create(ui.PreviewWorkerSkillResponseSchema, { artifact });
}
