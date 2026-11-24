import type { ui } from "@canopy/contracts";
import { assignedWorkers, libraryItemState, type EnvironmentKind } from "@canopy/domain/environment-library";

export function environmentItemStatus(
  item: { id: string; selector?: ui.EnvironmentSelector; overrides: { workerId: string; disabled: boolean }[] },
  workers: ui.EnvironmentWorker[],
  kind: EnvironmentKind,
  harness?: string,
) {
  const matching = assignedWorkers(workers, item.selector, item.overrides);
  const status = libraryItemState(workers, item.selector, kind, item.id, item.overrides, harness);
  const count = matching.length;
  const computers = count ? `On ${count} ${count === 1 ? "computer" : "computers"}` : undefined;
  const note = count ? `${status} · ${computers}\n${matching.map((worker) => worker.name).join(", ")}` : status;

  return { status, computers, note };
}
