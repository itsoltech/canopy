import type { ui } from "@canopy/contracts";

/**
 * The composer queue's pure parts on web and mobile (docs/ui-api.md, "Kolejka"): which turns it holds, the order
 * shown while a change is on its way, and moves.
 */

/** The composer queue contains only user messages, never platform input or an agent's report. */
export const ownMessage = (turn: ui.Turn): boolean =>
  turn.trigger === "user" && !turn.sourceKind && !turn.sourceThreadId;

/** A turn waiting in the queue: not started by the gateway yet (a dispatched one is already on the timeline). */
export const waitingTurn = (turn: ui.Turn): boolean => turn.status === "queued" && !turn.dispatched;

/** The message as the user wrote it (without the platform's note: attachments, mentions, a source). */
export const messageOf = (turn: ui.Turn): string => turn.messageText || turn.inputText;

/** The message carries more than its text (files, quotes): it may be sent, and edited, without any. */
export const carriesMore = (turn: ui.Turn): boolean => turn.attachments.length > 0 || turn.quotes.length > 0;

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
  turns = turns.filter((t) => waitingTurn(t) && ownMessage(t));

  if (!order) return [...turns];
  const byId = new Map(turns.map((t) => [t.id, t]));
  const known = order.flatMap((id) => byId.get(id) ?? []);
  const listed = new Set(order);

  return [...known, ...turns.filter((t) => !listed.has(t.id))];
}
