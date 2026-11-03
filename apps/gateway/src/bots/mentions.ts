import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, type Mention } from "@canopy/contracts";
import { joinNotes, quotesNote } from "@canopy/domain";
import type { StoredQuote } from "../store/quotes.ts";

/** Validated at enqueue; keep the original text/ranges in storage and add identity only for the model. */
export const storedMentions = (value: JsonValue[]): Mention[] => value.map((m) => fromJson(MentionSchema, m));

export function modelInput(text: string, mentions: readonly Mention[], quotes: readonly StoredQuote[]): string {
  const quoted = joinNotes(quotesNote(quotes), text);
  if (!mentions.length) return quoted;
  const unique = [...new Map(mentions.map((m) => [m.name, m])).values()];
  const bots = unique.filter((m) => m.kind === MentionKind.BOT);
  const connectors = unique.filter((m) => m.kind === MentionKind.CONNECTOR);
  return [quoted, bots.length ? `Mentioned bots (use send_bot_message with the exact bot_id):\n${bots.map((m) => `- ${JSON.stringify(m.label)} (bot_id ${m.name})`).join("\n")}` : "",
    connectors.length ? `Mentioned connector accounts (use the provided tools for these accounts; a mention grants no additional access):\n${connectors.map((m) => `- ${JSON.stringify(m.label)} (account_id ${m.name})`).join("\n")}` : ""].filter(Boolean).join("\n\n");
}
