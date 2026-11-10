import { PermissionMode, type ui } from "@canopy/contracts";
import { messageOf } from "@canopy/domain/queue";
import { readableText } from "#lib/features/mentions/editor.ts";
import { effortLevel, modelDisplayName } from "#lib/features/models/catalog.ts";
import { permissionLabel } from "../labels.ts";

/**
 * The queue panel's web parts (docs/ui-api.md, "Kolejka"): the text a row shows and what a queued message
 * overrides. The order and moves are shared with mobile (`@canopy/domain/queue`).
 */

export { carriesMore, messageOf, moveTo, ordered, ownMessage } from "@canopy/domain/queue";

/** The text a row shows: the message on one line, each chip (a file's badge, a mention) as its name. */
export const queuedText = (turn: ui.Turn): string =>
  (turn.messageText ? readableText({ text: turn.messageText, mentions: turn.mentions }) : messageOf(turn))
    .replace(/\s+/g, " ")
    .trim();

/** What the message runs with instead of the thread's defaults, and what it carries ("GPT-5.5", "High effort", "Read only", "2 files", "1 quote"). */
export function overrides(turn: ui.Turn): string[] {
  const hints: string[] = [];

  if (turn.model) hints.push(modelDisplayName(turn.model));

  if (turn.effort) hints.push(`${effortLevel(turn.effort).label} effort`);

  if (turn.permissionMode !== PermissionMode.UNSPECIFIED) hints.push(permissionLabel(turn.permissionMode));

  if (turn.attachments.length > 0)
    hints.push(turn.attachments.length === 1 ? "1 file" : `${turn.attachments.length} files`);

  if (turn.quotes.length > 0) hints.push(turn.quotes.length === 1 ? "1 quote" : `${turn.quotes.length} quotes`);

  return hints;
}
