import { create } from "@bufbuild/protobuf";
import { ItemStatus, TurnEndSource, TurnOrigin, TurnOutcome, ui, type Item, type Notice, type TurnFinished, type TurnStarted, type Usage } from "@open-agents/contracts";
import { eventItemId, reduceItem } from "@open-agents/domain/items";
import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import { isFinished, upsertSchedule } from "#lib/features/schedules/schedules.ts";
import { decode } from "#lib/shared/wire.ts";
import { liveSource } from "#lib/shared/live-source.ts";

export interface TimelineEntry {
  readonly id: string;
  readonly item: Item;
  readonly turnId: string;
  readonly firstSeq: bigint;
  /** From the history a fork inherited (its seq counts in the source thread). */
  readonly inherited: boolean;
  /** Inherited: the thread it belongs to (along a chain of forks, not always the direct source). */
  readonly fromThreadId: string;
  /** Item times observed on the live stream; snapshots currently omit these. */
  readonly startedAt?: number | undefined;
  readonly completedAt?: number | undefined;
}

/** A notice event (rate limit, retry, provider error, restart); the snapshot brings the latest ones. */
export interface TimelineNotice {
  readonly seq: bigint;
  readonly turnId: string;
  readonly notice: Notice;
  readonly at: Timestamp | undefined;
}

/**
 * How a turn ended, from its turn_finished event: the interruption reason (not part of `ui.Turn`) and
 * usage until the turn update with `usage` arrives. Live only.
 */
export interface TurnResult {
  readonly usage: Usage | undefined;
  readonly reason: string;
}

/** Token usage added up over turns. */
export interface UsageTotals {
  readonly inputTokens: bigint;
  readonly cachedInputTokens: bigint;
  readonly outputTokens: bigint;
  readonly costUsd: number;
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
  /** The thread's schedules (the snapshot has the active and paused ones; changes arrive live). */
  schedules = $state.raw<ui.Schedule[]>([]);
  /** Messages steered into running turns, oldest first (the snapshot has all of the thread's; changes arrive live). */
  steers = $state.raw<ui.Steer[]>([]);
  /** The thread's open goal, else its last finished one (undefined: never had one). */
  goal = $state.raw<ui.Goal | undefined>(undefined);
  turnResults = $state.raw<ReadonlyMap<string, TurnResult>>(new Map());
  /** Latest token usage of the thread (usage_updated), live only; carries the context window. */
  usage = $state.raw<Usage | undefined>(undefined);
  connection = $state<Connection>("connecting");
  /** The snapshot arrived at least once. */
  loaded = $state(false);
  failure = $state<string | undefined>(undefined);

  readonly pending = $derived(this.interactions.filter((i) => i.status === "pending"));
  readonly upcomingSchedules = $derived(this.schedules.filter((s) => !isFinished(s)));
  /** The thread's own turns and items; a fork's inherited history is kept apart. */
  readonly ownTurns = $derived(this.turns.filter((t) => !t.inherited));
  readonly ownEntries = $derived(this.entries.filter((e) => !e.inherited));
  readonly inheritedTurns = $derived(this.turns.filter((t) => t.inherited));
  readonly inheritedEntries = $derived(this.entries.filter((e) => e.inherited));
  readonly running = $derived(this.ownTurns.some((t) => t.status === "running"));
  readonly queued = $derived(this.ownTurns.filter((t) => t.status === "queued"));
  /** Background tasks still running (items `background_task` in progress), oldest first. */
  readonly backgroundTasks = $derived(this.ownEntries.filter((e) => e.item.content.case === "backgroundTask" && e.item.status === ItemStatus.IN_PROGRESS));
  /**
   * Steers on their way into the running turn: sent or accepted and not yet in the transcript (a
   * delivered one is a user_message item with `client_id` = its id; a queued one is a queued turn).
   */
  readonly steering = $derived.by(() => {
    const echoed = new Set(this.ownEntries.flatMap((e) => (e.item.content.case === "userMessage" && e.item.content.value.clientId ? [e.item.content.value.clientId] : [])));
    return this.steers.filter((s) => (s.status === "pending" || s.status === "accepted") && !echoed.has(s.id));
  });
  /** Usage of the thread's own turns (from the snapshot, so it survives a reload). */
  readonly totals = $derived(
    this.ownTurns.reduce<UsageTotals>(
      (sum, turn) => {
        const usage = turn.usage ?? this.turnResults.get(turn.id)?.usage;
        if (!usage) return sum;
        return {
          inputTokens: sum.inputTokens + usage.inputTokens,
          cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
          outputTokens: sum.outputTokens + usage.outputTokens,
          costUsd: sum.costUsd + usage.costUsd,
        };
      },
      { inputTokens: 0n, cachedInputTokens: 0n, outputTokens: 0n, costUsd: 0 },
    ),
  );

