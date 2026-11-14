import type { ui } from "@canopy/contracts";
import { configFieldLabel, configItemValue, configNoticeValue } from "./config-notice-values.ts";

/** Shared copy for configuration history and choices. Clients format time using their clock preferences. */
export function configNotice(
  notice: ui.ConfigNotice,
  time: string,
  { named = true, library = false }: { named?: boolean; library?: boolean } = {},
) {
  const item = notice.kind !== "settings";
  const removed = item && notice.reason === "deleted" && notice.field === "deleted";
  const choice = notice.reason === "choice";
  const lost = notice.reason === "merged" || notice.reason === "concurrent";

  const title = removed
    ? notice.itemName || "Deleted item"
    : item && named && notice.itemName
      ? `${notice.itemName}: ${configFieldLabel(notice.field, notice.kind)}`
      : configFieldLabel(notice.field, notice.kind);

  const message = choice
    ? `${notice.nodeName} has a different value. Choose which to keep.`
    : removed
      ? `Deleted on ${notice.nodeName} at ${time}.`
      : notice.reason === "merged"
        ? `${notice.ownValue ? "Replaced" : "Not used"} when this computer linked with ${notice.nodeName}.`
        : notice.reason === "resurrected"
          ? `${notice.nodeName} changed it after it was deleted here.`
          : `${notice.nodeName} also changed this at ${time}.`;

  const shown = removed ? "" : item ? configItemValue(notice.field, notice.value) : configNoticeValue(notice.value);

  return {
    title,
    message,
    value: lost && shown ? `${notice.ownValue ? "This computer’s value" : "Other value"}: ${shown}` : shown,
    restore:
      choice || (lost && !notice.ownValue)
        ? "Use the other’s"
        : lost
          ? "Restore this computer’s"
          : notice.reason === "resurrected"
            ? "Delete"
            : library && removed
              ? "Keep"
              : "Restore",
    dismiss: choice
      ? "Keep this computer’s"
      : lost
        ? "Keep current"
        : library && removed
          ? "Accept deletion"
          : "Dismiss",
  };
}
