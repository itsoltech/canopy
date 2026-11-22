import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { Invalid } from "../../store/errors.ts";

export const threadPageFields = {
  limit: { type: "integer", minimum: 1, description: "Messages per page, capped at 100 (default 25 in paged mode)." },
  before: { type: "string", description: "Use page.next_before from this thread to read the next older page." },
};

export const wantsThreadPage = (args: JsonObject) => args["limit"] !== undefined || args["before"] !== undefined;

const iso = (timestamp: Timestamp | undefined) => timestamp && timestampDate(timestamp).toISOString();

export function readThreadPage(snapshot: ui.ThreadSnapshot, args: JsonObject) {
  const items = snapshot.items.flatMap((item) => {
    const content = item.item?.content;

    return content?.case === "agentMessage" || content?.case === "userMessage" ? [{ item, content }] : [];
  });

  // Fork segments have their own sequence spaces. Scope the anchor to both this history and its source item.
  const cursor = (item: ui.TimelineItem) =>
    JSON.stringify([snapshot.thread?.id, item.fromThreadId, item.firstSeq.toString(), item.item?.itemId]);

  const before = args["before"];
  const end = before === undefined ? items.length : items.findIndex(({ item }) => cursor(item) === before);

  if (end < 0) throw new Invalid("before is unavailable in this thread. Start again with limit only.");
  const limit = Math.min(Number(args["limit"] ?? 25), 100);
  const start = Math.max(0, end - limit);
  const page = items.slice(start, end);
  const turnIds = new Set(page.map(({ item }) => item.turnId));

  return {
    turns: snapshot.turns
      .filter((turn) => turnIds.has(turn.id))
      .map((turn) => ({
        id: turn.id,
        status: turn.status,
        inherited: turn.inherited,
        from_thread_id: turn.fromThreadId || snapshot.thread?.id,
        queued_at: iso(turn.queuedAt),
        started_at: iso(turn.startedAt),
        completed_at: iso(turn.completedAt),
      })),
    messages: page.map(({ item, content }) => ({
      role: content.case === "agentMessage" ? "assistant" : "user",
      text: content.value.text,
      turn_id: item.turnId || undefined,
      completed_at: iso(item.completedAt),
    })),
    page: { next_before: start > 0 && page[0] ? cursor(page[0].item) : null },
  };
}
