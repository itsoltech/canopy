import { create, toJsonString } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GitHubPullRequests } from "./pull-requests.ts";
import { checks } from "./checks.ts";
import { digest, readScope, type ReadScope } from "./read-scope.ts";
import { readProbe, terminalSnapshot, watchScope, type ProbeTarget, type ProbeSignal } from "./watch-probes.ts";

interface Producer {
  viewers: number;
  panels: number;
  /** Agent CI watches (core/pr-check-watches.ts) hold the producer like a visible panel. */
  agents: boolean;
  nextSlow: number;
  nextFast: number;
  index: number;
  targets: ProbeTarget[];
  signals: Map<string, ProbeSignal & { expires: number }>;
  update?: github.PullRequestUpdate;
  flight?: Promise<void> | undefined;
  cleanup?: ReturnType<typeof setTimeout> | undefined;
  controller?: AbortController;
  mergeFollowUpUntil: number;
  nextMergeFollowUp: number;
  mergeFollowUpTimer?: ReturnType<typeof setTimeout> | undefined;
}

const producers = new WeakMap<GitHubPullRequests, Map<string, Producer>>();
const jitter = (ms: number) => ms * (1 + Math.random() * 0.1);
const targetKey = (target: ProbeTarget) => `${target.kind}:${target.page}`;
const MERGE_FOLLOW_UP_MS = 2 * 60_000;
const MERGE_FOLLOW_UP_INTERVAL_MS = 10_000;

const newProducer = (): Producer => ({
  viewers: 0,
  panels: 0,
  agents: false,
  nextSlow: 0,
  nextFast: Infinity,
  index: 0,
  targets: [
    { kind: "metadata", page: 1 },
    { kind: "checks", page: 1 },
    { kind: "statuses", page: 1 },
  ],
  signals: new Map(),
  mergeFollowUpUntil: 0,
  nextMergeFollowUp: Infinity,
});

const mergeFollowUpActive = (prs: GitHubPullRequests, p: Producer) => p.mergeFollowUpUntil > prs.accounts.http.now();

/** The sweep and streams share the same deadlines and single flight; there is no second header poller. */
export async function pollVisiblePullRequests(prs: GitHubPullRequests) {
  for (const [id, p] of producers.get(prs) ?? []) {
    if (!p.viewers && !p.panels && !p.agents && !mergeFollowUpActive(prs, p)) continue;
    await poll(prs, id, p);
  }
}

const producerOf = (prs: GitHubPullRequests, id: string) => {
  let entries = producers.get(prs);

  if (!entries) {
    entries = new Map();
    producers.set(prs, entries);
  }

  let p = entries.get(id);

  if (!p) {
    p = newProducer();
    entries.set(id, p);
  }

  return { entries, p };
};

/** Drops a producer nobody holds any more after the shared 5 minute grace. */
const idle = (prs: GitHubPullRequests, id: string, p: Producer) => {
  if (p.viewers || p.panels || p.agents || mergeFollowUpActive(prs, p)) return;
  p.controller?.abort();
  clearTimeout(p.mergeFollowUpTimer);
  clearTimeout(p.cleanup);
  p.cleanup = setTimeout(() => producers.get(prs)?.delete(id), 300_000);
  p.cleanup.unref?.();
};

function scheduleMergeFollowUp(prs: GitHubPullRequests, id: string, p: Producer) {
  clearTimeout(p.mergeFollowUpTimer);

  if (!mergeFollowUpActive(prs, p)) {
    p.mergeFollowUpUntil = 0;
    p.nextMergeFollowUp = Infinity;
    idle(prs, id, p);

    return;
  }

  const delay = Math.max(250, p.nextMergeFollowUp - prs.accounts.http.now());
  p.mergeFollowUpTimer = setTimeout(() => {
    p.mergeFollowUpTimer = undefined;
    void poll(prs, id, p)
      .then(() => scheduleMergeFollowUp(prs, id, p))
      .catch(() => {
        if (mergeFollowUpActive(prs, p)) {
          p.nextMergeFollowUp = prs.accounts.http.now() + jitter(MERGE_FOLLOW_UP_INTERVAL_MS);
          scheduleMergeFollowUp(prs, id, p);
        }
      });
  }, delay);
  p.mergeFollowUpTimer.unref?.();
}

/**
 * After CI passes, auto-merge may still need a short time to update the PR state. Keep the existing producer alive
 * for conditional metadata probes so the thread overview catches that transition without a second poller.
 */
