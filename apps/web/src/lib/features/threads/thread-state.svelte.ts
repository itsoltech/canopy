import { create, equals } from "@bufbuild/protobuf";
import {
  ItemStatus,
  ItemSchema,
  TurnEndSource,
  TurnOrigin,
  TurnOutcome,
  ui,
  type TurnFinished,
  type TurnStarted,
  type Usage,
} from "@canopy/contracts";
import { eventItemId, reduceItem } from "@canopy/domain/items";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { orderThreadTurns } from "@canopy/domain/history-pages";
import { threadCache } from "./thread-cache.ts";
import { ThreadHistory } from "./history.svelte.ts";
import { classifyFailure, safeFailureDetail } from "@canopy/domain";
import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import { isFinished, upsertSchedule } from "#lib/features/schedules/schedules.ts";

import type { TimelineEntry, TimelineNotice, TurnResult } from "./thread-types.ts";

export type { TimelineEntry, TimelineNotice, TurnResult } from "./thread-types.ts";

/** connecting: first snapshot pending; live: stream open; reconnecting: dropped, EventSource retries. */
export type Connection = "connecting" | "syncing" | "live" | "reconnecting";

/**
 * Client state of one thread, fed by the SSE stream of WatchThread.
 * Items are folded with the same reducer the gateway uses for thread_items, so live view and
 * reload show the same thing. A (re)connect starts with a snapshot that replaces everything.
 */
const OUTCOME_STATUS = new Map([
  [TurnOutcome.COMPLETED, "completed"],
  [TurnOutcome.INTERRUPTED, "interrupted"],
  [TurnOutcome.FAILED, "failed"],
]);

const END_SOURCE = new Map([
  [TurnEndSource.USER, "user"],
  [TurnEndSource.SYSTEM, "system"],
  [TurnEndSource.PLATFORM, "platform"],
  [TurnEndSource.HARNESS, "harness"],
]);

/** Why a finished turn ended, until the gateway's turn update brings the stored values. */
function endFields(status: string | undefined, finished: TurnFinished) {
  // Who interrupted it or where its error came from.
  const source = END_SOURCE.get(finished.source) ?? "";

  switch (status) {
    case "failed":
      return {
        error: safeFailureDetail(finished.reason),
        errorSource: source || "harness",
        errorCode: finished.errorCode,
        errorClass: classifyFailure(finished.reason, finished.errorCode),
      };
    case "interrupted":
      return { interruptReason: finished.reason, interruptSource: source || "user" };
    default:
      return {};
  }
}

