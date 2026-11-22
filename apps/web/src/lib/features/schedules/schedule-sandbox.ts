import { type SandboxProfile, type ui } from "@canopy/contracts";
import { scheduleWorkerEligible } from "@canopy/domain";
import { sandboxProfileProblem } from "#lib/features/threads/sandbox-profiles.ts";

export function workerSandboxProblem(
  worker: ui.Worker | undefined,
  spec: ui.NewThreadSchedule,
  profile: SandboxProfile,
) {
  if (!worker) return "Choose a worker to check sandbox support.";

  return sandboxProfileProblem({ worker, provider: spec.provider, profileId: spec.providerProfileId }, profile);
}

export function scheduleSandboxProblem(
  workers: readonly ui.Worker[],
  spec: ui.NewThreadSchedule,
  profile: SandboxProfile,
) {
  if (!spec.provider) return "Choose an agent to check sandbox support.";

  if (spec.placement === "specific") {
    const worker = workers[0];
    const problem = workerSandboxProblem(worker, spec, profile);

    return (
      problem ?? (worker && !scheduleWorkerEligible(worker, spec) ? "The selected agent is unavailable." : undefined)
    );
  }

  const candidates = workers.filter((worker) => scheduleWorkerEligible(worker, spec));

  if (!candidates.length) return "No worker in this pool can run the selected agent right now.";

  const reasons = candidates.map((worker) => workerSandboxProblem(worker, spec, profile));

  if (reasons.some((reason) => !reason)) return undefined;

  return reasons.every((reason) => reason === reasons[0])
    ? reasons[0]
    : "No eligible worker in this pool supports this profile.";
}
