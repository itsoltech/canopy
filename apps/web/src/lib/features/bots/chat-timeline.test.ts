import { expect, test } from "bun:test";
import { dateLineLabel, exchangePhrases, layoutChat, type ChatRow } from "./chat-timeline.ts";
import type { ChatEntry, ParticipantView } from "./model.ts";

const me: ParticipantView = { id: "me", kind: "user", name: "You" };
const kropek: ParticipantView = { id: "kropek", kind: "bot", name: "Kropek" };
const crm: ParticipantView = { id: "crm", kind: "bot", name: "FIXme CRM" };
const notes: ParticipantView = { id: "notes", kind: "bot", name: "Notes" };
const participants = new Map([me, kropek, crm, notes].map((p) => [p.id, p]));
const base = new Date(2026, 10, 2, 11, 46).getTime();
const at = (minutes: number) => new Date(base + minutes * 60_000);
const message = (id: string, senderId: string, minutes: number): ChatEntry => ({ kind: "message", message: { id, senderId, at: at(minutes), text: id } });
const exchange = (id: string, exchangeId: string, counterpartId: string, direction: "sent" | "received", minutes: number): ChatEntry =>
  ({ kind: "exchange", exchange: { id, exchangeId, counterpartId, direction, at: at(minutes) } });
const layout = (entries: ChatEntry[]) => layoutChat({ entries, participants, me: "me", kind: "direct" });
const shape = (rows: ChatRow[]) => rows.map((r) => r.kind === "message" ? `${r.id}:${r.side}${r.first ? "F" : ""}${r.last ? "L" : ""}` : r.kind);

test("messages of one sender close in time form a run: first and last mark the corners and the avatar", () => {
  const rows = layout([message("a", "me", 0), message("b", "me", 1), message("c", "kropek", 2), message("d", "kropek", 3), message("e", "kropek", 4)]);
  expect(shape(rows)).toEqual(["date", "a:endF", "b:endL", "c:startF", "d:start", "e:startL"]);
});

test("a pause of five minutes, another kind of entry or another sender starts a new run", () => {
  const rows = layout([
    message("a", "kropek", 0), message("b", "kropek", 6),
    { kind: "error", error: { id: "x", botId: "kropek", at: at(7), detail: "HTTP 400", retryable: false } },
    message("c", "kropek", 8),
  ]);
  expect(shape(rows)).toEqual(["date", "a:startFL", "b:startFL", "error", "c:startFL"]);
});

test("time separators only at the start, on a new day and after an hour of silence", () => {
  const rows = layout([message("a", "me", 0), message("b", "kropek", 59), message("c", "me", 120), message("d", "me", 24 * 60)]);
  expect(rows.filter((r) => r.kind === "date").map((r) => (r.kind === "date" ? dateLineLabel(r.at, base + 25 * 3600_000) : ""))).toEqual(["Yesterday 11:46 AM", "Yesterday 1:46 PM", "Today 11:46 AM"]);
});

test("consecutive bot ⇄ bot messages become one marker; messages you only sent merge into one phrase", () => {
  const rows = layout([
    message("a", "me", 0),
    exchange("x1", "e1", "crm", "sent", 1), exchange("x2", "e2", "notes", "sent", 1),
    message("b", "kropek", 2),
    exchange("y1", "e3", "crm", "sent", 3), exchange("y2", "e3", "crm", "received", 4),
    exchange("z1", "e4", "notes", "received", 5),
  ]);
  expect(shape(rows)).toEqual(["date", "a:endFL", "exchanges", "b:startFL", "exchanges"]);
  const markers = rows.filter((r) => r.kind === "exchanges").map((r) => (r.kind === "exchanges" ? exchangePhrases(r.segments) : []));
  expect(markers[0]?.map((p) => (p.kind === "sent" ? p.segments.map((s) => s.bot?.name) : p.kind))).toEqual([["FIXme CRM", "Notes"]]);
  expect(markers[1]?.map((p) => (p.kind === "both" ? `${p.count} with ${p.segment.bot?.name}` : p.kind === "received" ? `from ${p.segment.bot?.name}` : "sent"))).toEqual(["2 with FIXme CRM", "from Notes"]);
});