export class ThreadState {
  #snapshot: ui.ThreadSnapshot | undefined;
  readonly history = new ThreadHistory(
    this,
    () => this.#snapshot,
    () => {
      if (this.#snapshot) this.#snapshot = { ...this.#snapshot, cursor: "" };
    },
  );
  hasMore = $state(false);
  thread = $state.raw<ui.Thread | undefined>(undefined);
  turns = $state.raw<ui.Turn[]>([]);
  entries = $state.raw<TimelineEntry[]>([]);
  interactions = $state.raw<ui.Interaction[]>([]);
  secrets = $state.raw<ui.ThreadSecret[]>([]);
  notices = $state.raw<TimelineNotice[]>([]);
  /** The thread's schedules (the snapshot has the active and paused ones; changes arrive live). */
  schedules = $state.raw<ui.Schedule[]>([]);
  /** Messages steered into running turns, oldest first (the snapshot has all of the thread's; changes arrive live). */
  steers = $state.raw<ui.Steer[]>([]);
  /** Where this thread's spawn_thread / send_message calls went, by call id (snapshot, then live). */
  deliveries = $state.raw<ReadonlyMap<string, ui.BusDelivery>>(new Map());
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
  readonly queued = $derived(this.ownTurns.filter((t) => t.status === "queued" && !t.dispatched));
  /** Background tasks still running (items `background_task` in progress), oldest first. */
  readonly backgroundTasks = $derived(
    this.ownEntries.filter((e) => e.item.content.case === "backgroundTask" && e.item.status === ItemStatus.IN_PROGRESS),
  );
  /**
   * Steers on their way into the running turn: sent or accepted and not yet in the transcript (a
   * delivered one is a user_message item with `client_id` = its id; a queued one is a queued turn). The platform's
   * notes about background tasks are not messages: they show once they are in the turn.
   */
  readonly steering = $derived.by(() => {
    const echoed = new Set(
      this.ownEntries.flatMap((e) =>
        e.item.content.case === "userMessage" && e.item.content.value.clientId ? [e.item.content.value.clientId] : [],
      ),
    );

    return this.steers.filter(
      (s) =>
        (s.status === "pending" ||
          s.status === "accepted" ||
          (s.status === "failed" && s.shellCommand !== undefined)) &&
        !echoed.has(s.id) &&
        s.backgroundItemIds.length === 0,
    );
  });
  /**
   * Seeds the header from the client route load before the stream connects. A supplied snapshot (e.g.
   * in a fixture) renders immediately; the stream's first snapshot replaces it.
   */
  constructor(thread?: ui.Thread | undefined, snapshot?: ui.ThreadSnapshot | undefined) {
    this.thread = thread;
    snapshot ??= thread && threadCache.get(thread.id);

    if (snapshot) this.apply(create(ui.ThreadUpdateSchema, { change: { case: "snapshot", value: snapshot } }));

    if (snapshot) this.connection = "syncing";
  }

  apply(update: ui.ThreadUpdate): void {
    this.#snapshot = applyThreadUpdate(this.#snapshot, update);
    this.hasMore = this.#snapshot.historyHasMore;

    const change =
      update.change.case === "delta" ? { case: "snapshot" as const, value: this.#snapshot } : update.change;

    switch (change.case) {
      case "snapshot": {
        const snapshot = change.value;
        this.thread = snapshot.thread;
        const turns = new Map(this.turns.map((turn) => [turn.id, turn]));
        this.turns = snapshot.turns.map((turn) => {
          const previous = turns.get(turn.id);

          return previous && equals(ui.TurnSchema, previous, turn) ? previous : turn;
        });
        this.interactions = snapshot.interactions;
        this.secrets = snapshot.secrets;
        const known = new Map(this.entries.map((entry) => [`${entry.fromThreadId}:${entry.id}`, entry]));
        this.entries = snapshot.items.flatMap((i) => {
          const previous = known.get(`${i.fromThreadId}:${i.item?.itemId}`);
          const completedAt = i.completedAt ? timestampMs(i.completedAt) : previous?.completedAt;

          if (
            previous &&
            i.item &&
            equals(ItemSchema, previous.item, i.item) &&
            previous.turnId === i.turnId &&
            previous.firstSeq === i.firstSeq &&
            previous.inherited === i.inherited &&
            previous.completedAt === completedAt
          )
            return [previous];

          return i.item
            ? [
                {
                  id: i.item.itemId,
                  item: i.item,
                  turnId: i.turnId,
                  firstSeq: i.firstSeq,
                  inherited: i.inherited,
                  fromThreadId: i.fromThreadId,
                  startedAt: previous?.startedAt,
                  completedAt,
                },
              ]
            : [];
        });
        this.notices = snapshot.notices.flatMap((n) =>
          n.notice ? [{ seq: n.seq, turnId: n.turnId, notice: n.notice, at: n.occurredAt }] : [],
        );
        this.schedules = snapshot.schedules;
        this.steers = snapshot.steers;
        this.deliveries = new Map(snapshot.busDeliveries.map((d) => [d.callId, d]));
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
        const turn = this.#snapshot.turns.find((turn) => turn.id === change.value.id);

        if (turn) this.upsertTurn(turn);
        break;
      }

      case "secret":
        this.upsertSecret(change.value);
        break;
      case "interaction": {
        const index = this.interactions.findIndex((i) => i.requestId === change.value.requestId);
        this.interactions =
          index >= 0 ? this.interactions.with(index, change.value) : [...this.interactions, change.value];
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
      case "busDelivery":
        this.deliveries = new Map(this.deliveries).set(change.value.callId, change.value);
        break;
      default:
        break;
    }
  }

  /**
   * A turn changed here or live. Turns stay in ordinal order: a reordered queue moves its turns
   * (docs/ui-api.md, "Kolejka").
   */
  upsertTurn(turn: ui.Turn): void {
    const index = this.turns.findIndex((t) => t.id === turn.id);

    if (index >= 0 && this.turns[index]!.ordinal === turn.ordinal) this.turns = this.turns.with(index, turn);
    else this.turns = orderThreadTurns([...this.turns.filter((t) => t.id !== turn.id), turn]);
  }

  upsertSecret(secret: ui.ThreadSecret): void {
    const index = this.secrets.findIndex((s) => s.requestId === secret.requestId);
    this.secrets = index < 0 ? [...this.secrets, secret] : this.secrets.map((s, i) => (i === index ? secret : s));
  }

  /** A schedule created or changed here (also before the stream reports it). */
  upsertSchedule(schedule: ui.Schedule): void {
    if ((this.schedules.find((s) => s.id === schedule.id)?.version ?? 0) > schedule.version) return;

    if (schedule.threadId === this.thread?.id) this.schedules = upsertSchedule(this.schedules, schedule);
    else this.schedules = this.schedules.filter((s) => s.id !== schedule.id);
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
      id,
      item: next,
      turnId: previous?.turnId || event.turnId,
      firstSeq: previous?.firstSeq ?? seq,
      inherited: false,
      fromThreadId: "",
      startedAt: previous?.startedAt ?? (body.case === "itemStarted" ? at : undefined),
      // A message's latest completion counts (Claude marks its answer final with a second one), as in snapshots.
      completedAt:
        body.case === "itemCompleted" && (!previous?.completedAt || next.content.case === "agentMessage")
          ? (at ?? previous?.completedAt)
          : previous?.completedAt,
    };

    this.entries = index >= 0 ? this.entries.with(index, entry) : [...this.entries, entry];
  }

  /**
   * Turns the worker starts on its own (provider wake-up, recovery) reach the UI only as events, not as
   * turn updates; add them so the timeline frames them. A later turn update replaces this stand-in.
   */
  #started(turnId: string, started: TurnStarted, at: Timestamp | undefined): void {
    if (!turnId || this.turns.some((t) => t.id === turnId)) return;

    const trigger =
      started.origin === TurnOrigin.PROVIDER
        ? "provider"
        : started.origin === TurnOrigin.RECOVERY
          ? "recovery"
          : "user";

    const ordinal = Math.max(0, ...this.ownTurns.map((t) => t.ordinal)) + 1;
    this.turns = [
      ...this.turns,
      create(ui.TurnSchema, {
        id: turnId,
        ordinal,
        status: "running",
        trigger,
        ...(at && { queuedAt: at, startedAt: at }),
      }),
    ];
  }

  #finished(turnId: string, finished: TurnFinished, at: Timestamp | undefined): void {
    if (!turnId) return;
    this.turnResults = new Map(this.turnResults).set(turnId, { usage: finished.usage, reason: finished.reason });
    const index = this.turns.findIndex((t) => t.id === turnId && t.status === "running");

    const status = OUTCOME_STATUS.get(finished.outcome);
    const turn = this.turns[index];
    const end = endFields(status, finished);

    if (turn && status)
      this.turns = this.turns.with(index, { ...turn, status, ...end, ...(at && { completedAt: at }) });
  }

  /** Subscribes to the BFF event stream; returns the cleanup for $effect. */
  connect(threadId: string): () => void {
    const disconnect = this.history.connect(threadId);

    return () => {
      disconnect();

      if (this.#snapshot?.thread) threadCache.set(this.#snapshot);
    };
  }
}
