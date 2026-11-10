import { create, toJsonString } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { setTimeout } from "node:timers/promises";
import type { GitHubPullRequests } from "./pull-requests.ts";
import { checks } from "./checks.ts";
import { digest, readScope } from "./read-scope.ts";
import { timeline } from "./timeline-query.ts";

interface Producer {
  viewers: number;
  panels: number;
  nextChecks: number;
  nextSummary: number;
  running: boolean;
  update?: github.PullRequestUpdate;
  checkPage?: github.PullRequestChecksPage | undefined;
  timelinePage?: github.PullRequestTimelinePage | undefined;
  flight?: Promise<void> | undefined;
}

const producers = new WeakMap<GitHubPullRequests, Map<string, Producer>>();
const jitter = (ms: number) => ms * (0.8 + Math.random() * 0.4);

/** One producer per visible PR. SQL cache leases also fence reads across gateway processes. */
async function poll(prs: GitHubPullRequests, id: string, p: Producer) {
  if (p.flight) return p.flight;
  const now = prs.accounts.http.now();

  if (p.update && now < Math.min(p.nextChecks, p.nextSummary)) return;
  p.flight = (async () => {
    const summaryDue = !p.update || now >= p.nextSummary;
    const pr = await prs.accounts.run((s) => s.prOwned(prs.accounts.owner, id));

    const snapshot = summaryDue
      ? await prs.load(pr.repository_name, pr.number, !!p.update, false, true)
      : p.update!.snapshot!;

    if (snapshot.summary?.headSha !== p.update?.snapshot?.summary?.headSha) {
      p.checkPage = undefined;
      p.timelinePage = undefined;
      p.nextChecks = 0;
    }

    const request = create(github.PullRequestPageRequestSchema, { pullRequestId: id, refresh: !!p.update });

    if (p.viewers && (!p.checkPage || now >= p.nextChecks)) {
      p.checkPage = await checks(await readScope(prs, request, "checks"));
      p.running =
        snapshot.summary?.checksState === "pending" ||
        p.checkPage.checks.some((c) => ["pending", "queued", "in_progress", "waiting"].includes(c.state));
    }

    if (p.viewers && (summaryDue || !p.timelinePage))
      p.timelinePage = await timeline(await readScope(prs, request, "timeline"));

    const revision = digest(
      JSON.stringify([
        toJsonString(
          github.PullRequestSnapshotSchema,
          create(github.PullRequestSnapshotSchema, {
            ...snapshot,
            summary: snapshot.summary ? { ...snapshot.summary, verifiedAt: undefined } : undefined,
          }),
        ),
        p.checkPage?.checks,
        p.timelinePage
          ? toJsonString(
              github.PullRequestTimelinePageSchema,
              create(github.PullRequestTimelinePageSchema, {
                items: p.timelinePage.items,
              }),
            )
          : "",
      ]),
    );

    p.update = create(github.PullRequestUpdateSchema, {
      snapshot,
      revision,
      invalidated: ["timeline", "reviews", "checks", "files", "commits"],
    });
    p.nextChecks = now + jitter(p.viewers && p.running ? 15_000 : 60_000);

    if (summaryDue) {
      p.nextSummary = now + jitter(60_000);
      await prs.changed(pr.repository_id);
    }
  })().finally(() => {
    p.flight = undefined;
  });

  return p.flight;
}

/** Hidden clients close the stream; renewable leases bound abandoned views to 90 seconds. */
export async function* watchPullRequest(
  prs: GitHubPullRequests,
  request: github.WatchPullRequestRequest,
  signal: AbortSignal,
) {
  if (!["view", "panel"].includes(request.visibility))
    throw new ConnectError("Choose a visible pull request view", Code.InvalidArgument);
  // Always authorize even when another client's producer already has a cached snapshot.
  await readScope(prs, create(github.PullRequestPageRequestSchema, { pullRequestId: request.pullRequestId }), "watch");
  let entries = producers.get(prs);

  if (!entries) {
    entries = new Map();
    producers.set(prs, entries);
  }

  const id = request.pullRequestId;
  let p = entries.get(id);

  if (!p) {
    p = { viewers: 0, panels: 0, nextChecks: 0, nextSummary: 0, running: false };
    entries.set(id, p);
  }

  const viewing = request.visibility === "view";
  p.viewers += Number(viewing);
  p.panels += Number(!viewing);

  if (viewing && !p.checkPage) p.nextChecks = 0;
  const until = Date.now() + 90_000;
  let revision = request.revision;
  let initial = true;

  try {
    while (!signal.aborted && Date.now() < until) {
      await poll(prs, id, p);
      const update = p.update!;

      if (initial || update.revision !== revision) {
        // A producer can outlive a repository mapping or account revision change.
        await readScope(prs, create(github.PullRequestPageRequestSchema, { pullRequestId: id }), "watch");
        yield create(github.PullRequestUpdateSchema, {
          ...update,
          gap: initial && !!revision && update.revision !== revision,
        });
        revision = update.revision;
        initial = false;
      }

      const due = Math.min(p.nextChecks, p.nextSummary) - prs.accounts.http.now();
      await setTimeout(Math.min(Math.max(250, due), Math.max(1, until - Date.now())), undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    p.viewers -= Number(viewing);
    p.panels -= Number(!viewing);

    if (!p.viewers && !p.panels) entries.delete(id);
  }
}
