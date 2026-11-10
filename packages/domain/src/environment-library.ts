import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { environmentSelected } from "./environment-selectors.ts";

export type EnvironmentKind = "instructions" | "skills" | "plugins";

/** Records keep linked destinations visible even when their home cannot report its files. */
export function libraryWorkers(local: readonly ui.EnvironmentWorker[], records: readonly ui.WorkerRecord[]) {
  return [
    ...local,
    ...records.flatMap((r) =>
      r.revoked || local.some((w) => w.workerId === r.workerId.split("~")[0])
        ? []
        : [
            create(ui.EnvironmentWorkerSchema, {
              workerId: r.workerId.split("~")[0] ?? r.workerId,
              name: `${r.name} · ${r.computerName}`,
              manualTags: r.manualTags,
              automaticTags: r.automaticTags,
              supported: true,
              skillsSupported: true,
              pluginsSupported: true,
            }),
          ],
    ),
  ];
}

export function assignedWorkers(
  workers: readonly ui.EnvironmentWorker[],
  selector?: ui.EnvironmentSelector,
  overrides: readonly { workerId: string; disabled: boolean }[] = [],
) {
  return workers.filter(
    (w) => environmentSelected(selector, w) && !overrides.some((o) => o.workerId === w.workerId && o.disabled),
  );
}

/** One vocabulary for library rows and Computers & preview; missing reports never mean success. */
export function workerSyncState(worker: ui.EnvironmentWorker): "Synced" | "Syncing" | "Error" {
  const statuses = [
    ...(worker.report?.files ?? []),
    ...(worker.report?.skills ?? []),
    ...(worker.report?.plugins ?? []),
  ];

  if (worker.compositionError || statuses.some((f) => ["error", "drift", "kept"].includes(f.status))) return "Error";

  if (
    !worker.supported ||
    !worker.online ||
    !worker.report ||
    worker.report.revision !== worker.desiredRevision ||
    statuses.some((f) => f.status !== "applied")
  )
    return "Syncing";

  return "Synced";
}

export function libraryItemState(
  workers: readonly ui.EnvironmentWorker[],
  selector: ui.EnvironmentSelector | undefined,
  kind: EnvironmentKind,
  id: string,
  overrides: readonly { workerId: string; disabled: boolean }[] = [],
  harness?: string,
): "Not installed" | "Synced" | "Syncing" | "Error" {
  const matching = assignedWorkers(workers, selector, overrides);

  if (!matching.length) return "Not installed";

  const states = matching.map((w) => {
    if (workerSyncState(w) === "Error") return "Error";

    const files =
      kind === "instructions"
        ? (w.report?.files ?? []).filter((f) => f.harness === harness)
        : (w.report?.[kind] ?? []).filter((f) => f.skillId === id);

    return workerSyncState(w) === "Synced" && files.length && files.every((f) => f.status === "applied")
      ? "Synced"
      : "Syncing";
  });

  return states.includes("Error") ? "Error" : states.every((s) => s === "Synced") ? "Synced" : "Syncing";
}

export function librarySummary(snapshot: ui.AgentEnvironmentSnapshot, workers = snapshot.workers) {
  const notInstalled = snapshot.skills.filter((s) => !assignedWorkers(workers, s.selector, s.overrides).length);

  const installed = snapshot.skills.filter(
    (s) => libraryItemState(workers, s.selector, "skills", s.id, s.overrides) === "Synced",
  ).length;

  const pending = snapshot.skills.length - notInstalled.length - installed;

  const review = snapshot.marketplaces.reduce(
    (count, market) =>
      count +
      market.plugins.filter(
        (p) =>
          !p.unavailableReason &&
          !snapshot.plugins.some(
            (saved) => saved.marketplaceId === market.id && saved.assignment?.artifact?.name === p.artifact?.name,
          ),
      ).length,
    0,
  );

  return {
    notInstalled,
    skills: snapshot.skills.length
      ? `Skills: ${installed} installed on your computers${pending ? ` · ${pending} assigned, not yet synced` : ""} · ${notInstalled.length} not installed anywhere`
      : "Skills: none yet",
    plugins: review
      ? `Plugins: ${review} waiting for review`
      : snapshot.plugins.length
        ? `Plugins: ${snapshot.plugins.length} reviewed`
        : "Plugins: none yet",
    instructions: snapshot.documents.length
      ? `Instructions: ${snapshot.documents.length} in your library`
      : "Instructions: none yet",
  };
}
