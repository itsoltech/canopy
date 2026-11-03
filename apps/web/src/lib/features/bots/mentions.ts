import type { ParticipantView } from "./model.ts";
import { MentionKind, type Mention } from "@canopy/contracts";

/** Explicit ids/ranges for user messages, including bots renamed or removed since sending. */
export function structuredMentionRanges(text: string, mentions: readonly Mention[], bots: readonly ParticipantView[]): { start: number; end: number; bot: ParticipantView }[] {
  return mentions.filter((m) => m.kind === MentionKind.BOT && m.start < m.end && m.end <= text.length).sort((a, b) => a.start - b.start).map((m) => ({
    start: m.start, end: m.end,
    bot: bots.find((b) => b.id === m.name) ?? { id: m.name, kind: "bot", name: m.label || text.slice(m.start + 1, m.end) },
  }));
}

/**
 * Where other bots are named in a message (whole words, longest name first, not inside another match), for
 * inline chips. Case-sensitive: "Notes" the bot, not "notes" the word.
 */
export function mentionRanges(text: string, bots: readonly ParticipantView[]): { start: number; end: number; bot: ParticipantView }[] {
  const ranges: { start: number; end: number; bot: ParticipantView }[] = [];
  const word = /[\p{L}\p{N}_]/u;
  for (const bot of [...bots].filter((b) => b.name.trim().length > 1).sort((a, b) => b.name.length - a.name.length)) {
    for (let at = text.indexOf(bot.name); at !== -1; at = text.indexOf(bot.name, at + bot.name.length)) {
      const end = at + bot.name.length;
      if (word.test(text[at - 1] ?? "") || word.test(text[end] ?? "")) continue;
      if (ranges.some((r) => at < r.end && end > r.start)) continue;
      ranges.push({ start: at, end, bot });
    }
  }
  return ranges.sort((a, b) => a.start - b.start);
}
