import type { ChatRow } from "./layout.ts";

type EventRow = Extract<ChatRow, { kind: "event" | "approval" }>;

export interface EventGroup {
  kind: "event-group";
  id: string;
  events: EventRow[];
}

export type BotTimelineRow = ChatRow | EventGroup;

/** The oldest paged message can be represented by a collapsed group or an exchange marker. */
export function containsChatMessage(row: BotTimelineRow, messageId: string) {
  return (
    row.id === messageId ||
    (row.kind === "exchanges" && row.id === `exchanges:${messageId}`) ||
    (row.kind === "event-group" && row.events.some((event) => event.id === messageId))
  );
}

/** Keep expanded entries as individual virtualized rows, in chronological order after their header. */
export function visibleChatRows(groups: readonly BotTimelineRow[], open: ReadonlySet<string>): BotTimelineRow[] {
  const rows: BotTimelineRow[] = [];

  for (const row of groups) {
    rows.push(row);

    if (row.kind === "event-group" && open.has(row.id)) {
      for (const event of row.events) rows.push(event);
    }
  }

  return rows;
}

const isEvent = (row: ChatRow): row is EventRow =>
  (row.kind === "event" && !row.event.themeBuilderPatch) ||
  (row.kind === "approval" && row.approval.status === "approved" && Boolean(row.approval.allowedByRule));

/** Keep the same header as a run grows at either end (live updates and older history). */
export class ChatEventGroups {
  private anchors = new Set<string>();

  layout(rows: readonly ChatRow[]): BotTimelineRow[] {
    const grouped: BotTimelineRow[] = [];
    const anchors = new Set<string>();
    let events: EventRow[] = [];

    const flush = () => {
      const first = events[0];

      if (!first) return;

      if (events.length === 1) grouped.push(first);
      else {
        const anchor = events.find((row) => this.anchors.has(row.id)) ?? first;
        anchors.add(anchor.id);
        grouped.push({ kind: "event-group", id: `events:${anchor.id}`, events });
      }

      events = [];
    };

    for (const row of rows) {
      if (isEvent(row)) events.push(row);
      else {
        flush();
        grouped.push(row);
      }
    }

    flush();
    this.anchors = anchors;

    return grouped;
  }
}
