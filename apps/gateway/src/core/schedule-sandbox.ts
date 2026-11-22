import { PermissionMode, type SandboxProfileBinding, type ui } from "@canopy/contracts";
import { scheduleWorkerEligible } from "@canopy/domain";
import { coreWorkers } from "./core-providers.ts";
import { InvalidError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { checkSandboxPlacement, ownerSandboxBinding, SANDBOX_MODE_REQUIRED } from "./thread-sandbox.ts";

export async function scheduleSandboxSelection(
  core: GatewayCore,
  spec: ui.NewThreadSchedule,
  previous: ui.NewThreadSchedule | undefined,
  owner: boolean,
): Promise<SandboxProfileBinding | undefined> {
  const { sandboxProfileId: selected, sandboxProfile: supplied } = spec;
  const existing = previous?.sandboxProfile;

  if (
    selected === undefined &&
    previous?.sandboxProfileId &&
    (!existing?.digest || existing.profile?.id !== previous.sandboxProfileId)
  )
    throw new InvalidError("This schedule has no saved sandbox profile for its selection.");

  if (!owner && selected !== undefined)
    throw new InvalidError("Only the owner can select a sandbox profile for a schedule.");

  // The snapshot in a request is read-only. A protobuf client can echo the schedule it just read.
  if (supplied && !selected && !existing) throw new InvalidError("Select a sandbox profile by ID.");

  const id = selected ?? existing?.profile?.id;

  if (!id) return;

  if (spec.permissionMode !== PermissionMode.FULL_AUTO) throw new InvalidError(SANDBOX_MODE_REQUIRED);

  if (id === existing?.profile?.id) return existing;

  return ownerSandboxBinding(core, id);
}

export async function confirmScheduleSandboxWorker(core: GatewayCore, workerId: string, spec: ui.NewThreadSchedule) {
  if (!spec.sandboxProfile) return;

  try {
    return await checkSandboxPlacement(core, workerId, spec.provider, spec.providerProfileId, spec.sandboxProfile);
  } catch (error) {
    if (!(error instanceof InvalidError)) throw error;

    return undefined;
  }
}

export async function eligibleScheduleWorkers(core: GatewayCore, spec: ui.NewThreadSchedule) {
  const bound = Boolean(spec.sandboxProfile);

  const candidates = (await coreWorkers(core)).filter((worker) =>
    scheduleWorkerEligible(worker, spec, bound || spec.placement !== "specific"),
  );

  if (!bound) return candidates.map((worker) => worker.id);

  const confirmed = await Promise.all(
    candidates.map(async ({ id }) =>
      (await confirmScheduleSandboxWorker(core, id, spec)) === undefined ? undefined : id,
    ),
  );

  return confirmed.filter((id) => id !== undefined);
}
