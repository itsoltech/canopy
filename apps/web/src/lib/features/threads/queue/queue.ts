import { PermissionMode, type ui } from "@canopy/contracts";
import { effortLevel, modelDisplayName } from "#lib/features/models/catalog.ts";
import { permissionLabel } from "../labels.ts";

/**
 * The queue panel's web parts (docs/ui-api.md, "Kolejka"): the text a row shows and what a queued message
 * overrides. The order and moves are shared with mobile (`@canopy/domain/queue`).
 */

export { carriesMore, messageOf, moveTo, ordered, ownMessage } from "@canopy/domain/queue";

/** What the message runs with instead of the thread's defaults. Content has its own compact summary. */
export function overrides(turn: ui.Turn): string[] {
  const hints: string[] = [];

  if (turn.model) hints.push(modelDisplayName(turn.model));

  if (turn.effort) hints.push(`${effortLevel(turn.effort).label} effort`);

  if (turn.permissionMode !== PermissionMode.UNSPECIFIED) hints.push(permissionLabel(turn.permissionMode));

  return hints;
}
