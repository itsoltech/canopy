import type { github } from "@canopy/contracts";
import { checkOutcome, countChecks, noteChecks, type PrChecksNote } from "@canopy/domain";
import { readWatchCheckPages } from "../github/check-watch-read.ts";
import type { GitHubPullRequests } from "../github/pull-requests.ts";
import { digest } from "../github/read-scope.ts";
import type { PrCheckWatchRow, WatchProgress } from "../store/pr-check-watches.ts";

const CONFIRM_AFTER_MS = 30_000;
const RETRY_AFTER_MS = 120_000;
const COUNTS = { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0 };

type Notification = Pick<PrChecksNote, "event" | "checks" | "omitted" | "counts" | "reason">;

interface Observation {
  progress: WatchProgress;
  notification?: Notification;
}

interface CheckRead {
  revision: string;
  nextRead: number;
  candidate?: { fingerprint: string; since: number };
}

export class AutomaticPrChecks {
  readonly #reads = new Map<string, CheckRead>();

  forget(watchId: string): void {
    this.#reads.delete(watchId);
  }

  retain(ids: ReadonlySet<string>): void {
    for (const id of this.#reads.keys()) if (!ids.has(id)) this.forget(id);
  }

  async observe(
    prs: GitHubPullRequests,
    watch: PrCheckWatchRow,
    snapshot: github.PullRequestSnapshot,
    revision: string,
    progress: WatchProgress,
    manual: boolean,
    now: number,
  ): Promise<Observation> {
    const state = snapshot.summary?.state;
    const watchId = watch.id;

    if (snapshot.mergeability === "conflicting" && state !== "merged") {
      this.forget(watchId);

      return {
        progress: { ...progress, conflicting: true },
        ...(!manual &&
          !progress.conflicting && {
            notification: { event: "ended", checks: [], omitted: 0, counts: COUNTS, reason: "conflict" },
          }),
      };
    }

    const next = snapshot.mergeability === "mergeable" ? { ...progress, conflicting: false } : progress;
    const previous = this.#reads.get(watchId);

    if (previous?.revision === revision && now < previous.nextRead && state !== "merged") return { progress: next };

    const confirm = state === "merged" || (!!previous?.candidate && now >= previous.candidate.since + CONFIRM_AFTER_MS);
    const page = await readWatchCheckPages(prs, watch.pull_request_id, snapshot, confirm);
    const counts = countChecks(page.checks);

    if (!page.complete || counts.pending > 0) {
      this.#reads.set(watchId, { revision, nextRead: now + RETRY_AFTER_MS });

      return { progress: next };
    }

    const fingerprint = digest(
      JSON.stringify(page.checks.map((c) => JSON.stringify([c.key, c.state, c.runId])).sort()),
    );

    if (counts.total === 0 || next.seen["result"] === fingerprint) {
      this.#reads.set(watchId, { revision, nextRead: Infinity });

      return { progress: next };
    }

    const candidate =
      previous?.candidate?.fingerprint === fingerprint ? previous.candidate : { fingerprint, since: now };

    if (!manual && state !== "merged" && now < candidate.since + CONFIRM_AFTER_MS) {
      this.#reads.set(watchId, { revision, candidate, nextRead: candidate.since + CONFIRM_AFTER_MS });

      return { progress: next };
    }

    this.#reads.set(watchId, { revision, nextRead: Infinity });
    const failed = page.checks.filter((check) => checkOutcome(check.state) === "failed");

    return {
      progress: { ...next, seen: { result: fingerprint }, settled: true },
      ...(!manual && { notification: { event: "complete", ...noteChecks(failed, 5), counts, reason: "" } }),
    };
  }
}
