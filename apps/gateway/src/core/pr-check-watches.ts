import type { JsonValue } from "@bufbuild/protobuf";
import type { github } from "@canopy/contracts";
import { Code } from "@connectrpc/connect";
import {
  DEFAULT_BUS_LIMITS,
  judgeChecks,
  NO_CHECKS_MS,
  noteChecks,
  PR_CHECK_EVENTS,
  type CheckCounts,
  type NoteReason,
  type PrCheckEvent,
  type PrChecksNote,
  type CheckVerdict,
} from "@canopy/domain";
import type { Effect } from "effect";
import { readWatchedChecks } from "../github/check-watch-read.ts";
import { githubFailure } from "../github/http.ts";
import type { GitHubAccounts } from "../github/service.ts";
import { followPullRequestAfterChecks, pollAgentWatches } from "../github/watch.ts";
import {
  PrCheckWatchStore,
  type CallSource,
  type PrCheckWatchRow,
  type ThreadRow,
  type TurnRow,
  type WatchProgress,
} from "../store/index.ts";
import { prCheckTool, pullRequestUrl, type PrCheckCall } from "./pr-check-tools.ts";
import { AutomaticPrChecks } from "./automatic-pr-checks.ts";

/**
 * CI check watches of pull requests linked to a thread (docs/agent-bus.md, "Checki CI"; docs/github.md §10).
 *
 * - tools: watch_pr_checks, list_pr_watches, cancel_pr_watch (pr-check-tools.ts),
 * - tick() (every few seconds): ends watches whose thread closed, whose pull request was unlinked or whose time is up;
 *   holds the others' pull requests in the visible PR producer (github/watch.ts: same deadlines, validators and
 *   single flight, no second poller), reads the head's checks when its signal changed, follows new commits and judges
 *   the checks (judgeChecks). What the agent should hear is stored as a note,
 * - notes reach the agent like background task notes: a steer of the running turn, else a turn of its own
 *   (trigger pr_checks); a steer that did not join hands its notes back (release).
 */

export interface PrCheckWatchesHost {
  run<A, E>(effect: Effect.Effect<A, E, PrCheckWatchStore>): Promise<A>;
  readonly github: GitHubAccounts;
  /** A turn was queued: announce it and start it when the thread is free. */
  queued(threadId: string, turn: TurnRow): Promise<void>;
  /** Recover a note turn committed before its dispatch. */
  pump(threadId: string): Promise<void>;
  /** A steer was stored: send it to the worker. */
  steered(steerId: string): Promise<void>;
  log(message: string): void;
  /** A watch started or ended: the thread's pull request list (its active watches) changed. */
  changed(threadId: string): Promise<void>;
}

const TICK_MS = 5_000;

/**
 * Pending checks are read again at least this often even when the producer's signal did not move: its baseline for
 * a new commit is taken a tick after the commit's first checks read, so a change in between leaves no signal.
 */
const PENDING_REREAD_MS = 120_000;
const isEvent = (value: string): value is PrCheckEvent => PR_CHECK_EVENTS.some((e) => e === value);
const NO_COUNTS: CheckCounts = { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0 };

const progressOf = (w: PrCheckWatchRow): WatchProgress => ({
  headSha: w.head_sha,
  headSeenAt: new Date(w.head_seen_at),
  headChanges: w.head_changes,
  headChanged: w.head_changed,
  seen: w.seen,
  settled: w.settled,
  conflicting: w.conflicting,
});

const followHead = (progress: WatchProgress, headSha: string, now: number): WatchProgress => ({
  ...progress,
  headSha,
  headSeenAt: new Date(now),
  headChanges: Math.min(progress.headChanges + 1, 32_767),
  headChanged: !!progress.headSha,
  seen: {},
  settled: false,
});

const linkedPair = (w: PrCheckWatchRow) => `${w.thread_id}:${w.pull_request_id}`;

export class PrCheckWatches {
  readonly #host: PrCheckWatchesHost;
  #timer: ReturnType<typeof setInterval> | undefined;
  #flight: Promise<void> | undefined;
  /** Per watch: the producer revision its checks were last read at, when, and how many there were (pending). */
  readonly #read = new Map<string, { revision: string; at: number; total: number; needsReread: boolean }>();
  readonly #automatic = new AutomaticPrChecks();
  /** Threads being delivered: a second call waits for the first one, then runs again. */
  readonly #delivering = new Map<string, Promise<void>>();

  constructor(host: PrCheckWatchesHost) {
    this.#host = host;
  }

  get github(): GitHubAccounts {
    return this.#host.github;
  }

  run<A, E>(use: (s: PrCheckWatchStore["Service"]) => Effect.Effect<A, E>): Promise<A> {
    return this.#host.run(PrCheckWatchStore.use(use));
  }

  async tool(call: PrCheckCall, source: CallSource, caller: ThreadRow, hops: number): Promise<JsonValue> {
    const result = await prCheckTool(this, call, source, caller, hops);

    if (call.tool !== "list_pr_watches") await this.#host.changed(caller.id);

    return result;
  }

