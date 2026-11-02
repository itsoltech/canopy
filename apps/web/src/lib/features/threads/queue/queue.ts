import { create } from "@bufbuild/protobuf";
import { MentionSchema, PermissionMode, type Mention, type ui } from "@open-agents/contracts";
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
  turns = turns.filter(ownMessage);
  if (!order) return [...turns];
  const byId = new Map(turns.map((t) => [t.id, t]));
  const known = order.flatMap((id) => byId.get(id) ?? []);
  const listed = new Set(order);
  return [...known, ...turns.filter((t) => !listed.has(t.id))];
}

/** The composer queue contains only user messages, never platform input or an agent's report. */
export const ownMessage = (turn: ui.Turn): boolean => turn.trigger === "user" && !turn.sourceKind && !turn.sourceThreadId;

/** A message steered from the queue takes no files: a message with attachments runs as its own turn. */
export const steerable = (turn: ui.Turn): boolean => ownMessage(turn) && turn.attachments.length === 0;

/** The message as the user wrote it (without the platform's note: attachments, mentions, a source). */
export const messageOf = (turn: ui.Turn): string => turn.messageText || turn.inputText;

/** The text a row shows: the message on one line. */
export const queuedText = (turn: ui.Turn): string => messageOf(turn).replace(/\s+/g, " ").trim();

/**
 * The mentions of `before` that are still in `after` (an inline edit is plain text): each chip's text, found again
 * in order, with its new range; a chip whose text was changed or removed is dropped.
 */
export function relocateMentions(before: string, mentions: readonly Mention[], after: string): Mention[] {
  let from = 0;
  return [...mentions]
    .sort((a, b) => a.start - b.start)
    .flatMap((mention) => {
      const token = before.slice(mention.start, mention.end);
      const start = token ? after.indexOf(token, from) : -1;
      if (start < 0) return [];
      from = start + token.length;
      return [create(MentionSchema, { ...mention, start, end: from })];
    });
}

/** The message carries more than its text (files, quotes): it may be sent, and edited, without any. */
export const carriesMore = (turn: ui.Turn): boolean => turn.attachments.length > 0 || turn.quotes.length > 0;

/** What the message runs with instead of the thread's defaults, and what it carries ("GPT-5.5", "High effort", "Read only", "2 files", "1 quote"). */
export function overrides(turn: ui.Turn): string[] {
  const hints: string[] = [];
  if (turn.model) hints.push(modelDisplayName(turn.model));
  if (turn.effort) hints.push(`${effortLevel(turn.effort).label} effort`);
  if (turn.permissionMode !== PermissionMode.UNSPECIFIED) hints.push(permissionLabel(turn.permissionMode));
  if (turn.attachments.length > 0) hints.push(turn.attachments.length === 1 ? "1 file" : `${turn.attachments.length} files`);
  if (turn.quotes.length > 0) hints.push(turn.quotes.length === 1 ? "1 quote" : `${turn.quotes.length} quotes`);
  return hints;
}
