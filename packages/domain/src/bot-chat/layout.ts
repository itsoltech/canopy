import {
  entryAt,
  entryId,
  type ApprovalView,
  type ChatEntry,
  type ChatErrorView,
  type ChatEventView,
  type ChatExchangeView,
  type ChatMessageView,
  type ConversationKind,
  type ParticipantView,
  type QuestionView,
} from "./model.ts";

/** One exchange with another bot inside a marker line: how many messages went each way. */
export interface ExchangeSegment {
  exchangeId: string;
  botId: string;
  bot: ParticipantView | undefined;
  sent: number;
  received: number;
}

/**
 * Chat entries laid out for display: date lines when the day changes or after a pause, the "New"
 * divider before the first unread entry, and messages grouped into runs (same sender, close in time,
 * nothing in between), so the sender's name sits above a run and the avatar beside its last bubble.
 * Consecutive bot ⇄ bot messages become one marker line ("Messaged ‹A› and ‹B›", "2 messages with ‹A›").
 */
export type ChatRow =
  | { kind: "date"; id: string; at: Date }
  | { kind: "unread"; id: string }
  | {
      kind: "message";
      id: string;
      message: ChatMessageView;
      sender: ParticipantView | undefined;
      side: "start" | "end";
      mine: boolean;
      first: boolean;
      last: boolean;
      showName: boolean;
    }
  | { kind: "event"; id: string; event: ChatEventView }
  | { kind: "question"; id: string; question: QuestionView; sender: ParticipantView | undefined }
  | { kind: "approval"; id: string; approval: ApprovalView; sender: ParticipantView | undefined }
  | { kind: "error"; id: string; error: ChatErrorView; sender: ParticipantView | undefined }
  | { kind: "exchanges"; id: string; segments: ExchangeSegment[] };

/** A run breaks after this long between two messages of the same sender. */
const RUN_GAP_MS = 5 * 60_000;

/** A new date line after this long without anything. */
const DATE_GAP_MS = 60 * 60_000;

export interface ChatLayoutInput {
  entries: readonly ChatEntry[];
  participants: ReadonlyMap<string, ParticipantView>;
  /** Your participant id: your messages go to the right. */
  me: string;
  kind: ConversationKind;
  /** Watched bot ⇄ bot chats: this bot's messages go to the right (you are not in the chat). */
  endSideId?: string | undefined;
  firstUnreadId?: string | undefined;
}

export function layoutChat({ entries, participants, me, kind, endSideId, firstUnreadId }: ChatLayoutInput): ChatRow[] {
  const sorted = [...entries].sort((a, b) => entryAt(a).getTime() - entryAt(b).getTime());
  const rows: ChatRow[] = [];
  let previousAt: Date | undefined;

  for (const entry of sorted) {
    const id = entryId(entry);
    const at = entryAt(entry);

    if (!previousAt || !sameDay(previousAt, at) || at.getTime() - previousAt.getTime() >= DATE_GAP_MS)
      rows.push({ kind: "date", id: `date:${id}`, at });

    if (id === firstUnreadId) rows.push({ kind: "unread", id: `unread:${id}` });
    previousAt = at;

    if (entry.kind === "event") rows.push({ kind: "event", id, event: entry.event });
    else if (entry.kind === "question")
      rows.push({ kind: "question", id, question: entry.question, sender: participants.get(entry.question.askedBy) });
    else if (entry.kind === "approval")
      rows.push({ kind: "approval", id, approval: entry.approval, sender: participants.get(entry.approval.askedBy) });
    else if (entry.kind === "error")
      rows.push({ kind: "error", id, error: entry.error, sender: participants.get(entry.error.botId) });
    else if (entry.kind === "exchange") {
      const before = rows.at(-1);

      const marker =
        before?.kind === "exchanges" ? before : { kind: "exchanges" as const, id: `exchanges:${id}`, segments: [] };

      if (marker !== before) rows.push(marker);
      addToSegments(marker.segments, entry.exchange, participants);
    } else {
      const message = entry.message;
      const mine = message.senderId === me;
      const before = rows.at(-1);

      const continues =
        before?.kind === "message" &&
        before.message.senderId === message.senderId &&
        message.at.getTime() - before.message.at.getTime() < RUN_GAP_MS;

      if (continues) before.last = false;
      rows.push({
        kind: "message",
        id,
        message,
        sender: participants.get(message.senderId),
        side: mine || (kind === "watch" && message.senderId === endSideId) ? "end" : "start",
        mine,
        first: !continues,
        last: true,
        showName: !continues && !mine && kind !== "direct",
      });
    }
  }

  return rows;
}

function addToSegments(
  segments: ExchangeSegment[],
  exchange: ChatExchangeView,
  participants: ReadonlyMap<string, ParticipantView>,
) {
  let segment = segments.find((s) => s.exchangeId === exchange.exchangeId && s.botId === exchange.counterpartId);

  if (!segment) {
    segment = {
      exchangeId: exchange.exchangeId,
      botId: exchange.counterpartId,
      bot: participants.get(exchange.counterpartId),
      sent: 0,
      received: 0,
    };
    segments.push(segment);
  }

  segment[exchange.direction]++;
}

/**
 * The phrases of a marker line, in order: runs of exchanges you only wrote to merge ("Messaged ‹A› and
 * ‹B›"), one you only heard from is "Message from ‹A›", a two-way one "3 messages with ‹A›".
 */
export type ExchangePhrase =
  | { kind: "sent"; segments: ExchangeSegment[] }
  | { kind: "received"; segment: ExchangeSegment }
  | { kind: "both"; segment: ExchangeSegment; count: number };

export function exchangePhrases(segments: readonly ExchangeSegment[]): ExchangePhrase[] {
  const phrases: ExchangePhrase[] = [];

  for (const segment of segments) {
    const before = phrases.at(-1);

    if (segment.received === 0) {
      if (before?.kind === "sent") before.segments.push(segment);
      else phrases.push({ kind: "sent", segments: [segment] });
    } else if (segment.sent === 0 && segment.received === 1) phrases.push({ kind: "received", segment });
    else phrases.push({ kind: "both", segment, count: segment.sent + segment.received });
  }

  return phrases;
}

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
