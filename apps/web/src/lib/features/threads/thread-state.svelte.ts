import { ui, type Item } from "@open-agents/contracts";
import { eventItemId, reduceItem } from "@open-agents/domain/items";
import { decode } from "#lib/shared/wire.ts";

export interface TimelineEntry {
  readonly id: string;
  readonly item: Item;
  readonly turnId: string;
  readonly firstSeq: bigint;
}

/**
 * Client state of one thread, fed by the SSE stream of WatchThread.
 * Items are folded with the same reducer the gateway uses for thread_items, so live view and
 * reload show the same thing. A (re)connect starts with a snapshot that replaces everything.
 */
export class ThreadState {
  thread = $state.raw<ui.Thread | undefined>(undefined);
  turns = $state.raw<ui.Turn[]>([]);
  entries = $state.raw<TimelineEntry[]>([]);
  interactions = $state.raw<ui.Interaction[]>([]);
  live = $state(false);
  failure = $state<string | undefined>(undefined);

  readonly pending = $derived(this.interactions.filter((i) => i.status === "pending"));
  readonly running = $derived(this.turns.some((t) => t.status === "running"));
  readonly queued = $derived(this.turns.filter((t) => t.status === "queued"));

  apply(update: ui.ThreadUpdate): void {
    const change = update.change;
    switch (change.case) {
      case "snapshot": {
        const snapshot = change.value;
        this.thread = snapshot.thread;
        this.turns = snapshot.turns;
        this.interactions = snapshot.interactions;
        this.entries = snapshot.items.flatMap((i) => (i.item ? [{ id: i.item.itemId, item: i.item, turnId: i.turnId, firstSeq: i.firstSeq }] : []));
        break;
      }
      case "event": {
        const event = change.value.event;
        if (!event) break;
        const id = eventItemId(event.body);
        if (!id) break;
        const index = this.entries.findIndex((e) => e.id === id);
        const next = reduceItem(index >= 0 ? this.entries[index]?.item : undefined, event.body);
        if (!next) break;
        const entry: TimelineEntry = { id, item: next, turnId: event.turnId, firstSeq: index >= 0 ? this.entries[index]!.firstSeq : change.value.seq };
        this.entries = index >= 0 ? this.entries.with(index, entry) : [...this.entries, entry];
        break;
      }
      case "thread":
        this.thread = change.value;
        break;
      case "turn": {
        const index = this.turns.findIndex((t) => t.id === change.value.id);
        this.turns = index >= 0 ? this.turns.with(index, change.value) : [...this.turns, change.value].sort((a, b) => a.ordinal - b.ordinal);
        break;
      }
      case "interaction": {
        const index = this.interactions.findIndex((i) => i.requestId === change.value.requestId);
        this.interactions = index >= 0 ? this.interactions.with(index, change.value) : [...this.interactions, change.value];
        break;
      }
      default:
        break;
    }
  }

  /** Subscribes to the BFF event stream; returns the cleanup for $effect. */
  connect(threadId: string): () => void {
    const source = new EventSource(`/api/threads/${encodeURIComponent(threadId)}/events`);
    source.onopen = () => {
      this.live = true;
      this.failure = undefined;
    };
    source.onerror = () => {
      this.live = false; // EventSource reconnects by itself; a snapshot follows
    };
    source.addEventListener("failure", () => (this.failure = "The live stream was interrupted. Reconnecting…"));
    source.onmessage = (message) => this.apply(decode(ui.ThreadUpdateSchema, JSON.parse(message.data)));
    return () => source.close();
  }
}
