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
import { ComposerConnection } from "@canopy/domain/composer-connection";
import { lastResult } from "#lib/shared/last-result.ts";
import { ReplySuggestionsState } from "./reply-suggestions.svelte.ts";

import type { TimelineEntry, TimelineNotice, TurnResult } from "./thread-types.ts";

export type { TimelineEntry, TimelineNotice, TurnResult } from "./thread-types.ts";

/** connecting: first snapshot pending; live: stream open; reconnecting: dropped, EventSource retries. */
export type Connection = "connecting" | "syncing" | "live" | "reconnecting" | "error";

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
  readonly replySuggestions = new ReplySuggestionsState();
  /** Approved automation observed live; never part of the cached snapshot or transcript. */
  automationActivity = $state.raw<ui.ThreadAutomationActivity>();
  #snapshot: ui.ThreadSnapshot | undefined;
  readonly #entryPositions = new Map<string, number>();
  readonly history = new ThreadHistory(
    this,
    () => this.#snapshot,
    () => {
      if (this.#snapshot) this.#snapshot = { ...this.#snapshot, cursor: "", syncCursor: undefined };

      if (this.thread) threadCache.forget(this.thread.id);
    },
  );
  hasMore = $state(false);
  historyItemsHasMore = $state(false);
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
  /** Latest accounting usage, live only. Context use is persisted separately on Thread. */
  usage = $state.raw<Usage | undefined>(undefined);
  readonly composerConnection = new ComposerConnection();
  #connection = $state<Connection>("connecting");
  get connection() {
    return this.#connection;
  }
  set connection(value: Connection) {
    this.#connection = value;
    this.composerConnection.update(value === "live");
  }
  /** The snapshot arrived at least once. */
  loaded = $state(false);
  failure = $state<string | undefined>(undefined);
  syncStatus = $state.raw<ui.ThreadSyncStatus | undefined>(undefined);

  // Retained views outlive the thread screen that created them (thread-views.ts). No `$derived` here: it would
  // freeze once that screen's effect is destroyed, showing stale turns and running state after a return.
  readonly #pending = lastResult((list: ui.Interaction[]) => list.filter((i) => i.status === "pending"));
  readonly #upcomingSchedules = lastResult((list: ui.Schedule[]) => list.filter((s) => !isFinished(s)));
  readonly #ownTurns = lastResult((list: ui.Turn[]) => list.filter((t) => !t.inherited));
  readonly #ownEntries = lastResult((list: TimelineEntry[]) => list.filter((e) => !e.inherited));
  readonly #inheritedTurns = lastResult((list: ui.Turn[]) => list.filter((t) => t.inherited));
  readonly #inheritedEntries = lastResult((list: TimelineEntry[]) => list.filter((e) => e.inherited));
  readonly #queued = lastResult((list: ui.Turn[]) => list.filter((t) => t.status === "queued" && !t.dispatched));
  readonly #backgroundTasks = lastResult((list: TimelineEntry[]) =>
    list.filter((e) => e.item.content.case === "backgroundTask" && e.item.status === ItemStatus.IN_PROGRESS),
  );
  readonly #steering = lastResult((entries: TimelineEntry[], steers: ui.Steer[]) => {
    const echoed = new Set(
      entries.flatMap((e) =>
        e.item.content.case === "userMessage" && e.item.content.value.clientId ? [e.item.content.value.clientId] : [],
      ),
    );

    return steers.filter(
      (s) =>
        (s.status === "pending" ||
          s.status === "accepted" ||
          (s.status === "failed" && s.shellCommand !== undefined)) &&
        !echoed.has(s.id) &&
        s.backgroundItemIds.length === 0 &&
        s.prChecks.length === 0,
    );
  });

  get pending() {
    return this.#pending(this.interactions);
  }
  get upcomingSchedules() {
    return this.#upcomingSchedules(this.schedules);
  }
  /** The thread's own turns and items; a fork's inherited history is kept apart. */
  get ownTurns() {
    return this.#ownTurns(this.turns);
  }
  get ownEntries() {
    return this.#ownEntries(this.entries);
  }
  get inheritedTurns() {
    return this.#inheritedTurns(this.turns);
  }
  get inheritedEntries() {
    return this.#inheritedEntries(this.entries);
  }
  get running() {
    return this.ownTurns.some((t) => t.status === "running");
  }
  get queued() {
    return this.#queued(this.ownTurns);
  }
  /** Background tasks still running (items `background_task` in progress), oldest first. */
  get backgroundTasks() {
    return this.#backgroundTasks(this.ownEntries);
  }
  /**
   * Steers on their way into the running turn: sent or accepted and not yet in the transcript (a
   * delivered one is a user_message item with `client_id` = its id; a queued one is a queued turn). The platform's
   * notes about background tasks are not messages: they show once they are in the turn.
   */
  get steering() {
    return this.#steering(this.ownEntries, this.steers);
  }
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

  /** The checkpoint the view shows (items, older pages and sync cursor). */
  get snapshot(): ui.ThreadSnapshot | undefined {
    return this.#snapshot;
  }

  apply(update: ui.ThreadUpdate): void {
    this.#snapshot = applyThreadUpdate(this.#snapshot, update);
    this.hasMore = this.#snapshot.historyHasMore || this.#snapshot.historyItemsHasMore;
    this.historyItemsHasMore = this.#snapshot.historyItemsHasMore;

    const change = ["snapshot", "delta", "batch", "controls"].includes(update.change.case ?? "")
      ? { case: "snapshot" as const, value: this.#snapshot }
      : update.change;

    switch (change.case) {
      case "automationActivity":
        this.automationActivity = change.value;
        break;
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
            previous.contentRef?.sha256 === i.contentRef?.sha256 &&
            previous.completedAt === completedAt
          )
            return [previous];

          return i.item
            ? [
                {
                  id: i.item.itemId,
                  item: i.item,
                  contentRef: i.contentRef,
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
        this.#entryPositions.clear();
        this.entries.forEach((entry, index) => {
          if (!entry.inherited && !this.#entryPositions.has(entry.id)) this.#entryPositions.set(entry.id, index);
        });
        this.notices = snapshot.notices.flatMap((n) =>
          n.notice ? [{ seq: n.seq, turnId: n.turnId, notice: n.notice, at: n.occurredAt }] : [],
        );
        this.schedules = snapshot.schedules;
        this.steers = snapshot.steers;
        this.deliveries = new Map(snapshot.busDeliveries.map((d) => [d.callId, d]));
        this.goal = snapshot.goal;
        // Accounting usage is live only: keep what this tab saw before the reconnect.
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
      case "turnPermissionsChanged":
        this.turns = this.turns.map((turn) =>
          turn.id === event.turnId && !turn.inherited ? { ...turn, permissionMode: body.value.permissionMode } : turn,
        );

        return;
      case "turnFinished":
        this.#finished(event.turnId, body.value, event.occurredAt);

        return;
      case "usageUpdated":
        if (body.value.usage) this.usage = body.value.usage;

        return;
      default:
        break;
    }

    const id = eventItemId(body);

    if (!id) return;
    // Live events are the thread's own; an inherited item may share its id with the source's copy.
    const index = this.#entryPositions.get(id) ?? -1;
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

    if (index >= 0) this.entries = this.entries.with(index, entry);
    else {
      this.#entryPositions.set(id, this.entries.length);
      this.entries = [...this.entries, entry];
    }
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
  connect(threadId: string, overviewStatus?: () => string | undefined): () => void {
    const disconnect = this.history.connect(threadId, overviewStatus);

    return () => {
      disconnect();
      this.composerConnection.reset();
    };
  }
}
