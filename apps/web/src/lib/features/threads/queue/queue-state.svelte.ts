import type { Mention, ui } from "@canopy/contracts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { deleteQueued, editQueued, reorderQueue, restoreQueued, steerQueued } from "../api.ts";
import { moveTo, ordered } from "./queue.ts";

/** Where the queue comes from (the thread's live state) and where confirmed changes go before the stream has them. */
export interface QueueSource {
  readonly threadId: string;
  /** The thread's queued turns in the gateway's order (ordinal). */
  readonly turns: readonly ui.Turn[];
  /** All of the thread's steers (a queued one names the turn it fell back to). */
  readonly steers: readonly ui.Steer[];
  readonly running: boolean;
}

export interface QueueSink {
  turn(turn: ui.Turn): void;
  steer(steer: ui.Steer): void;
}

const failure = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * The queue panel's state (docs/ui-api.md, "Kolejka"): the queued turns as shown, with what the user just did
 * applied at once — a new order (also live while a row is dragged), a deleted or steered message gone, a row in
 * edit. The gateway confirms each change; a refusal (the message already started) puts back what it has and says
 * why. `announcement` is for a polite live region (moves by keyboard or drag).
 */
export class QueueState {
  /** The order shown while a reorder is being dragged or sent; undefined = the gateway's. */
  order = $state.raw<string[] | undefined>(undefined);
  /** Messages deleted or steered here and not yet out of the stream's queue. */
  hidden = $state.raw<ReadonlySet<string>>(new Set());
  /** The row being edited inline. */
  editing = $state<string | undefined>(undefined);
  announcement = $state("");
  readonly #source: () => QueueSource;
  readonly #sink: QueueSink;

  readonly rows: ui.Turn[] = $derived.by(() =>
    ordered(
      this.#source().turns.filter((t) => !this.hidden.has(t.id)),
      this.order,
    ),
  );
  readonly running: boolean = $derived.by(() => this.#source().running);

  constructor(source: () => QueueSource, sink: QueueSink) {
    this.#source = source;
    this.#sink = sink;
  }

  /** The steer that could not join the running turn and is this queued turn again (runs at its place). */
  fallback(turnId: string): ui.Steer | undefined {
    return this.#source().steers.findLast((s) => s.queuedTurnId === turnId && s.status === "queued");
  }

  /** Moves a row in the shown order only (dragging); `commit` sends it. */
  preview(id: string, index: number): void {
    this.order = moveTo(
      this.rows.map((t) => t.id),
      id,
      index,
    );
  }

  /** Moves a row and sends the new order. */
  async move(id: string, index: number): Promise<void> {
    const before = this.rows.findIndex((t) => t.id === id);
    this.preview(id, index);
    const after = this.rows.findIndex((t) => t.id === id);

    if (after === before) {
      this.order = undefined;

      return;
    }

    this.announce(after);
    await this.commit();
  }

  /** Sends the shown order; the gateway's answer (new ordinals) replaces it. */
  async commit(): Promise<void> {
    const order = this.order;

    if (!order) return;
    const { threadId, turns } = this.#source();
    const unchanged = turns.filter((t) => !this.hidden.has(t.id)).every((t, i) => t.id === order[i]);

    try {
      if (!unchanged) for (const turn of await reorderQueue(threadId, order)) this.#sink.turn(turn);
    } catch (cause) {
      toast(`Could not reorder: ${failure(cause)}`, { tone: "error" });
    } finally {
      if (this.order === order) this.order = undefined;
    }
  }

  /** The editor's text with its chips' ranges (badges of files too): the whole set, so the gateway takes it as is. */
  async edit(
    turn: ui.Turn,
    text: string,
    mentions: readonly Mention[],
    quotes: readonly ui.Quote[],
  ): Promise<string | undefined> {
    try {
      const saved = await editQueued(this.#source().threadId, turn.id, text, turn.revision, mentions, quotes);

      if (saved) this.#sink.turn(saved);
      this.editing = undefined;

      return undefined;
    } catch (cause) {
      return failure(cause);
    }
  }

  /** Out of the queue at once; the toast offers Undo (back at its place). */
  async remove(turn: ui.Turn): Promise<void> {
    const { threadId } = this.#source();
    await this.#withdraw(turn, "Could not delete", async () => {
      const removed = await deleteQueued(threadId, turn.id);

      if (removed) this.#sink.turn(removed);
      toast("Message deleted", {
        tone: "info",
        action: { label: "Undo", run: () => void this.#restore(threadId, turn.id) },
      });
    });
  }

  /** Into the running turn now; it leaves the queue (and comes back to its place if it cannot join). */
  async steer(turn: ui.Turn): Promise<void> {
    const { threadId } = this.#source();
    await this.#withdraw(turn, "Could not steer", async () => {
      const { steer, turn: withdrawn } = await steerQueued(threadId, turn.id);

      if (withdrawn) this.#sink.turn(withdrawn);

      if (steer) this.#sink.steer(steer);
    });
  }

  async #withdraw(turn: ui.Turn, what: string, run: () => Promise<void>): Promise<void> {
    if (this.editing === turn.id) this.editing = undefined;
    this.hidden = new Set(this.hidden).add(turn.id);

    try {
      await run();
    } catch (cause) {
      toast(`${what}: ${failure(cause)}`, { tone: "error" });
    } finally {
      const next = new Set(this.hidden);
      next.delete(turn.id);
      this.hidden = next;
    }
  }

  async #restore(threadId: string, turnId: string): Promise<void> {
    try {
      const restored = await restoreQueued(threadId, turnId);

      if (restored) this.#sink.turn(restored);
    } catch (cause) {
      toast(`Could not restore: ${failure(cause)}`, { tone: "error" });
    }
  }

  /** Says where a moved row is now (after a keyboard move or a drop). */
  announce(index: number): void {
    this.announcement = `Moved to position ${index + 1} of ${this.rows.length}`;
  }
}
