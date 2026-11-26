import { create } from "@bufbuild/protobuf";
import { ui, type EnvironmentSkillStatus } from "@canopy/contracts";
import { environmentSelected } from "./environment-selectors.ts";

export type EnvironmentKind = "instructions" | "skills" | "plugins";

type LibraryItemState = "Not installed" | "Synced" | "Syncing" | "Error" | "Local conflict" | "Kept locally";

const hasSyncError = (file: { status: string }) => ["error", "drift", "kept"].includes(file.status);

const hasCurrentReport = (worker: ui.EnvironmentWorker) =>
  worker.supported && worker.online && worker.report?.revision === worker.desiredRevision;

export function skillSyncReports(worker: ui.EnvironmentWorker, skillId: string) {
  return (worker.report?.skills ?? []).filter((f) => f.skillId === skillId || (!f.skillId && !f.localName));
}

export function canKeepBlockedSkill(file: EnvironmentSkillStatus) {
  return (
    file.status === "error" &&
    file.scope === "device" &&
    !file.owned &&
    Boolean(file.skillId && file.desiredChecksum && file.archiveToken && file.archiveToken === file.observedChecksum)
  );
}

export function isLocalSkillConflict(file: EnvironmentSkillStatus) {
  return (
    !file.owned &&
    Boolean(file.skillId && file.desiredChecksum && file.path) &&
    (file.status === "drift" || canKeepBlockedSkill(file) || (file.status === "error" && file.localLink))
  );
}

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
export function workerSyncState(worker: ui.EnvironmentWorker): "Synced" | "Syncing" | "Error" | "Kept locally" {
  const skills = (worker.report?.skills ?? []).filter((f) => f.skillId || !f.localName);
  const remaining = skills.filter((f) => f.status !== "kept");
  const statuses = [...(worker.report?.files ?? []), ...remaining, ...(worker.report?.plugins ?? [])];

  if (worker.compositionError || statuses.some(hasSyncError)) return "Error";

  if (!hasCurrentReport(worker) || statuses.some((f) => f.status !== "applied")) return "Syncing";

  return remaining.length < skills.length ? "Kept locally" : "Synced";
}

export function libraryItemState(
  workers: readonly ui.EnvironmentWorker[],
  selector: ui.EnvironmentSelector | undefined,
  kind: EnvironmentKind,
  id: string,
  overrides: readonly { workerId: string; disabled: boolean }[] = [],
  harness?: string,
): LibraryItemState {
  const matching = assignedWorkers(workers, selector, overrides);

  if (!matching.length) return "Not installed";

  const states = matching.map((w): LibraryItemState => {
    // Destination errors without a harness or ID apply to the whole report section.
    const skills = kind === "skills" ? skillSyncReports(w, id) : undefined;

    const files =
      kind === "instructions"
        ? (w.report?.files ?? []).filter((f) => !f.harness || f.harness === harness)
        : (skills ?? (w.report?.plugins ?? []).filter((f) => f.skillId === id || (!f.skillId && !f.localName)));

    const settled = (f: { status: string }) => f.status === "applied" || (!!skills && f.status === "kept");

    if (skills?.some(isLocalSkillConflict)) return "Local conflict";

    if (files.some((f) => hasSyncError(f) && !settled(f))) return "Error";

    if (w.compositionError || !hasCurrentReport(w) || !files.length || !files.every(settled)) return "Syncing";

    return skills?.some((f) => f.status === "kept") ? "Kept locally" : "Synced";
  });

  return (
    (["Local conflict", "Error", "Syncing", "Kept locally"] as const).find((state) => states.includes(state)) ??
    "Synced"
  );
}

export function librarySummary(snapshot: ui.AgentEnvironmentSnapshot, workers = snapshot.workers) {
  const states = snapshot.skills.map((skill) => ({
    skill,
    state: libraryItemState(workers, skill.selector, "skills", skill.id, skill.overrides),
  }));

  const notInstalled = states.filter(({ state }) => state === "Not installed").map(({ skill }) => skill);
  const installed = states.filter(({ state }) => state === "Synced").length;
  const pending = states.filter(({ state }) => state === "Syncing").length;
  const kept = states.filter(({ state }) => state === "Kept locally").length;
  const attention = states.filter(({ state }) => state === "Local conflict" || state === "Error").length;

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
      ? [
          `Skills: ${installed} installed on your computers`,
          pending && `${pending} syncing`,
          kept && `${kept} kept locally`,
          attention && `${attention} with sync issues`,
          `${notInstalled.length} not installed anywhere`,
        ]
          .filter(Boolean)
          .join(" · ")
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
