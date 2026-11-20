import { equals } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { sameItems } from "@canopy/domain/same-items";
import { applyThread } from "../../../api/thread";

export interface ChildRequests {
  requests: ui.Interaction[];
  items: ui.TimelineItem[];
}

export function hasChildRequests(thread: ui.Thread) {
  // Older gateways count only blocking requests. A working child can also ask an asynchronous question.
  return (
    thread.hasPendingRequests ??
    (thread.pendingInteractions > 0 ||
      thread.status === "running" ||
      thread.status === "creating" ||
      thread.status === "waiting_input")
  );
}

/** New gateways replace the request snapshot. Older ones send timeline events and deltas on the same watch. */
export async function* childRequestUpdates(updates: AsyncIterable<ui.ThreadUpdate>) {
  let snapshot: ui.ThreadSnapshot | undefined;
  let previous: ChildRequests | undefined;
  let received = false;

  for await (const update of updates) {
    const change = update.change.case;

    if (change !== "snapshot" && change !== "delta" && change !== "event" && change !== "interaction") continue;
    const next = applyThread(snapshot, update);
    const requests = next.interactions.filter((entry) => entry.status === "pending");

    // Keep legacy approval details that may arrive before the associated interaction.
    const items = next.items.filter(
      (entry) => entry.item?.content.case === "commandExecution" || entry.item?.content.case === "fileChange",
    );

    snapshot = { ...next, interactions: requests, items };

    if (!requests.length) {
      if (received && !previous) continue;
      previous = undefined;
    } else {
      const related = new Set(requests.map((request) => request.itemId));
      const details = items.filter((entry) => entry.item && related.has(entry.item.itemId));

      if (
        previous &&
        sameItems(previous.requests, requests, (a, b) => equals(ui.InteractionSchema, a, b)) &&
        sameItems(previous.items, details, (a, b) => equals(ui.TimelineItemSchema, a, b))
      )
        continue;
      previous = { requests, items: details };
    }

    received = true;
    yield previous;
  }
}
