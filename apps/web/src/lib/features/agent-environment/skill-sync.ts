import { create } from "@bufbuild/protobuf";
import { ui, type EnvironmentSkillStatus } from "@canopy/contracts";
import { isLocalSkillConflict, skillSyncReports } from "@canopy/domain/environment-library";
import { encode } from "#lib/shared/wire.ts";
import { awaitingArchive, needsAttention } from "./computer-skills.ts";
import type { EnvironmentState } from "./environment-state.svelte.ts";

export interface SyncComputer {
  worker: ui.EnvironmentWorker;
  files: EnvironmentSkillStatus[];
}

export function skillIssues(workers: readonly ui.EnvironmentWorker[], id: string): SyncComputer[] {
  const groups = workers.flatMap((worker) => {
    const files = skillSyncReports(worker, id).filter((file) => needsAttention(file) || file.status === "kept");

    return files.length ? [{ worker, files }] : [];
  });

  // A decision to keep a copy applies until the user explicitly reopens it.
  if (!groups.some(({ files }) => files.some(needsAttention))) return groups;

  return groups.flatMap(({ worker, files }) => {
    const unresolved = files.filter(needsAttention);

    return unresolved.length ? [{ worker, files: unresolved }] : [];
  });
}

export function currentReport(worker: ui.EnvironmentWorker, revision: bigint) {
  return (
    worker.online &&
    worker.supported &&
    worker.skillsSupported &&
    !worker.compositionError &&
    worker.report?.revision === revision &&
    worker.desiredRevision === revision
  );
}

export function archiveGroups(issues: readonly SyncComputer[], revision: bigint): SyncComputer[] {
  return issues.flatMap(({ worker, files }) => {
    if (!currentReport(worker, revision) || !worker.skillReportId) return [];

    const eligible = files.filter(
      (file) =>
        (isLocalSkillConflict(file) || file.status === "kept") &&
        !file.owned &&
        file.skillId &&
        file.archiveToken &&
        file.desiredChecksum,
    );

    return eligible.length ? [{ worker, files: eligible }] : [];
  });
}

export function sameArchiveGroup(reviewed: SyncComputer, groups: readonly SyncComputer[]) {
  const group = groups.find(({ worker }) => worker.workerId === reviewed.worker.workerId);

  return (
    group?.worker.skillReportId === reviewed.worker.skillReportId &&
    group.files.length === reviewed.files.length &&
    reviewed.files.every((file) =>
      group.files.some(
        (f) =>
          f.targetId === file.targetId &&
          f.archiveToken === file.archiveToken &&
          f.desiredChecksum === file.desiredChecksum,
      ),
    )
  );
}

export function useLibraryVersion(
  environment: EnvironmentState,
  skillId: string,
  group: SyncComputer,
  revision: bigint,
) {
  const request = create(ui.UseLibrarySkillVersionRequestSchema, {
    workerId: group.worker.workerId,
    reportId: group.worker.skillReportId,
    skillId,
    expectedRevision: revision,
    targets: group.files.map((file) => ({ targetId: file.targetId, archiveToken: file.archiveToken })),
  });

  return environment.mutate("POST", "/skills/use-version", encode(ui.UseLibrarySkillVersionRequestSchema, request));
}

export function archiveOutcome(worker: ui.EnvironmentWorker | undefined, requested: EnvironmentSkillStatus) {
  if (!worker || !currentReport(worker, worker.desiredRevision)) return "Waiting for computer";
  const file = worker.report?.skills.find((f) => f.targetId === requested.targetId);

  if (file && awaitingArchive(file, requested)) return "Syncing";

  if (file?.status === "applied" && file.owned && file.skillId === requested.skillId) return "Installed";

  if (file?.status === "removed" || (!file && worker.report?.skillInventoryScanned)) return "No longer installed";

  return "Check this location";
}

export function recordArchives(history: readonly SyncComputer[], group: SyncComputer): SyncComputer[] {
  const previous = history.find(({ worker }) => worker.workerId === group.worker.workerId);

  const unique = new Map(
    [...(previous?.files ?? []), ...group.files].map((f) => [`${f.targetId}/${f.archiveToken}`, f]),
  );

  return [
    ...history.filter(({ worker }) => worker.workerId !== group.worker.workerId),
    { worker: group.worker, files: [...unique.values()] },
  ];
}
