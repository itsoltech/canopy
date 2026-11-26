import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { validateSkillFiles } from "@canopy/domain/skill-artifact";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AgentEnvironment } from "./service.ts";

const stale = () =>
  new ConnectError("This skill copy changed. Refresh the computer and try again.", Code.FailedPrecondition);

export async function previewWorkerSkill(environment: AgentEnvironment, request: ui.PreviewWorkerSkillRequest) {
  const { workerId, targetId, archiveToken, expectedRevision } = request;
  const connections = environment.options.link.connections;
  const connection = connections.get(workerId);
  const accepted = connection && environment.skillReports.get(connection);
  const snapshot = await environment.snapshot();
  const worker = snapshot.workers.find((w) => w.workerId === workerId);

  if (!worker) throw new ConnectError("Computer not found. Choose another computer.", Code.NotFound);

  if (!connection?.isOpen)
    throw new ConnectError("This computer is offline. Reconnect and try again.", Code.Unavailable);

  if (!worker.localSkillImportSupported)
    throw new ConnectError("Update the worker on this computer to import local skills.", Code.FailedPrecondition);

  const file = worker.report?.skills.find((s) => s.targetId === targetId);

  if (
    !accepted ||
    accepted !== environment.skillReports.get(connection) ||
    connections.get(workerId) !== connection ||
    worker.compositionError ||
    !worker.skillsSupported ||
    worker.report?.revision !== snapshot.revision ||
    expectedRevision !== snapshot.revision ||
    !file ||
    file.scope !== "device" ||
    file.status !== "local" ||
    file.owned ||
    file.skillId ||
    !archiveToken ||
    archiveToken !== file.archiveToken
  )
    throw stale();

  const result = await connection.sendCommand({
    case: "previewLocalSkill",
    value: { targetId, archiveToken, expectedRevision },
  });

  if (!connection.isOpen || connections.get(workerId) !== connection) throw stale();

  if (!result.ok || !result.localSkillPreview)
    throw new ConnectError(
      result.errorMessage || "Could not read this skill. Refresh the computer and try again.",
      Code.FailedPrecondition,
    );

  try {
    return create(ui.PreviewWorkerSkillResponseSchema, {
      artifact: validateSkillFiles(result.localSkillPreview.files),
    });
  } catch {
    throw new ConnectError(
      "This computer returned invalid skill files. Refresh and try again.",
      Code.FailedPrecondition,
    );
  }
}
