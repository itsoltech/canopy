import type { ui } from "@open-agents/contracts";

export const PLACEMENTS = ["specific", "any", "least_busy", "round_robin"] as const;
export type Placement = (typeof PLACEMENTS)[number];

/** Shared by the scheduler and UI: configuration plus the worker's last availability report. */
export function scheduleWorkerEligible(worker: ui.Worker, spec: ui.NewThreadSchedule, requireOnline = true): boolean {
  const instance = worker.providerInstances.find((i) => i.harness === spec.provider && i.id === (spec.providerProfileId || "native"));
  return (!requireOnline || worker.online) && !!instance?.enabled && instance.available &&
    worker.providers.some((p) => p.provider === spec.provider && p.available);
}

export interface PlacementCandidate {
  readonly id: string;
  readonly worker_id: string;
  readonly load: number;
}

/** Stable UUID ordering resolves ties and makes the persisted round-robin cursor restart-safe. */
export function selectScheduleWorkspace<T extends PlacementCandidate>(policy: string, candidates: readonly T[], cursor: string | null): T | undefined {
  const sorted = [...candidates].sort((a, b) => a.id.localeCompare(b.id));
  if (policy === "least_busy") return sorted.sort((a, b) => a.load - b.load)[0];
  if (policy === "round_robin") return sorted.find((w) => cursor !== null && w.id > cursor) ?? sorted[0];
  return sorted[0];
}
