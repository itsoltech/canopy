import { create } from "@bufbuild/protobuf";
import { TurnOrigin, TurnOutcome, ui, type Item, type Notice, type TurnFinished, type TurnStarted, type Usage } from "@open-agents/contracts";
import { eventItemId, reduceItem } from "@open-agents/domain/items";
import type { Timestamp } from "@bufbuild/protobuf/wkt";
import { decode } from "#lib/shared/wire.ts";

export interface TimelineEntry {
  readonly id: string;
  readonly item: Item;
  readonly turnId: string;
  readonly firstSeq: bigint;
}

/** A notice event (rate limit, retry, provider error, restart). Not an item, so only seen live. */
export interface TimelineNotice {
  readonly seq: bigint;
  readonly turnId: string;
  readonly notice: Notice;
  readonly at: Timestamp | undefined;
}

/** How a turn ended, from its turn_finished event (usage is not part of `ui.Turn`). */
export interface TurnResult {
  readonly usage: Usage | undefined;
  readonly reason: string;
  readonly at: Timestamp | undefined;
}

/** connecting: first snapshot pending; live: stream open; reconnecting: dropped, EventSource retries. */
export type Connection = "connecting" | "live" | "reconnecting";

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
  notices = $state.raw<TimelineNotice[]>([]);
  turnResults = $state.raw<ReadonlyMap<string, TurnResult>>(new Map());
  /** Latest token usage of the thread (usage_updated), live only. */
  usage = $state.raw<Usage | undefined>(undefined);
  connection = $state<Connection>("connecting");
  /** The snapshot arrived at least once. */
  loaded = $state(false);
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
        // Notices and usage are not in the snapshot: keep what this tab saw before the reconnect.
        this.loaded = true;
        break;
      }
      case "event":
        this.#event(change.value);
        break;
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

  #event({ seq, event }: ui.ThreadEventUpdate): void {
    if (!event) return;
    const body = event.body;
    switch (body.case) {
      case "notice":
        if (!this.notices.some((n) => n.seq === seq)) {
          this.notices = [...this.notices, { seq, turnId: event.turnId, notice: body.value, at: event.occurredAt }];
        }
        return;
      case "turnStarted":
        this.#started(event.turnId, body.value, event.occurredAt);
        return;
      case "turnFinished":
        this.#finished(event.turnId, body.value, event.occurredAt);
        return;
      case "usageUpdated":
        this.usage = body.value.usage;
        return;
      default:
        break;
    }
    const id = eventItemId(body);
    if (!id) return;
    const index = this.entries.findIndex((e) => e.id === id);
    const next = reduceItem(index >= 0 ? this.entries[index]?.item : undefined, body);
    if (!next) return;
    const entry: TimelineEntry = { id, item: next, turnId: event.turnId, firstSeq: index >= 0 ? this.entries[index]!.firstSeq : seq };
    this.entries = index >= 0 ? this.entries.with(index, entry) : [...this.entries, entry];
  }

  /**
   * Turns the worker starts on its own (provider wake-up, recovery) reach the UI only as events, not as
   * turn updates; add them so the timeline frames them. A later turn update replaces this stand-in.
   */
  #started(turnId: string, started: TurnStarted, at: Timestamp | undefined): void {
    if (!turnId || this.turns.some((t) => t.id === turnId)) return;
    const trigger = started.origin === TurnOrigin.PROVIDER ? "provider" : started.origin === TurnOrigin.RECOVERY ? "recovery" : "user";
    const ordinal = Math.max(0, ...this.turns.map((t) => t.ordinal)) + 1;
    this.turns = [...this.turns, create(ui.TurnSchema, { id: turnId, ordinal, status: "running", trigger, ...(at && { queuedAt: at }) })];
  }

  #finished(turnId: string, finished: TurnFinished, at: Timestamp | undefined): void {
    if (!turnId) return;
    this.turnResults = new Map(this.turnResults).set(turnId, { usage: finished.usage, reason: finished.reason, at });
    const index = this.turns.findIndex((t) => t.id === turnId && t.status === "running");
    const status = { [TurnOutcome.COMPLETED]: "completed", [TurnOutcome.INTERRUPTED]: "interrupted", [TurnOutcome.FAILED]: "failed" }[finished.outcome as number];
    const turn = this.turns[index];
    if (turn && status) this.turns = this.turns.with(index, { ...turn, status });
  }

  /** Subscribes to the BFF event stream; returns the cleanup for $effect. */
  connect(threadId: string): () => void {
    this.connection = "connecting";
    const source = new EventSource(`/api/threads/${encodeURIComponent(threadId)}/events`);
    source.onerror = () => {
      // EventSource reconnects by itself; a fresh snapshot follows.
      if (this.loaded) this.connection = "reconnecting";
    };
    source.addEventListener("failure", () => {
      this.connection = "reconnecting";
      this.failure = "Lost the connection to the gateway. Reconnecting…";
    });
    source.onmessage = (message) => {
      this.apply(decode(ui.ThreadUpdateSchema, JSON.parse(message.data)));
      this.connection = "live";
      this.failure = undefined;
    };
    return () => source.close();
  }
}
