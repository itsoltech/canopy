import { Schema } from "effect";

/** Client-local list item identity and offset inside it; never a document scroll offset. */
export const threadScrollPosition = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("following") }),
  Schema.Struct({
    mode: Schema.Literal("anchor"),
    key: Schema.String,
    offset: Schema.Number,
    parent: Schema.optionalKey(Schema.String),
  }),
]);

export type ThreadScrollPosition = typeof threadScrollPosition.Type;

export const savedThreadScroll = Schema.Struct({ threadId: Schema.String, position: threadScrollPosition });

export type SavedThreadScroll = typeof savedThreadScroll.Type;

export const THREAD_SCROLL_LIMIT = 100;

/** Most recently visited last. Saving also touches following threads, so old history anchors expire. */
export function rememberThreadScroll(
  saved: readonly SavedThreadScroll[],
  threadId: string,
  position: ThreadScrollPosition,
): SavedThreadScroll[] {
  return [...saved.filter((entry) => entry.threadId !== threadId), { threadId, position }].slice(-THREAD_SCROLL_LIMIT);
}

/** Missing/out-of-window items use the end; clients reveal folds around a surviving item first. */
export function restoreThreadAnchor(position: ThreadScrollPosition | undefined, keys: readonly string[]) {
  if (position?.mode !== "anchor" || !Number.isFinite(position.offset)) return undefined;
  const index = keys.indexOf(position.parent ?? position.key);

  return index < 0 ? undefined : { index, key: position.key, offset: position.offset };
}

/** Inside the anchor row, or up to `below` px under the top edge (a row that started below it, e.g. the first message). */
export function threadAnchorOffset(offset: number, height: number, below = 0): number {
  return Math.min(Math.max(-Math.max(0, below), offset), Math.max(0, height - 1));
}
