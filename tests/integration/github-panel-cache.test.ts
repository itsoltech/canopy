import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { pullRequestAvatar } from "../../apps/gateway/src/github/avatars.ts";
import { digest, readScope } from "../../apps/gateway/src/github/read-scope.ts";
import { timeline } from "../../apps/gateway/src/github/timeline-query.ts";
import { watchPullRequest } from "../../apps/gateway/src/github/watch.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedRead } from "./support/github-read.ts";
import { pollingFixture } from "./support/github-polling.ts";

describe.skipIf(!dockerAvailable)("PR panel cache and actor boundaries", () => {
  const fixture = pollingFixture();
  let gw: TestGateway;
  let pr: string;
  let account: string;
  let thread: string;

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    ({ pr, account, thread } = await linkedRead(gw, fixture));
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  const requests = () =>
    [...fixture.counts].filter(([key]) => key.startsWith("/")).reduce((sum, [, count]) => sum + count, 0);

  async function openPanel(prs = gw.core.github.prs) {
    const controller = new AbortController();

    const stream = watchPullRequest(
      prs,
      create(github.WatchPullRequestRequestSchema, {
        pullRequestId: pr,
        visibility: "view",
      }),
      controller.signal,
    );

    try {
      return (await stream.next()).value;
    } finally {
      controller.abort();
      await stream.return();
    }
  }

  test("reopening and restarting reuse persisted metadata, checks and timeline without upstream requests", async () => {
    await gw.api.listPullRequestChecks({ pullRequestId: pr });
    await gw.api.listPullRequestTimeline({ pullRequestId: pr });
    const before = requests();
    expect((await openPanel())?.snapshot?.summary?.ref?.id).toBe(pr);
    const first = requests() - before;
    expect(first).toBe(3); // Prime the three lightweight REST validators, not the already loaded pages.
    await openPanel();
    expect(requests() - before).toBe(first);
    const restarted = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);

    try {
      await openPanel(restarted.prs);
      expect(requests() - before).toBe(first);
    } finally {
      await restarted.stop();
    }
  });

  test("keeps bot identity and payload avatars, deduplicates images and never forwards credentials", async () => {
    const page = await gw.api.listPullRequestTimeline({ pullRequestId: pr });
    const bot = page.items.find((item) => item.content.value?.author === "claude[bot]")?.content.value;
    expect(bot?.avatarUrl).toBe("https://avatars.githubusercontent.com/in/3?v=4");
    expect((await gw.api.getPullRequest({ pullRequestId: pr })).actorAvatars["maintainer-with-a-long-name"]).toBe(
      "https://avatars.githubusercontent.com/u/1?v=4",
    );
    // SAFETY: the fixture above contains bot events and the assertion verified their avatar.
    const request = create(github.PullRequestAvatarRequestSchema, { pullRequestId: pr, url: bot!.avatarUrl });
    const other = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fixture.avatarGate(async () => {
      entered.resolve();
      await release.promise;
    });
    const reading = Promise.all([
      gw.api.getPullRequestAvatar(request),
      gw.api.getPullRequestAvatar(request),
      pullRequestAvatar(other.prs, request),
    ]);

    try {
      await entered.promise;
      expect(fixture.counts.get("avatars")).toBe(1);
      release.resolve();
      const values = await reading;

      expect(values.every((value) => value.dataUrl.startsWith("data:image/png;base64,"))).toBe(true);
      expect(fixture.counts.get("avatars")).toBe(1);
      expect(fixture.avatarRequests).toEqual([
        { authorization: null, cookie: null, credentials: "omit", redirect: "error" },
      ]);
    } finally {
      release.resolve();
      await reading.catch(() => {});
      fixture.avatarGate(() => Promise.resolve());
      await other.stop();
    }

    const restarted = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);

    try {
      await pullRequestAvatar(restarted.prs, request);
      expect(fixture.counts.get("avatars")).toBe(1);
    } finally {
      await restarted.stop();
    }
  });

  test("a delayed avatar cache miss reuses another service's completed fill", async () => {
    const url = "https://avatars.githubusercontent.com/u/77?v=4";
    const request = create(github.PullRequestAvatarRequestSchema, { pullRequestId: pr, url });
    const other = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const missed = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const before = fixture.counts.get("avatars") ?? 0;
    const cached = other.prs.client.cached.bind(other.prs.client);
    let held = false;

    const delayed = spyOn(other.prs.client, "cached").mockImplementation(async (row, key) => {
      const value = await cached(row, key);

      if (key === `avatar:${digest(url)}` && !held) {
        held = true;
        expect(value?.payload).toBeFalsy();
        missed.resolve();
        await resume.promise;
      }

      return value;
    });

    fixture.avatarGate(async () => {
      entered.resolve();
      await release.promise;
    });
    let first: Promise<github.PullRequestAvatar> | undefined;
    let second: Promise<github.PullRequestAvatar> | undefined;

    try {
      first = pullRequestAvatar(gw.core.github.prs, request);
      await entered.promise;
      second = pullRequestAvatar(other.prs, request);
      await missed.promise;
      release.resolve();
      const image = await first;
      resume.resolve();
      expect(await second).toEqual(image);
      expect((fixture.counts.get("avatars") ?? 0) - before).toBe(1);
    } finally {
      release.resolve();
      resume.resolve();
      await Promise.allSettled([first, second]);
      delayed.mockRestore();
      fixture.avatarGate(() => Promise.resolve());
      await other.stop();
    }
  });

  test("REST conditional requests reuse the projection without spending primary rate budget", async () => {
    const first = await gw.api.listPullRequestCommits({ pullRequestId: pr });
    const row = await gw.core.github.run((store) => store.owned(gw.userId, account));

    const budget = () =>
      gw.core.github.run((store) => store.budget(row.github_user_id, "core", gw.core.github.http.now()));

    const before = await budget();
    const second = await gw.api.listPullRequestCommits({ pullRequestId: pr, refresh: true });
    expect(second.commits).toEqual(first.commits);
    expect((await budget()).used).toBe(before.used);
  });

  test("owner checks precede cache lookup, including public avatar reads", async () => {
    const stranger = new GitHubAccounts(gw.runtime, Bun.randomUUIDv7(), fixture.options);
    const before = requests();
    const images = fixture.counts.get("avatars");

    try {
      const read = async () =>
        timeline(
          await readScope(stranger.prs, create(github.PullRequestPageRequestSchema, { pullRequestId: pr }), "timeline"),
        );

      await expect(read()).rejects.toThrow();
      await expect(
        pullRequestAvatar(
          stranger.prs,
          create(github.PullRequestAvatarRequestSchema, {
            pullRequestId: pr,
            url: "https://avatars.githubusercontent.com/in/3?v=4",
          }),
        ),
      ).rejects.toThrow();
      expect(requests()).toBe(before);
      expect(fixture.counts.get("avatars")).toBe(images);
    } finally {
      await stranger.stop();
    }
  });

  test("five hidden minutes do not refresh GitHub resources", async () => {
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO github_git_contexts(owner_user_id,thread_id,context)
        VALUES (${gw.userId}::uuid,${thread}::uuid,'{}'::jsonb) ON CONFLICT DO NOTHING`;
      }),
    );
    const before = requests();

    for (let minute = 0; minute < 5; minute++) {
      fixture.advance(60_000);
      await gw.core.github.background.tick();
    }

    expect(requests()).toBe(before);
  });

  test("rejects arbitrary hosts, redirects, non-raster images and oversized responses", async () => {
    for (const url of [
      "http://avatars.githubusercontent.com/u/4",
      "https://github.com/u/4",
      "https://avatars.githubusercontent.com@127.0.0.1/u/4",
    ])
      await expect(gw.api.getPullRequestAvatar({ pullRequestId: pr, url })).rejects.toThrow();
    fixture.avatarResponse("image/svg+xml", 32);
    await expect(
      gw.api.getPullRequestAvatar({ pullRequestId: pr, url: "https://avatars.githubusercontent.com/u/4" }),
    ).rejects.toThrow();
    fixture.avatarResponse("image/png", 131_073);
    await expect(
      gw.api.getPullRequestAvatar({ pullRequestId: pr, url: "https://avatars.githubusercontent.com/u/5" }),
    ).rejects.toThrow();
    fixture.avatarResponse("image/png", 1, 302);
    await expect(
      gw.api.getPullRequestAvatar({ pullRequestId: pr, url: "https://avatars.githubusercontent.com/u/6" }),
    ).rejects.toThrow();
    fixture.avatarResponse("image/png", 32);
    const retried = await gw.api.getPullRequestAvatar({
      pullRequestId: pr,
      url: "https://avatars.githubusercontent.com/u/6",
    });
    expect(retried.dataUrl).toStartWith("data:image/png;base64,");
  });
});
