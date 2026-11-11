import type { ui } from "@canopy/contracts";
import { appRestartDescription, appRunningTurns } from "@canopy/domain/release/update-actions";
import { confirm } from "../../ui/Confirm";
import { hasUnsentWork } from "./unsent-work";
import type { UpdateRequest } from "./model";

/** The same guard runs before showing confirmation and just before sending the confirmed action. */
export function confirmAppUpdate(
  request: UpdateRequest,
  snapshot: ui.UpdatesSnapshot | undefined,
  threads: readonly ui.Thread[],
  send: (confirmed: UpdateRequest) => void,
  blocked: (message: string) => void,
): boolean {
  if (request.action !== "app" && request.action !== "computer") return false;

  if (request.action === "app" && hasUnsentWork()) {
    blocked("Send or discard your drafts and files before updating this computer.");

    return true;
  }

  if (request.confirmRestart) return false;

  const computer =
    request.action === "computer" ? snapshot?.computers.find((item) => item.nodeId === request.nodeId) : undefined;

  const name = computer?.name || snapshot?.computerName || "This computer";
  confirm({
    title: `Update “${name}”?`,
    description: appRestartDescription(
      name,
      appRunningTurns(threads, (computer?.updates ?? snapshot)?.app?.workerId || ""),
      "phone",
    ),
    confirm: "Update computer",
    action: () => send({ ...request, confirmRestart: true }),
  });

  return true;
}
