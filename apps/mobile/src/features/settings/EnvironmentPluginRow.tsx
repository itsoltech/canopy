import type { ui } from "@canopy/contracts";
import { EnvironmentActionMenu } from "./EnvironmentActionMenu";
import { EnvironmentRow } from "./EnvironmentRows";
import { environmentItemStatus } from "./environment-item-status";

export function EnvironmentPluginRow({
  candidate,
  assignment,
  workers,
  missing,
  onReview,
}: {
  candidate: ui.MarketplacePlugin;
  assignment?: ui.LibrarySkill;
  workers: ui.EnvironmentWorker[];
  missing?: boolean;
  onReview: () => void;
}) {
  const title = assignment?.name || candidate.artifact?.name || "Plugin";
  const assigned = assignment && environmentItemStatus(assignment, workers, "plugins");
  const unavailable = candidate.unavailableReason;

  const description =
    unavailable ||
    (missing
      ? "No longer in the catalog. The approved version is still available."
      : [assigned?.computers, ...candidate.harnesses].filter(Boolean).join(" · "));

  return (
    <EnvironmentRow
      title={title}
      description={description}
      wrapDescription={!!unavailable || missing}
      status={unavailable ? "Unavailable" : (assigned?.status ?? "Review required")}
      warning={!!unavailable || assigned?.status === "Error"}
      onPress={unavailable ? undefined : onReview}
      actions={
        assigned &&
        !unavailable && (
          <EnvironmentActionMenu
            title={title}
            label={`Actions for ${title}`}
            note={assigned.note}
            actions={[{ label: "Edit plugin", icon: "pencil-square", onPress: onReview }]}
          />
        )
      }
    />
  );
}
