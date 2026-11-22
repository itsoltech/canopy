import type { SandboxProfile, SandboxProfileBinding, ui } from "@canopy/contracts";
import { scheduleWorkerEligible } from "@canopy/domain";
import type { PickerOption } from "../../ui/Picker";
import { sandboxProfileLabel } from "../threads/sandbox";

const harnessDefault = "Harness default";

export function scheduledSandboxLabel(binding?: SandboxProfileBinding): string {
  return binding ? sandboxProfileLabel(binding) : `Sandbox - ${harnessDefault}`;
}

function sandboxSelectionId(id: string, saved?: SandboxProfile): string | undefined {
  return id === saved?.id ? undefined : id || (saved ? "" : undefined);
}

export function scheduleThreadWorkers(
  project: ui.Project | undefined,
  workers: readonly ui.Worker[],
  spec: ui.NewThreadSchedule,
) {
  return workers.filter((worker) =>
    project?.workspaces.some(
      (workspace) =>
        workspace.workerId === worker.id && (spec.placement !== "specific" || workspace.id === spec.workspaceId),
    ),
  );
}

function workerProblem(worker: ui.Worker, spec: ui.NewThreadSchedule, profile: SandboxProfile): string | undefined {
  if (!worker.online) return "The worker is offline.";

  if (worker.configVersion !== worker.appliedVersion)
    return "Wait for the worker to report sandbox support for its current settings.";

  const report = worker.profiles.find(
    (entry) => entry.id === (spec.providerProfileId || "native") && entry.providers.includes(spec.provider),
  );

  if (report && !report.available) return report.detail || "The selected agent instance is unavailable.";

  if (!scheduleWorkerEligible(worker, spec)) return "The selected agent is unavailable.";

  const support = report?.sandboxSupport;

  if (!support)
    return worker.os === "win32"
      ? "This native Windows worker has not reported custom sandbox support. Check a worker running inside WSL2."
      : "The selected agent instance has not reported custom sandbox support.";

  if (profile.allowedDomains.length)
    return support.domains
      ? undefined
      : support.domainsReason || "The agent cannot restrict commands to these domains.";

  return support.offline ? undefined : support.offlineReason || "The agent cannot run commands offline in its sandbox.";
}

function placementProblem(workers: readonly ui.Worker[], spec: ui.NewThreadSchedule, profile: SandboxProfile) {
  if (!spec.provider) return "Choose an agent to check sandbox support.";

  if (spec.placement === "specific") {
    const worker = workers[0];

    return worker ? workerProblem(worker, spec, profile) : "Choose a workspace to check sandbox support.";
  }

  const eligible = workers.filter((worker) => !worker.nodeId && scheduleWorkerEligible(worker, spec));

  if (!eligible.length) return "No worker in this pool can run the selected agent right now.";
  const reasons = eligible.map((worker) => workerProblem(worker, spec, profile));

  if (reasons.some((reason) => reason === undefined)) return undefined;

  return reasons.every((reason) => reason === reasons[0])
    ? reasons[0]
    : "No eligible worker in this pool supports this profile.";
}

export function scheduleSandboxChoices({
  spec,
  workers,
  profiles,
  saved,
  template,
}: {
  spec: ui.NewThreadSchedule;
  workers: readonly ui.Worker[];
  profiles: readonly SandboxProfile[];
  saved?: SandboxProfile;
  template?: SandboxProfile;
}) {
  const value = spec.sandboxProfileId ?? saved?.id ?? "";
  const catalog = saved ? [saved, ...profiles.filter((profile) => profile.id !== saved.id)] : profiles;
  const linkedWorker = spec.placement === "specific" && Boolean(workers[0]?.nodeId);

  const options: PickerOption<string>[] = [
    { value: "", label: scheduledSandboxLabel(), description: "Uses the agent’s standard sandbox." },
  ];

  let problem: string | undefined;
  let blocked = false;

  for (const profile of catalog) {
    const count = profile.allowedDomains.length;
    const preserves = profile.id === saved?.id;

    const reason =
      linkedWorker && !preserves
        ? "Choose a new profile on the linked computer."
        : placementProblem(workers, spec, profile);

    if (value === profile.id && reason) {
      problem = preserves ? `${reason} The task keeps its saved profile.` : reason;
      blocked = !preserves;
    }

    options.push({
      value: profile.id,
      label: `Sandbox - ${profile.name}`,
      description: reason ?? (count ? `${count} ${count === 1 ? "domain" : "domains"}` : "Offline"),
      disabled: Boolean(reason) && !preserves,
      wrapLabel: true,
    });
  }

  if (value && !catalog.some((profile) => profile.id === value)) {
    problem = "This profile is unavailable. Choose another profile.";
    blocked = true;
    options.push({
      value,
      label: `Sandbox - ${template?.id === value ? template.name : "Unavailable profile"}`,
      description: problem,
      disabled: true,
      wrapLabel: true,
    });
  }

  return { value, options, problem, blocked, selectionId: (id: string) => sandboxSelectionId(id, saved) };
}

export type ScheduleSandboxChoices = ReturnType<typeof scheduleSandboxChoices>;
