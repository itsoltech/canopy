import { PermissionMode, type ui } from "@open-agents/contracts";
import { effortLevel, modelDisplayName } from "#lib/features/models/catalog.ts";
import { permissionLabel } from "../labels.ts";

/**
 * The queue panel's pure parts (docs/ui-api.md, "Kolejka"): the order shown while a change is on its way, moves,
 * and what a queued message overrides.
 */

/** `ids` with `id` at `index` (clamped). */
export function moveTo(ids: readonly string[], id: string, index: number): string[] {
  const rest = ids.filter((x) => x !== id);
  if (rest.length === ids.length) return [...ids];
  const at = Math.max(0, Math.min(index, rest.length));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * The queued turns in the local order while a reorder is on its way (`order`); turns it does not know (queued
 * meanwhile) follow in the gateway's order, turns that left the queue drop out.
 */
export function ordered(turns: readonly ui.Turn[], order: readonly string[] | undefined): ui.Turn[] {
  if (!order) return [...turns];
  const byId = new Map(turns.map((t) => [t.id, t]));
  const known = order.flatMap((id) => byId.get(id) ?? []);
  const listed = new Set(order);
  return [...known, ...turns.filter((t) => !listed.has(t.id))];
}

/** Only the user's own messages are edited, deleted or steered; every queued turn can be moved. */
export const ownMessage = (turn: ui.Turn): boolean => turn.trigger === "user";

/** A message steered from the queue takes no files: a message with attachments runs as its own turn. */
export const steerable = (turn: ui.Turn): boolean => ownMessage(turn) && turn.attachments.length === 0;

/** The text a row shows: the message without the platform's note (attachments, a source). */
export const queuedText = (turn: ui.Turn): string => (turn.messageText || turn.inputText).replace(/\s+/g, " ").trim();

/** What the message runs with instead of the thread's defaults ("GPT-5.5", "High effort", "Read only", "2 files"). */
export function overrides(turn: ui.Turn): string[] {
  const hints: string[] = [];
  if (turn.model) hints.push(modelDisplayName(turn.model));
  if (turn.effort) hints.push(`${effortLevel(turn.effort).label} effort`);
  if (turn.permissionMode !== PermissionMode.UNSPECIFIED) hints.push(permissionLabel(turn.permissionMode));
  if (turn.attachments.length > 0) hints.push(turn.attachments.length === 1 ? "1 file" : `${turn.attachments.length} files`);
  return hints;
}
