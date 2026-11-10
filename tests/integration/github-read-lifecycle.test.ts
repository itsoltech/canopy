import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { github } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect, Metric } from "effect";
import { SqlClient } from "effect/sql";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { githubMetrics } from "../../apps/gateway/src/github/metrics.ts";
import { watchPullRequest } from "../../apps/gateway/src/github/watch.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";
import { linkedRead, readFixture } from "./support/github-read.ts";

describe.skipIf(!dockerAvailable)("GitHub read leases and retention", () => {
  const fixture = readFixture();
  let gw: TestGateway;
  let pr: string;
  let thread: string;
  let account: string;
  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options });
    ({ pr, thread, account } = await linkedRead(gw, fixture));
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  const first = async (revision = "") => {
    const controller = new AbortController();

    const stream = gw.api.watchPullRequest(
      { pullRequestId: pr, visibility: "view", revision },
      { signal: controller.signal, timeoutMs: 10_000 },
    );

    try {
      for await (const update of stream) return update;
    } finally {
      controller.abort();
    }

    throw new Error("Missing watch snapshot");
  };

  test("several visible clients share the producer and reconnect gaps require page invalidation", async () => {
    const checks = fixture.counts.get("CanopyChecks") ?? 0;
    const timeline = fixture.counts.get("CanopyTimeline") ?? 0;
    const updates = await Promise.all([first(), first(), first()]);
    expect(updates.every((u) => u.revision === updates[0]!.revision && !u.gap)).toBe(true);
    expect((fixture.counts.get("CanopyChecks") ?? 0) - checks).toBe(1);
    expect((fixture.counts.get("CanopyTimeline") ?? 0) - timeline).toBe(1);
    fixture.advance(100_000);
    fixture.timelineVersion(" updated");
    const gap = await first(updates[0]!.revision);
    expect(gap.gap).toBe(true);
    expect(gap.invalidated).toContain("timeline");
    const same = await first(gap.revision);
    expect(same.gap).toBe(false);
    const restarted = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);
    const controller = new AbortController();

    const iterator = watchPullRequest(
      restarted.prs,
      create(github.WatchPullRequestRequestSchema, {
        pullRequestId: pr,
        visibility: "view",
        revision: "missing-revision",
      }),
      controller.signal,
    );

    try {
      expect((await iterator.next()).value?.gap).toBe(true);
    } finally {
      controller.abort();
      await iterator.return();
      await restarted.stop();
    }
  });

  test("background polling uses known active threads and one batch of aliases, without timeline or files", async () => {
    const before = fixture.counts.get("CanopyHeaders") ?? 0;
    await gw.core.github.background.tick();
    expect(fixture.counts.get("CanopyHeaders") ?? 0).toBe(before);
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO github_git_contexts(owner_user_id,thread_id,context)
        VALUES (${gw.userId}::uuid,${thread}::uuid,'{}'::jsonb)`;
      }),
    );
    await gw.api.linkThreadPullRequest({
      threadId: thread,
      url: "https://github.com/itsoltech/canopy/pull/43",
      expectedRevision: (await gw.api.listThreadPullRequests({ threadId: thread })).revision,
    });
    const timeline = fixture.counts.get("CanopyTimeline") ?? 0;
    await Promise.all([gw.core.github.background.tick(), gw.core.github.background.tick()]);
    expect((fixture.counts.get("CanopyHeaders") ?? 0) - before).toBe(1);
    expect(fixture.counts.get("CanopyTimeline") ?? 0).toBe(timeline);
    await gw.core.github.background.tick();
    expect((fixture.counts.get("CanopyHeaders") ?? 0) - before).toBe(1);
  });

  test("maintenance expires each content class while preserving identities and durable account preferences", async () => {
    await gw.api.setGitHubUpdateAccount({ accountId: account, enabled: false });
    const row = await gw.core.github.run((s) => s.owned(gw.userId, account));
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        for (const [key, age] of [
          ["summary:expired", 31 * 24],
          ["timeline:expired", 8 * 24],
          ["patches:expired", 25],
          ["logs:expired", 2],
        ] as const)
          yield* sql`INSERT INTO github_pr_cache(owner_user_id,account_id,access_revision,cache_key,payload,verified_at,last_read_at)
          VALUES (${gw.userId}::uuid,${account}::uuid,${row.revision}::bigint,${key},'{}'::jsonb,
            now()-${age}*interval '1 hour',now()-${age}*interval '1 hour')`;
      }),
    );
    expect(await gw.core.github.run((s) => s.cachePrune(gw.userId))).toBeGreaterThanOrEqual(4);

    const remaining = await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql`SELECT cache_key FROM github_pr_cache WHERE cache_key LIKE '%:expired'`;
      }),
    );

    expect(remaining).toHaveLength(0);
    expect((await gw.api.listThreadPullRequests({ threadId: thread })).links).toHaveLength(2);
    const restarted = new GitHubAccounts(gw.runtime, gw.userId, fixture.options);

    try {
      expect((await restarted.run((s) => s.updateAccount(gw.userId)))?.enabled).toBe(false);
      expect((await restarted.prs.get(pr)).summary?.ref?.id).toBe(pr);
    } finally {
      await restarted.stop();
    }

    expect((await Effect.runPromise(Metric.value(githubMetrics.evicted))).count).toBeGreaterThanOrEqual(4);
  });

  test("concurrent cache writers cannot exceed the owner's durable log quota", async () => {
    const row = await gw.core.github.run((s) => s.owned(gw.userId, account));
    const payload = { text: "x".repeat(9 * 1024 * 1024), truncated: true };
    const leases = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
    const keys = ["logs:quota-a", "logs:quota-b"];

    try {
      for (const [i, key] of keys.entries()) await gw.core.github.run((s) => s.cacheClaim(row, key, leases[i]!));

      const finished = await Promise.allSettled(
        keys.map((key, i) =>
          gw.core.github.run((s) => s.cacheFinish(row, key, leases[i]!, payload, "", Date.now(), 60_000)),
        ),
      );

      expect(finished.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(finished.filter((result) => result.status === "rejected")).toHaveLength(1);

      const bytes = await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          return (yield* sql<{ bytes: string }>`SELECT sum(octet_length(payload::text))::text AS bytes
          FROM github_pr_cache WHERE owner_user_id=${gw.userId}::uuid AND cache_key LIKE 'logs:%'`)[0]!.bytes;
        }),
      );

      expect(Number(bytes)).toBeLessThanOrEqual(16 * 1024 * 1024);
    } finally {
      await gw.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DELETE FROM github_pr_cache WHERE owner_user_id=${gw.userId}::uuid AND cache_key IN ('logs:quota-a','logs:quota-b')`;
        }),
      );
    }
  }, 30_000);
});
