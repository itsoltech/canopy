import type { ui } from "@canopy/contracts";
import { assignedWorkers, libraryItemState, type EnvironmentKind } from "@canopy/domain/environment-library";
import { SettingsValue } from "./SettingsValue";

export function EnvironmentItemStatus({
  item,
  workers,
  kind,
  harness,
}: {
  item: { id: string; selector?: ui.EnvironmentSelector; overrides: { workerId: string; disabled: boolean }[] };
  workers: ui.EnvironmentWorker[];
  kind: EnvironmentKind;
  harness?: string;
}) {
  const matching = assignedWorkers(workers, item.selector, item.overrides);
  const status = libraryItemState(workers, item.selector, kind, item.id, item.overrides, harness);

  return (
    <SettingsValue
      title={
        matching.length ? `On ${matching.length} ${matching.length === 1 ? "computer" : "computers"}` : "Not installed"
      }
      value={matching.length ? status : undefined}
      description={matching.map((w) => w.name).join(", ")}
    />
  );
}
