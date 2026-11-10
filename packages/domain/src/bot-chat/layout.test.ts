import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { bots } from "@canopy/contracts";
import { botEntries } from "./entries.ts";
import { layoutChat } from "./layout.ts";
import { entryId, type ChatEntry } from "./model.ts";

const at = (minute: number) => timestampFromDate(new Date(Date.UTC(2026, 10, 10, 8, minute)));

function conversation(approvalCount: number) {
  const messages = Array.from({ length: 50 }, (_, index) =>
    create(bots.BotMessageSchema, {
      id: `message:${index}`,
      botId: "bot",
      seq: BigInt(index + 1),
      senderId: index % 2 ? "bot" : "user",
      recipientId: index % 2 ? "user" : "bot",
      kind: "message",
      text: index === 47 ? "Morning brief from a routine" : `Message ${index}`,
      createdAt: at(index),
    }),
  );

  return create(bots.BotConversationSchema, {
    bot: { id: "bot", configuration: { name: "Learning" }, lastMessage: messages.at(-1) },
    messages,
    // Cards are sent separately from messages, including approvals from bot-started threads.
    approvals: Array.from({ length: approvalCount }, (_, index) => ({
      id: `approval:${index}`,
      botId: "bot",
      threadId: "started-thread",
      kind: "approval",
      prompt: "Needs approval · Bash in “Lesson HTML”",
      status: "approved",
      createdAt: at(10 + index / approvalCount),
    })),
    historyBeforeSeq: 1n,
    historyHasMore: true,
  });
}

const rows = (entries: readonly ChatEntry[]) =>
  layoutChat({ entries, participants: new Map(), me: "me", kind: "direct" });

describe("bot conversation history with forwarded approvals", () => {
  test("the latest window keeps later user, bot and routine messages after a long approval history", () => {
    const snapshot = conversation(105);
    const entries = botEntries(snapshot);
    // Web mounts the last 100 entries before layoutChat groups them.
    const visible = rows(entries.slice(-100));
    const messages = visible.flatMap((row) => (row.kind === "message" ? [row.message.id] : []));
    expect(messages).toContain("message:46");
    expect(messages).toContain("message:47");
    expect(messages).toContain("message:48");
    expect(messages.at(-1)).toBe(snapshot.bot!.lastMessage!.id);
    expect(entryId(entries.at(-1)!)).toBe(snapshot.bot!.lastMessage!.id);
    expect(visible).toHaveLength(101); // 100 entries and their date separator.
  });

  test("mobile's full layout and the web window agree on the last message after approvals resolve", () => {
    const snapshot = conversation(3);
    const pending = { ...snapshot, approvals: snapshot.approvals.map((a) => ({ ...a, status: "pending" })) };
    const before = rows(botEntries(pending));
    const after = rows(botEntries(snapshot));
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(after.at(-1)).toMatchObject({ kind: "message", message: { text: "Message 49" } });
    expect(rows(botEntries(snapshot).slice(-100)).at(-1)).toEqual(after.at(-1));
    expect(new Set(after.map((row) => row.id)).size).toBe(after.length);
  });
});
