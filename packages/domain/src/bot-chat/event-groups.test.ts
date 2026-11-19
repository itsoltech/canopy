import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { bots } from "@canopy/contracts";
import { botEntries } from "./entries.ts";
import { ChatEventGroups, visibleChatRows } from "./event-groups.ts";
import { layoutChat } from "./layout.ts";

test("an open activity group keeps its header across paging and live updates, with pending approvals visible", () => {
  const time = (minute: number) => timestampFromDate(new Date(Date.UTC(2026, 10, 19, 10, minute)));

  const event = (id: string, minute: number) =>
    create(bots.BotMessageSchema, { id, kind: "event", senderId: "activity", createdAt: time(minute) });

  const snapshot = create(bots.BotConversationSchema, {
    messages: [event("slack", 2), event("routine", 6)],
    approvals: [
      { id: "allowed", status: "approved", allowedByRule: { id: "rule" }, createdAt: time(3) },
      { id: "pending", status: "pending", createdAt: time(5) },
    ],
  });

  const groups = new ChatEventGroups();

  const layout = (conversation: bots.BotConversation) =>
    groups.layout(layoutChat({ entries: botEntries(conversation), participants: new Map(), me: "me", kind: "direct" }));

  const initial = layout(snapshot);
  expect(initial.map((row) => row.id)).toEqual(["date:slack", "events:slack", "pending", "routine"]);

  const updated = layout({
    ...snapshot,
    messages: [event("earlier", 1), ...snapshot.messages, event("reply", 4), event("later", 7)],
  });

  expect(visibleChatRows(updated, new Set(["events:slack"])).map((row) => row.id)).toEqual([
    "date:earlier",
    "events:slack",
    "earlier",
    "slack",
    "allowed",
    "reply",
    "pending",
    "events:routine",
  ]);
  expect(visibleChatRows(updated, new Set()).map((row) => row.id)).toEqual([
    "date:earlier",
    "events:slack",
    "pending",
    "events:routine",
  ]);
});