  /**
   * Seeds the thread before the stream connects (server load), so the page renders it at once; with
   * `tail` (the end of the snapshot) the server renders the latest messages too. The stream's snapshot
   * replaces both.
   */
  constructor(thread?: ui.Thread | undefined, tail?: ui.ThreadSnapshot | undefined) {
    this.thread = thread;
    if (tail) this.apply(create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: tail } }));
  }

  apply(update: ui.ThreadUpdate): void {
    const change = update.change;
    switch (change.case) {
      case "snapshot": {
        const snapshot = change.value;
        this.thread = snapshot.thread;
        this.turns = snapshot.turns;
        this.interactions = snapshot.interactions;
        const known = new Map(this.entries.map((entry) => [`${entry.fromThreadId}:${entry.id}`, entry]));
        this.entries = snapshot.items.flatMap((i) => {
          const previous = known.get(`${i.fromThreadId}:${i.item?.itemId}`);
          return i.item ? [{ id: i.item.itemId, item: i.item, turnId: i.turnId, firstSeq: i.firstSeq, inherited: i.inherited, fromThreadId: i.fromThreadId, startedAt: previous?.startedAt, completedAt: previous?.completedAt }] : [];
        });
        this.notices = snapshot.notices.flatMap((n) => (n.notice ? [{ seq: n.seq, turnId: n.turnId, notice: n.notice, at: n.occurredAt }] : []));
        this.schedules = snapshot.schedules;
        this.steers = snapshot.steers;
        this.goal = snapshot.goal;
        // Live usage (context window) is not in the snapshot: keep what this tab saw before the reconnect.
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
      case "schedule":
        this.upsertSchedule(change.value);
        break;
      case "steer":
        this.upsertSteer(change.value);
        break;
      case "goal":
        this.upsertGoal(change.value);
        break;
      default:
        break;
    }
  }

  /** A schedule created or changed here (also before the stream reports it). */
  upsertSchedule(schedule: ui.Schedule): void {
    if (schedule.threadId === this.thread?.id) this.schedules = upsertSchedule(this.schedules, schedule);
  }

  /** A steer sent here or changed (pending → accepted → delivered or queued). */
  upsertSteer(steer: ui.Steer): void {
    if (steer.threadId !== this.thread?.id) return;
    const index = this.steers.findIndex((s) => s.id === steer.id);
    this.steers = index >= 0 ? this.steers.with(index, steer) : [...this.steers, steer];
  }

  /** The goal set or changed here or live; a late update of a goal a newer one replaced is ignored. */
  upsertGoal(goal: ui.Goal): void {
    if (goal.threadId !== this.thread?.id) return;
    const current = this.goal;
    const created = (g: ui.Goal) => (g.createdAt ? timestampMs(g.createdAt) : 0);
    if (current && current.id !== goal.id && created(goal) < created(current)) return;
    this.goal = goal;
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
    // Live events are the thread's own; an inherited item may share its id with the source's copy.
    const index = this.entries.findIndex((e) => e.id === id && !e.inherited);
    const next = reduceItem(index >= 0 ? this.entries[index]?.item : undefined, body);
    if (!next) return;
    const previous = index >= 0 ? this.entries[index] : undefined;
    // Background work reports after its turn ended without a turn id: it stays in the turn it started in.
    const at = event.occurredAt ? timestampMs(event.occurredAt) : undefined;
    const entry: TimelineEntry = {
      id, item: next, turnId: previous?.turnId || event.turnId, firstSeq: previous?.firstSeq ?? seq, inherited: false, fromThreadId: "",
      startedAt: previous?.startedAt ?? (body.case === "itemStarted" ? at : undefined),
      completedAt: previous?.completedAt ?? (body.case === "itemCompleted" ? at : undefined),
    };
    this.entries = index >= 0 ? this.entries.with(index, entry) : [...this.entries, entry];
  }

  /**
   * Turns the worker starts on its own (provider wake-up, recovery) reach the UI only as events, not as
   * turn updates; add them so the timeline frames them. A later turn update replaces this stand-in.
   */
  #started(turnId: string, started: TurnStarted, at: Timestamp | undefined): void {
    if (!turnId || this.turns.some((t) => t.id === turnId)) return;
    const trigger = started.origin === TurnOrigin.PROVIDER ? "provider" : started.origin === TurnOrigin.RECOVERY ? "recovery" : "user";
    const ordinal = Math.max(0, ...this.ownTurns.map((t) => t.ordinal)) + 1;
    this.turns = [...this.turns, create(ui.TurnSchema, { id: turnId, ordinal, status: "running", trigger, ...(at && { queuedAt: at, startedAt: at }) })];
  }

  #finished(turnId: string, finished: TurnFinished, at: Timestamp | undefined): void {
    if (!turnId) return;
    this.turnResults = new Map(this.turnResults).set(turnId, { usage: finished.usage, reason: finished.reason });
    const index = this.turns.findIndex((t) => t.id === turnId && t.status === "running");
    const status = { [TurnOutcome.COMPLETED]: "completed", [TurnOutcome.INTERRUPTED]: "interrupted", [TurnOutcome.FAILED]: "failed" }[finished.outcome as number];
    const turn = this.turns[index];
    // Who interrupted it or where its error came from, until the gateway's turn update brings the stored values.
    const source = { [TurnEndSource.USER]: "user", [TurnEndSource.SYSTEM]: "system", [TurnEndSource.PLATFORM]: "platform", [TurnEndSource.HARNESS]: "harness" }[finished.source as number] ?? "";
    const end =
      status === "failed"
        ? { error: finished.reason, errorSource: source || "harness", errorCode: finished.errorCode }
        : status === "interrupted"
          ? { interruptReason: finished.reason, interruptSource: source || "user" }
          : {};
    if (turn && status) this.turns = this.turns.with(index, { ...turn, status, ...end, ...(at && { completedAt: at }) });
  }

  /** Subscribes to the BFF event stream; returns the cleanup for $effect. */
  connect(threadId: string): () => void {
    this.connection = "connecting";
    // Every (re)connect starts with a fresh snapshot from the server, so nothing needs reconciling here.
    return liveSource(`/api/threads/${encodeURIComponent(threadId)}/events`, {
      ondrop: () => {
        if (this.loaded) this.connection = "reconnecting";
      },
      onfailure: () => {
        this.connection = "reconnecting";
        this.failure = "Lost the connection to the gateway. Reconnecting…";
      },
      onmessage: (data) => {
        this.apply(decode(ui.ThreadUpdateSchema, JSON.parse(data)));
        this.connection = "live";
        this.failure = undefined;
      },
    });
  }
}