export async function followPullRequestAfterChecks(prs: GitHubPullRequests, id: string) {
  const { p } = producerOf(prs, id);
  clearTimeout(p.cleanup);
  p.mergeFollowUpUntil = Math.max(p.mergeFollowUpUntil, prs.accounts.http.now() + MERGE_FOLLOW_UP_MS);
  p.nextMergeFollowUp = prs.accounts.http.now();

  await poll(prs, id, p).catch(() => {
    p.nextMergeFollowUp = prs.accounts.http.now() + jitter(MERGE_FOLLOW_UP_INTERVAL_MS);
  });

  scheduleMergeFollowUp(prs, id, p);
}

/**
 * Agent CI watches share the visible producer's deadlines, validators and single flight (no second poller): the
 * pull requests in `ids` are held and polled when due; the others are let go. Returns each held one's latest update.
 */
export async function pollAgentWatches(prs: GitHubPullRequests, ids: ReadonlySet<string>) {
  for (const [id, p] of producers.get(prs) ?? [])
    if (p.agents && !ids.has(id)) {
      p.agents = false;
      idle(prs, id, p);
    }

  const updates = new Map<string, github.PullRequestUpdate | Error>();

  for (const id of ids) {
    const { p } = producerOf(prs, id);
    clearTimeout(p.cleanup);
    p.agents = true;

    try {
      await poll(prs, id, p);

      if (p.update) updates.set(id, p.update);
    } catch (error) {
      updates.set(id, error instanceof Error ? error : new Error(String(error)));
    }
  }

  return updates;
}

async function probe(scope: ReadScope, p: Producer, target: ProbeTarget, signal: AbortSignal, force = false) {
  signal.throwIfAborted();
  const result = await readProbe(scope, target, signal, force);
  p.signals.set(targetKey(target), result);

  for (let page = 2; page <= Math.min(30, result.pages); page++)
    if (!p.targets.some((item) => item.kind === target.kind && item.page === page))
      p.targets.push({ kind: target.kind, page });
  p.targets = p.targets.filter((item) => item.kind !== target.kind || item.page <= result.pages);

  return result.changed;
}

function publish(p: Producer, snapshot: github.PullRequestSnapshot, invalidated: string[]) {
  const revision = digest(
    JSON.stringify([
      toJsonString(
        github.PullRequestSnapshotSchema,
        create(github.PullRequestSnapshotSchema, {
          ...snapshot,
          summary: snapshot.summary ? { ...snapshot.summary, verifiedAt: undefined } : undefined,
        }),
      ),
      [...p.signals].map(([key, value]) => [key, value.revision]),
    ]),
  );

  p.update = create(github.PullRequestUpdateSchema, { snapshot, revision, invalidated });
}

async function refreshChecks(scope: ReadScope, signal: AbortSignal) {
  signal.throwIfAborted();
  const request = create(github.PullRequestPageRequestSchema, { pullRequestId: scope.pr.id, refresh: true });
  await checks(await readScope(scope.prs, request, "checks", true, scope.snapshot), signal, async (state, count) => {
    await scope.prs.accounts.run((s) =>
      s.cacheChecks(scope.row, scope.pr.repository_id, scope.pr.number, scope.head, state, count),
    );
  });

  return watchScope(scope.prs, scope.pr.id);
}

