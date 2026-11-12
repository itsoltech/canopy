import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { watchPullRequest } from "../../../apps/gateway/src/github/watch.ts";
import type { GitHubPullRequests } from "../../../apps/gateway/src/github/pull-requests.ts";
import type { pollingFixture, PollRequest } from "./github-polling.ts";

/** Exercise cache expiry and stream renewals on an injected clock, without sleeping five minutes. */
export class PollingClock {
  elapsed = 0;
  boundary = 90_000;
  controller = new AbortController();
  onWait: (() => Promise<void>) | undefined;
  constructor(readonly fixture: ReturnType<typeof pollingFixture>) {}
  wait = async (ms: number) => {
    const step = Math.min(Math.ceil(ms), this.boundary - this.elapsed);
    this.elapsed += step;
    this.fixture.advance(step);

    if (this.elapsed >= this.boundary) this.controller.abort();
    else await this.onWait?.();
  };
  renew() {
    this.controller = new AbortController();
    this.boundary = Math.min(300_000, this.elapsed + 90_000);
  }
}

export async function measurePolling(
  prs: GitHubPullRequests,
  pr: string,
  clock: PollingClock,
  watch = watchPullRequest,
) {
  const requests = clock.fixture.requests;

  const stream = () =>
    watch(
      prs,
      create(github.WatchPullRequestRequestSchema, { pullRequestId: pr, visibility: "view" }),
      clock.controller.signal,
    );

  let current = stream();
  const before = requests.length;
  await current.next();
  const first = requests.slice(before);
  clock.controller.abort();
  await current.return();
  clock.renew();
  current = stream();
  const reopenAt = requests.length;
  await current.next();
  const second = requests.slice(reopenAt);
  const idleAt = requests.length;

  for (;;) {
    let result = await current.next();

    while (!result.done) result = await current.next();

    if (clock.elapsed >= 300_000) break;
    clock.renew();
    current = stream();
    await current.next();
  }

  return {
    first: summarizeRequests(first),
    second: summarizeRequests(second),
    idle: summarizeRequests(requests.slice(idleAt)),
  };
}

export function summarizeRequests(requests: readonly PollRequest[]) {
  const groups = Map.groupBy(requests, (item) => item.resource);

  return {
    total: requests.length,
    conditional: requests.filter((item) => item.conditional).length,
    notModified: requests.filter((item) => item.status === 304).length,
    ok: requests.filter((item) => item.status === 200).length,
    endpoints: Object.fromEntries(
      [...groups].map(([key, list]) => [
        key,
        {
          total: list.length,
          conditional: list.filter((item) => item.conditional).length,
          notModified: list.filter((item) => item.status === 304).length,
          ok: list.filter((item) => item.status === 200).length,
        },
      ]),
    ),
  };
}
