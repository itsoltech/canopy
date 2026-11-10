import type { ui } from "@canopy/contracts";
import { Button } from "../../ui/components";
import { SettingsRow } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { EnvironmentItemStatus } from "./EnvironmentItemStatus";

export function EnvironmentPluginRow({
  candidate,
  assignment,
  workers,
  onReview,
}: {
  candidate: ui.MarketplacePlugin;
  assignment?: ui.LibrarySkill;
  workers: ui.EnvironmentWorker[];
  onReview: () => void;
}) {
  return (
    <SettingsRow
      title={assignment?.name || candidate.artifact?.name || "Plugin"}
      description={candidate.unavailableReason || candidate.harnesses.filter(Boolean).join(" · ")}
    >
      {assignment ? (
        <EnvironmentItemStatus item={assignment} workers={workers} kind="plugins" />
      ) : (
        !candidate.unavailableReason && <SettingsValue title="Status" value="Review required" />
      )}
      <Button
        title={assignment ? "Edit plugin" : "Review"}
        variant={assignment ? "secondary" : "primary"}
        disabled={!!candidate.unavailableReason}
        onPress={onReview}
      />
    </SettingsRow>
  );
}
