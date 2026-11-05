import { create } from "@bufbuild/protobuf";
import { MentionSchema, type Mention } from "@canopy/contracts";

/**
 * The mentions of `before` that are still in `after`, for an edit made as plain text (an older client's queue edit):
 * each mention's text found again in order, with its new range; one whose text was changed or removed is dropped.
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
