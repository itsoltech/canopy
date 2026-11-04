import { clone, create } from "@bufbuild/protobuf";
import {
  ItemDeltaField,
  ItemSchema,
  ItemStatus,
  type BlobRef,
  type Item,
  type ItemDelta,
  type ThreadEvent,
} from "@canopy/contracts";

/**
 * Item projection shared by the gateway (thread_items, same transaction as the event)
 * and the UI (live events on top of a snapshot). Both must compute the same state.
 *
 * Rules (docs/transcript.md):
 * - started creates the item; it never regresses an item that already finished,
 * - deltas append to the field of the matching content type while the item is in progress,
 * - completed replaces the item, but text/output accumulated from deltas is kept
 *   when the final snapshot leaves that field empty (nothing that was shown disappears),
 * - anything the projection cannot place is still in thread_events.
 */
export function reduceItem(current: Item | undefined, body: ThreadEvent["body"]): Item | undefined {
  switch (body.case) {
    case "itemStarted": {
      const started = body.value.item;

      if (!started) return current;

      if (current && current.status !== ItemStatus.IN_PROGRESS) return current;

      return clone(ItemSchema, started);
    }

    case "itemDelta":
      return current && current.status === ItemStatus.IN_PROGRESS ? applyDelta(current, body.value) : current;
    case "itemCompleted": {
      const completed = body.value.item;

      if (!completed) return current;
      const next = clone(ItemSchema, completed);

      if (current) keepAccumulated(current, next);

      return next;
    }

    default:
      return current;
  }
}

/** item_id of an item event, undefined for other events. */
export function eventItemId(body: ThreadEvent["body"]): string | undefined {
  switch (body.case) {
    case "itemStarted":
    case "itemCompleted":
      return body.value.item?.itemId;
    case "itemDelta":
      return body.value.itemId;
    default:
      return undefined;
  }
}

/** thread_events.kind, e.g. "item_completed". */
export function eventKind(event: ThreadEvent): string {
  return event.body.case ? snake(event.body.case) : "provider_raw";
}

/** thread_items.type, e.g. "command_execution". */
export function itemType(item: Item): string {
  return item.content.case ? snake(item.content.case) : "unknown";
}

/** thread_items.status, e.g. "in_progress". */
export function itemStatus(item: Item): string {
  return (ItemStatus[item.status] ?? "UNSPECIFIED").toLowerCase();
}

/** Placeholder for a delta whose started event never arrived. Callers may choose to create it. */
export function emptyItem(itemId: string): Item {
  return create(ItemSchema, { itemId, status: ItemStatus.IN_PROGRESS });
}

function applyDelta(current: Item, delta: ItemDelta): Item {
  const next = clone(ItemSchema, current);
  const { content } = next;

  switch (delta.field) {
    case ItemDeltaField.TEXT:
      if (content.case === "agentMessage" || content.case === "reasoning") content.value.text += delta.chunk;
      break;
    case ItemDeltaField.SUMMARY:
      if (content.case === "reasoning") content.value.summary += delta.chunk;
      break;
    case ItemDeltaField.OUTPUT:
      if (content.case === "commandExecution" || content.case === "toolCall" || content.case === "backgroundTask") {
        content.value.output += delta.chunk;
      }

      break;
    default:
      break;
  }

  return next;
}

function keepAccumulated(previous: Item, next: Item): void {
  const before = previous.content;
  const after = next.content;

  if (before.case !== after.case) return;

  switch (after.case) {
    case "agentMessage":
      if (before.case === "agentMessage" && !after.value.text) after.value.text = before.value.text;
      break;
    case "reasoning":
      if (before.case === "reasoning") {
        if (!after.value.text) after.value.text = before.value.text;

        if (!after.value.summary) after.value.summary = before.value.summary;
      }

      break;
    case "commandExecution":
      if (before.case === "commandExecution" && !after.value.output && !after.value.outputBlob) {
        after.value.output = before.value.output;
      }

      break;
    case "toolCall":
      if (before.case === "toolCall" && !after.value.output && !after.value.outputBlob)
        after.value.output = before.value.output;
      break;
    case "backgroundTask":
      if (before.case === "backgroundTask" && !after.value.output && !after.value.outputBlob) {
        after.value.output = before.value.output;
      }

      // An end that does not repeat when the task started keeps the start's time.
      if (before.case === "backgroundTask" && !after.value.startedAt && before.value.startedAt)
        after.value.startedAt = before.value.startedAt;
      break;
    default:
      break;
  }
}

function snake(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/**
 * Image previews an item shows (Image.blob, ToolCall.images): the worker uploads them before the event, the gateway
 * lets the thread's owner read them through the thread (thread_blobs).
 */
export function previewRefs(item: Item): BlobRef[] {
  const refs =
    item.content.case === "image"
      ? [item.content.value.blob]
      : item.content.case === "toolCall"
        ? item.content.value.images
        : [];

  return refs.filter((ref): ref is BlobRef => ref !== undefined && /^[0-9a-f]{64}$/.test(ref.sha256));
}
