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
  nextSlow: number;
  nextFast: number;
  index: number;
  targets: ProbeTarget[];
  signals: Map<string, ProbeSignal & { expires: number }>;
  update?: github.PullRequestUpdate;
  flight?: Promise<void> | undefined;
  cleanup?: ReturnType<typeof setTimeout> | undefined;
  controller?: AbortController;
}

const producers = new WeakMap<GitHubPullRequests, Map<string, Producer>>();
const jitter = (ms: number) => ms * (1 + Math.random() * 0.1);
const targetKey = (target: ProbeTarget) => `${target.kind}:${target.page}`;

const newProducer = (): Producer => ({
  viewers: 0,
  panels: 0,
  nextSlow: 0,
  nextFast: Infinity,
  index: 0,
  targets: [
    { kind: "metadata", page: 1 },
    { kind: "checks", page: 1 },
    { kind: "statuses", page: 1 },
  ],
  signals: new Map(),
});

/** The sweep and streams share the same deadlines and single flight; there is no second header poller. */
export async function pollVisiblePullRequests(prs: GitHubPullRequests) {
  for (const [id, p] of producers.get(prs) ?? []) {
    if (!p.viewers && !p.panels) continue;
    await poll(prs, id, p);
  }
}

async function probe(scope: ReadScope, p: Producer, target: ProbeTarget, signal: AbortSignal) {
  signal.throwIfAborted();
  const result = await readProbe(scope, target, signal);
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

      return;
    }

    const initial = !p.signals.size;

    if (!initial && now < Math.min(p.nextSlow, p.nextFast)) return;

    let metadataChanged = false,
      checksChanged = false;

    const targets = initial
      ? [...p.targets]
      : now >= p.nextFast
        ? p.targets.filter((target) => p.signals.get(targetKey(target))?.running)
        : [];

    if (!initial && now >= p.nextSlow) {
      const metadata = p.targets.find((target) => target.kind === "metadata");

      if (metadata && !targets.includes(metadata)) targets.push(metadata);

      const slow = p.targets.filter(
        (target) => target.kind !== "metadata" && !p.signals.get(targetKey(target))?.running,
      );

      const target = slow[p.index++ % slow.length];

      if (target && !targets.includes(target)) targets.push(target);
    }

    for (const target of targets) {
      if (await probe(scope, p, target, signal)) {
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
  let entries = producers.get(prs);

  if (!entries) {
    entries = new Map();
    producers.set(prs, entries);
  }

  const id = request.pullRequestId;
  let p = entries.get(id);

  if (!p) {
    p = newProducer();
    entries.set(id, p);
  }

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

    if (!p.viewers && !p.panels) {
      p.controller?.abort();
      p.cleanup = setTimeout(() => entries.delete(id), 300_000);
      p.cleanup.unref?.();
    }
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
