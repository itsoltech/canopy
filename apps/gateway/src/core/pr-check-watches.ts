import type { JsonValue } from "@bufbuild/protobuf";
import type { github } from "@canopy/contracts";
import { Code } from "@connectrpc/connect";
import {
  checkOutcome,
  DEFAULT_BUS_LIMITS,
  judgeChecks,
  NO_CHECKS_MS,
  noteChecks,
  PR_CHECK_EVENTS,
  type CheckCounts,
  type NoteReason,
  type PrCheckEvent,
  type PrChecksNote,
  type WatchedCheck,
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
});

export class PrCheckWatches {
  readonly #host: PrCheckWatchesHost;
  #timer: ReturnType<typeof setInterval> | undefined;
  #flight: Promise<void> | undefined;
  /** Per watch: the producer revision its checks were last read at, when, and how many there were (pending). */
  readonly #read = new Map<string, { revision: string; at: number; total: number; pending: number }>();
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

  async #tick(): Promise<void> {
    const now = this.github.prs.accounts.http.now();
    const live: PrCheckWatchRow[] = [];

    for (const w of await this.run((s) => s.active(this.github.owner))) {
      if (!w.thread_open) await this.run((s) => s.end(w.owner_user_id, w.id, "thread_closed", true));
      else if (!w.linked) await this.#ended(w, "unlinked");
      else if (now >= new Date(w.expires_at).getTime()) await this.#ended(w, "timeout");
      else live.push(w);
    }

    const updates = await pollAgentWatches(this.github.prs, new Set(live.map((w) => w.pull_request_id)));

    for (const w of live)
      await this.#judge(w, updates.get(w.pull_request_id), now).catch((cause: unknown) =>
        this.#host.log(`CI watch ${w.id}: ${githubFailure(cause).rawMessage}`),
      );

    for (const id of this.#read.keys()) if (!live.some((w) => w.id === id)) this.#read.delete(id);
    const threads = await this.run((s) => s.pendingThreads(this.github.owner));

    for (const threadId of threads) {
      await this.deliver(threadId);
      await this.#host.pump(threadId);
    }
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
      progress = {
        headSha: summary.headSha,
        headSeenAt: new Date(now),
        headChanges: w.head_changes + 1,
        headChanged: true,
        seen: {},
        settled: false,
      };
      this.#read.delete(w.id);
    }

    const previous = this.#read.get(w.id);
    const stale = now - progress.headSeenAt.getTime() >= NO_CHECKS_MS;

    const quiet =
      previous?.revision === update.revision &&
      (previous.total > 0 || !stale) &&
      (previous.pending === 0 || now - previous.at < PENDING_REREAD_MS);

    if (quiet) return;

    const checks = await readWatchedChecks(this.github.prs, w.pull_request_id, update.snapshot);
    const pending = checks.filter((c) => checkOutcome(c.state) === "pending").length;
    await this.#settle(w, progress, checks, stale);
    this.#read.set(w.id, { revision: update.revision, at: now, total: checks.length, pending });
  }

  async #settle(w: PrCheckWatchRow, progress: WatchProgress, checks: readonly WatchedCheck[], stale: boolean) {
    const verdict = judgeChecks(w.notify_on.filter(isEvent), checks, progress);
    const next = { ...progress, seen: verdict.seen, settled: verdict.settled };
    const end = verdict.outcome === "passed" ? "passed" : checks.length === 0 && stale ? "no_checks" : undefined;

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
  async #ended(w: PrCheckWatchRow, reason: Exclude<NoteReason, "">): Promise<void> {
    const progress = progressOf(w);
    const body = this.#body(w, progress, { event: "ended", checks: [], omitted: 0, counts: NO_COUNTS, reason });
    await this.#note(w, progress, body, reason);
  }

  #body(
    w: PrCheckWatchRow,
    progress: WatchProgress,
    rest: Pick<PrChecksNote, "event" | "checks" | "omitted" | "counts" | "reason">,
  ): PrChecksNote {
    return {
      watch_id: w.id,
      pull_request_id: w.pull_request_id,
      repository: w.repository_name,
      number: w.number,
      url: pullRequestUrl(w.repository_name, w.number),
      head_sha: progress.headSha,
      head_changed: progress.headChanged,
      ...rest,
      watching: !rest.reason,
      until: new Date(w.expires_at).toISOString(),
    };
  }

  async #note(w: PrCheckWatchRow, progress: WatchProgress, body: PrChecksNote, end: string | undefined) {
    const hops = w.hops + progress.headChanges;
    const wake = hops <= DEFAULT_BUS_LIMITS.maxHops;
    await this.run((s) => s.note(w.owner_user_id, w.id, progress, { body, wake, hops, ...(end && { end }) }));
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
