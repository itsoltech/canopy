import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import { MentionSchema, type Mention } from "@open-agents/contracts";

/** Validated at enqueue; keep the original text/ranges in storage and add identity only for the model. */
export const storedMentions = (value: JsonValue[]): Mention[] => value.map((m) => fromJson(MentionSchema, m));

export function modelInput(text: string, mentions: readonly Mention[]): string {
  if (!mentions.length) return text;
  const unique = [...new Map(mentions.map((m) => [m.name, m])).values()];
  return `${text}\n\nMentioned bots (use send_bot_message with the exact bot_id):\n${unique.map((m) => `- ${JSON.stringify(m.label)} (bot_id ${m.name})`).join("\n")}`;
}
