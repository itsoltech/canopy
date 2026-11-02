import { expect, test } from "bun:test";
import { mentionRanges } from "./mentions.ts";

test("bot names become mentions as whole words, the longest name winning", () => {
  const crm = { id: "crm", kind: "bot" as const, name: "FIXme CRM" };
  const fix = { id: "fix", kind: "bot" as const, name: "FIXme" };
  const notes = { id: "notes", kind: "bot" as const, name: "Notes" };
  const text = "Ask FIXme CRM, then FIXme. Notesy and notes are not Notes.";
  expect(mentionRanges(text, [fix, crm, notes]).map((r) => [text.slice(r.start, r.end), r.bot.id])).toEqual([["FIXme CRM", "crm"], ["FIXme", "fix"], ["Notes", "notes"]]);
});