/** Metadata on every slow tick plus one idle CI resource. Running checks keep their faster deadline. */
async function poll(prs: GitHubPullRequests, id: string, p: Producer) {
  if (p.flight) return p.flight;
  const controller = new AbortController();
  p.controller = controller;
  const signal = controller.signal;
  p.flight = (async () => {
    signal.throwIfAborted();
    let scope = await watchScope(prs, id);
    const now = prs.accounts.http.now();
    const mergeFollowUp = mergeFollowUpActive(prs, p);
    const previous = p.update?.snapshot;

    if (
      previous &&
      (previous.accountId !== scope.snapshot.accountId ||
        previous.accessRevision !== scope.snapshot.accessRevision ||
        previous.summary?.headSha !== scope.head ||
        previous.baseSha !== scope.snapshot.baseSha ||
        terminalSnapshot(previous) !== terminalSnapshot(scope.snapshot))
    ) {
      p.signals.clear();
      p.targets = newProducer().targets;
      p.nextSlow = 0;
    }

    const changedSnapshot =
      !!previous &&
      toJsonString(github.PullRequestSnapshotSchema, previous) !==
        toJsonString(github.PullRequestSnapshotSchema, scope.snapshot);

    if (!p.update || changedSnapshot)
      publish(p, scope.snapshot, changedSnapshot ? ["timeline", "reviews", "checks", "files", "commits"] : []);

    if (terminalSnapshot(scope.snapshot)) {
      p.nextSlow = p.nextFast = Infinity;
      p.mergeFollowUpUntil = 0;
      p.nextMergeFollowUp = Infinity;
      clearTimeout(p.mergeFollowUpTimer);

      return;
    }

    const initial = !p.signals.size && !mergeFollowUp;

    if (!mergeFollowUp && !initial && now < Math.min(p.nextSlow, p.nextFast)) return;

    let metadataChanged = false,
      checksChanged = false;

    const targets = mergeFollowUp
      ? now >= p.nextMergeFollowUp
        ? p.targets.filter((target) => target.kind === "metadata")
        : []
      : initial
        ? [...p.targets]
        : now >= p.nextFast
          ? p.targets.filter((target) => p.signals.get(targetKey(target))?.running)
          : [];

    if (!mergeFollowUp && !initial && now >= p.nextSlow) {
      const metadata = p.targets.find((target) => target.kind === "metadata");

      if (metadata && !targets.includes(metadata)) targets.push(metadata);

      const slow = p.targets.filter(
        (target) => target.kind !== "metadata" && !p.signals.get(targetKey(target))?.running,
      );

      const target = slow[p.index++ % slow.length];

      if (target && !targets.includes(target)) targets.push(target);
    }

    for (const target of targets) {
      if (await probe(scope, p, target, signal, mergeFollowUp && target.kind === "metadata")) {
        if (target.kind === "metadata") metadataChanged = true;
        else checksChanged = true;
      }
    }

    const invalidated: string[] = [];

    if (metadataChanged) {
      signal.throwIfAborted();
      const snapshot = await prs.load(scope.pr.repository_name, scope.pr.number, true, true);
      scope = await readScope(prs, scope.request, "watch", true, snapshot);
      invalidated.push("timeline", "reviews");

      if (previous?.summary?.headSha !== snapshot.summary?.headSha || previous?.baseSha !== snapshot.baseSha) {
        invalidated.push("files", "commits");
        p.signals.clear();
        checksChanged = true;
      }

      await prs.changed(scope.pr.repository_id);
    }

    if (checksChanged) {
      scope = await refreshChecks(scope, signal);
      invalidated.push("checks");
    }

    if (metadataChanged || checksChanged) publish(p, scope.snapshot, invalidated);

    if (mergeFollowUp) {
      p.nextMergeFollowUp = Math.min(p.mergeFollowUpUntil, now + jitter(MERGE_FOLLOW_UP_INTERVAL_MS));

      if (terminalSnapshot(scope.snapshot)) {
        p.mergeFollowUpUntil = 0;
        p.nextMergeFollowUp = Infinity;
      }

      return;
    }

    if (initial || now >= p.nextSlow)
      p.nextSlow = Math.max(now + jitter(60_000), p.signals.get("metadata:1")?.expires ?? 0);

    if (!p.signals.size) p.nextSlow = 0;
    const running = [...p.signals.values()].filter((value) => value.running);
    p.nextFast = running.length ? Math.max(now + jitter(15_000), ...running.map((value) => value.expires)) : Infinity;

    if (terminalSnapshot(scope.snapshot)) p.nextSlow = p.nextFast = Infinity;
  })().finally(() => {
    p.flight = undefined;
  });

  return p.flight;
}

/** Hidden clients abort; renewable leases bound abandoned views to 90 seconds. */
export async function* watchPullRequest(
  prs: GitHubPullRequests,
  request: github.WatchPullRequestRequest,
  signal: AbortSignal,
) {
  if (!["view", "panel"].includes(request.visibility))
    throw new ConnectError("Choose a visible pull request view", Code.InvalidArgument);
  signal.throwIfAborted();
  await watchScope(prs, request.pullRequestId);
  signal.throwIfAborted();
  const id = request.pullRequestId;
  const { p } = producerOf(prs, id);
  clearTimeout(p.cleanup);
  const viewing = request.visibility === "view";
  p.viewers += Number(viewing);
  p.panels += Number(!viewing);
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    p.viewers -= Number(viewing);
    p.panels -= Number(!viewing);
    idle(prs, id, p);
  };

  signal.addEventListener("abort", release, { once: true });
  const until = Date.now() + 90_000;
  let revision = request.revision;
  let initial = true;

  try {
    while (!signal.aborted && Date.now() < until) {
      await poll(prs, id, p);

      if (signal.aborted) return;
      const update = p.update!;

      if (initial || update.revision !== revision) {
        await watchScope(prs, id);
        yield create(github.PullRequestUpdateSchema, {
          ...update,
          gap: initial && !!revision && update.revision !== revision,
        });
        revision = update.revision;
        initial = false;
      }

      const due = Math.min(p.nextFast, p.nextSlow) - prs.accounts.http.now();
      await prs.accounts.http.wait(Math.min(Math.max(250, due), 60_000, Math.max(1, until - Date.now())), signal);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    signal.removeEventListener("abort", release);
    release();
  }
}