  /** Polls the active watches once, then hands waiting notes over (single flight). */
  tick(): Promise<void> {
    return (this.#flight ??= this.#tick().finally(() => {
      this.#flight = undefined;
    }));
  }

  /** The archive sweep may discover a merge after an in-flight check tick took its snapshot. */
  async beforeMergeArchive(): Promise<void> {
    await this.#flight;
    await this.tick();
  }

  async #tick(): Promise<void> {
    const now = this.github.prs.accounts.http.now();
    const live: PrCheckWatchRow[] = [];

    for (const w of await this.run((s) => s.active(this.github.owner))) {
      if (!w.thread_open) await this.run((s) => s.end(w.owner_user_id, w.id, "thread_closed", true));
      else if (!w.linked) {
        if (w.call_id) await this.#ended(w, "unlinked");
        else await this.run((s) => s.end(w.owner_user_id, w.id, "unlinked", true));
      } else if (w.expires_at && now >= new Date(w.expires_at).getTime()) await this.#ended(w, "timeout");
      else live.push(w);
    }

    const updates = await pollAgentWatches(this.github.prs, new Set(live.map((w) => w.pull_request_id)));
    const manual = live.filter((w) => w.call_id);
    const covered = new Set(manual.map(linkedPair));

    for (const w of manual)
      await this.#judge(w, updates.get(w.pull_request_id), now).catch((cause: unknown) =>
        this.#host.log(`CI watch ${w.id}: ${githubFailure(cause).rawMessage}`),
      );

    for (const w of live) {
      if (w.call_id) continue;
      const update = updates.get(w.pull_request_id);

      if (!update || update instanceof Error) continue;
      await this.#judgeAutomatic(w, update, covered.has(linkedPair(w)), now).catch((cause: unknown) => {
        this.#automatic.forget(w.id);
        this.#host.log(`Automatic PR notifications ${w.id}: ${githubFailure(cause).rawMessage}`);
      });
    }

    const liveIds = new Set(live.map((w) => w.id));

    for (const id of this.#read.keys()) if (!liveIds.has(id)) this.#read.delete(id);
    this.#automatic.retain(liveIds);
    const threads = await this.run((s) => s.pendingThreads(this.github.owner));

    for (const threadId of threads) {
      await this.deliver(threadId);
      await this.#host.pump(threadId);
    }
  }

  async #judgeAutomatic(w: PrCheckWatchRow, update: github.PullRequestUpdate, covered: boolean, now: number) {
    const snapshot = update.snapshot;
    const summary = snapshot?.summary;

    if (!summary?.headSha || !snapshot || snapshot.stale) return;
    const state = summary.state;

    if (state === "closed") {
      await this.run((s) => s.end(w.owner_user_id, w.id, state, false));

      return;
    }

    const previous = progressOf(w);
    const moved = previous.headSha !== summary.headSha;

    if (moved) this.#automatic.forget(w.id);
    const progress = moved ? followHead(previous, summary.headSha, now) : previous;

    const observed = await this.#automatic.observe(
      this.github.prs,
      w,
      snapshot,
      update.revision,
      progress,
      covered,
      now,
    );

    if (observed.notification) {
      const body = this.#body(w, observed.progress, observed.notification, state !== "merged");
      await this.#note(w, observed.progress, body, state === "merged" ? state : undefined);
    } else if (state === "merged") await this.run((s) => s.end(w.owner_user_id, w.id, state, false));
    else if (moved || observed.progress.conflicting !== w.conflicting || observed.progress.seen !== progress.seen)
      await this.run((s) => s.progress(w.owner_user_id, w.id, observed.progress));
  }

  async #judge(w: PrCheckWatchRow, update: github.PullRequestUpdate | Error | undefined, now: number): Promise<void> {
    if (update instanceof Error) {
      if ([Code.PermissionDenied, Code.NotFound].includes(githubFailure(update).code)) await this.#ended(w, "access");
      else throw update;

      return;
    }

    const summary = update?.snapshot?.summary;

    if (!update?.snapshot || !summary) return;

    if (summary.state === "merged" || summary.state === "closed") return this.#ended(w, summary.state);
    let progress = progressOf(w);
    const moved = !!summary.headSha && summary.headSha !== w.head_sha;

    if (moved) {
      // A new commit: its checks start over; each followed commit adds a hop (an agent pushing fixes in a loop).
      progress = followHead(progress, summary.headSha, now);
      this.#read.delete(w.id);
    }

    if (!update.snapshot.stale && update.snapshot.mergeability === "conflicting")
      return this.#ended(w, "conflict", progress);

    const previous = this.#read.get(w.id);
    const stale = now - progress.headSeenAt.getTime() >= NO_CHECKS_MS;

    const quiet =
      previous?.revision === update.revision &&
      (previous.total > 0 || !stale) &&
      (!previous.needsReread || now - previous.at < PENDING_REREAD_MS);

    if (quiet) return;

    const checks = await readWatchedChecks(this.github.prs, w.pull_request_id, update.snapshot);
    const verdict = judgeChecks(w.notify_on.filter(isEvent), checks, progress);
    let waiting = verdict.outcome === "passed" && update.snapshot.mergeability === "unknown";

    if (verdict.outcome === "passed" && !waiting) {
      // CI can finish on the fast tick before the next metadata probe notices that the base moved.
      const current = await this.github.prs.load(w.repository_name, w.number, true, true);

      if (current.summary?.headSha !== progress.headSha) return;
      const state = current.summary?.state;

      if (!current.stale && (state === "closed" || state === "merged")) return this.#ended(w, state, progress);

      if (!current.stale && current.mergeability === "conflicting") return this.#ended(w, "conflict", progress);
      waiting = current.stale || current.mergeability === "unknown";
    }

    if (waiting) await this.run((s) => s.progress(w.owner_user_id, w.id, { ...progress, settled: false }));
    else await this.#settle(w, progress, verdict, stale);

    this.#read.set(w.id, {
      revision: update.revision,
      at: now,
      total: checks.length,
      needsReread: waiting || verdict.counts.pending > 0,
    });
  }

  async #settle(w: PrCheckWatchRow, progress: WatchProgress, verdict: CheckVerdict, stale: boolean) {
    const next = { ...progress, seen: verdict.seen, settled: verdict.settled };
    const end = verdict.outcome === "passed" ? "passed" : verdict.counts.total === 0 && stale ? "no_checks" : undefined;

    // Every check passed: told only when the agent asked for complete (or each, with the last checks).
    if (!verdict.event && end !== "no_checks") {
      await this.run((s) => (end ? s.end(w.owner_user_id, w.id, end, false) : s.progress(w.owner_user_id, w.id, next)));

      if (end) await this.#host.changed(w.thread_id);

      return;
    }

    const body = this.#body(w, next, {
      event: verdict.event ?? "ended",
      ...noteChecks(verdict.checks),
      counts: verdict.counts,
      reason: end ?? "",
    });

    await this.#note(w, next, body, end);

    if (end === "passed") await followPullRequestAfterChecks(this.github.prs, w.pull_request_id);
  }

  /** The watch ends for a reason the agent hears about (with the last known progress). */
  async #ended(w: PrCheckWatchRow, reason: Exclude<NoteReason, "">, progress = progressOf(w)): Promise<void> {
    const body = this.#body(w, progress, { event: "ended", checks: [], omitted: 0, counts: NO_COUNTS, reason });
    await this.#note(w, progress, body, reason);
  }

  #body(
    w: PrCheckWatchRow,
    progress: WatchProgress,
    rest: Pick<PrChecksNote, "event" | "checks" | "omitted" | "counts" | "reason">,
    watching = !rest.reason,
  ): PrChecksNote {
    return {
      watch_id: w.id,
      ...(!w.call_id && { automatic: true }),
      pull_request_id: w.pull_request_id,
      repository: w.repository_name,
      number: w.number,
      url: pullRequestUrl(w.repository_name, w.number),
      head_sha: progress.headSha,
      head_changed: progress.headChanged,
      ...rest,
      watching,
      until: w.expires_at ? new Date(w.expires_at).toISOString() : "",
    };
  }

  async #note(w: PrCheckWatchRow, progress: WatchProgress, body: PrChecksNote, end: string | undefined) {
    const hops = w.call_id ? w.hops + progress.headChanges : w.hops;
    const wake = hops <= DEFAULT_BUS_LIMITS.maxHops;
    await this.run((s) => s.note(w.owner_user_id, w.id, progress, { body, wake, hops, ...(end && { end }) }));

    if (!w.call_id) return;
    await this.deliver(w.thread_id);

    if (end) await this.#host.changed(w.thread_id);
  }

  /** Hands the thread's waiting notes to its agent (idempotent; one pass per thread at a time). */
  async deliver(threadId: string): Promise<void> {
    const previous = this.#delivering.get(threadId);

    const next = (previous ?? Promise.resolve())
      .then(async () => {
        const delivery = await this.run((s) => s.deliver(this.github.owner, threadId));

        if (delivery.turn) await this.#host.queued(threadId, delivery.turn);

        if (delivery.steerId) await this.#host.steered(delivery.steerId);
      })
      .catch((cause: unknown) =>
        this.#host.log(`CI check notes of thread ${threadId} not delivered: ${String(cause)}`),
      );

    this.#delivering.set(threadId, next);
    await next;

    if (this.#delivering.get(threadId) === next) this.#delivering.delete(threadId);
  }

  /** A platform note steer that did not join its turn: when it carried CI notes, they are delivered anew. */
  async release(threadId: string, steerId: string): Promise<void> {
    if (await this.run((s) => s.release(steerId))) await this.deliver(threadId);
  }

  start(intervalMs = TICK_MS): void {
    const run = () => void this.tick().catch((cause: unknown) => this.#host.log(`CI check watches: ${String(cause)}`));

    this.#timer ??= setInterval(run, intervalMs);
    this.#timer.unref?.();
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#flight;
  }
}
