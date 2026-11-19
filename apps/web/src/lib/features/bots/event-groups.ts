import type { ChatRow } from "@canopy/domain/bot-chat";

type EventRow = Extract<ChatRow, { kind: "event" | "approval" }>;

export interface EventGroup {
  kind: "event-group";
  id: string;
  events: EventRow[];
}

const isEvent = (row: ChatRow): row is EventRow =>
  row.kind === "event" ||
  (row.kind === "approval" && row.approval.status === "approved" && Boolean(row.approval.allowedByRule));

/** Keep the same header as a run grows at either end (live updates and older history). */
export class ChatEventGroups {
  private anchors = new Set<string>();

  layout(rows: readonly ChatRow[]): (ChatRow | EventGroup)[] {
    const grouped: (ChatRow | EventGroup)[] = [];
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
