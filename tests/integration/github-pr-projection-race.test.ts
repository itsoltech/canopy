import { expect, test } from "bun:test";
import { migrations } from "@canopy/db";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";
import { githubPullRequests } from "../../apps/gateway/src/github/store-pull-requests.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { connectGitHub, githubPrFixture, githubThread } from "./support/github-pr.ts";

/** Commit the real unlink only once the competing projection has queued behind its thread lock. */
async function raceUnlink(gw: TestGateway, thread: string, pr: string, revision: bigint, project: () => Promise<void>) {
  const locked = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();

  const unlink = gw.runtime.runPromise(
    SqlClient.SqlClient.use((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* githubPullRequests(sql).prUnlink(gw.userId, thread, pr, revision);
          locked.resolve((yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
          yield* Effect.promise(() => release.promise);
        }),
      ),
    ),
  );

  let projecting: Promise<void> | undefined;
  let observing: Promise<boolean> | undefined;

  try {
    const pid = await Promise.race([
      locked.promise,
      unlink.then(() => {
        throw new Error("Unlink completed before taking the thread lock");
      }),
    ]);

    projecting = project();
    observing = eventually(
      () =>
        gw.runtime.runPromise(
          SqlClient.SqlClient.use(
            (sql) => sql`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
                AND wait_event_type='Lock' AND ${pid}::integer=ANY(pg_blocking_pids(pid))
                AND query ILIKE '%threads%'`,
          ),
        ),
      (rows) => rows.length > 0,
    ).then((rows) => rows.length > 0);

    const blocked = await Promise.race([
      observing,
      projecting.then(() => {
        throw new Error("Projection completed before unlink committed");
      }),
    ]);

    expect(blocked).toBe(true);
  } finally {
    release.resolve();
    await Promise.allSettled([unlink, projecting, observing]);
  }

  await unlink;
  await projecting;
}

test.skipIf(!dockerAvailable).each(["pull request", "repository"])(
  "a concurrent %s refresh preserves the committed unlink in the thread projection",
  async (scope) => {
    const fixture = githubPrFixture();
    const gw = await startTestGateway({ github: fixture.options });
    const name = "itsoltech/canopy";

    try {
      const account = await connectGitHub(gw, fixture);
      await gw.api.setGitHubRepositoryAccount({ repositoryName: name, accountId: account });
      const threadId = await githubThread(gw);
      const linked = await gw.api.linkThreadPullRequest({ threadId, url: `https://github.com/${name}/pull/42` });
      const ref = linked.links[0]!.summary!.ref!;
      fixture.echoText(" · concurrent edit");

      if (scope === "repository") {
        // A background summary read can finish before the repository's thread projections are refreshed.
        await gw.core.github.prs.load(name, ref.number, true);
      }

      await raceUnlink(gw, threadId, ref.id, linked.revision, async () => {
        if (scope === "repository") await gw.core.github.prs.changed(ref.repositoryId);
        else await gw.api.getPullRequest({ pullRequestId: ref.id, refresh: true });
      });

      const current = (await gw.api.getThread({ threadId })).thread!;
      expect((await gw.api.listThreadPullRequests({ threadId })).links).toBeEmpty();
      expect(current.pullRequestCount).toBe(0);
      expect(current.newestPullRequest).toBeUndefined();
      expect(current.pullRequestRevision).toBe(linked.revision + 1n);
    } finally {
      await gw.close();
      fixture.close();
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable)(
  "upgrading linked PRs preserves the list fence and reconciles a missing fingerprint once",
  async () => {
    const fixture = githubPrFixture();
    const gw = await startTestGateway({ github: fixture.options });

    try {
      const account = await connectGitHub(gw, fixture);
      const name = "itsoltech/canopy";
      await gw.api.setGitHubRepositoryAccount({ repositoryName: name, accountId: account });
      const threadId = await githubThread(gw);
      const first = await gw.api.linkThreadPullRequest({ threadId, url: `https://github.com/${name}/pull/61` });
      const id = first.links[0]!.summary!.ref!.id;

      const linked = await gw.api.linkThreadPullRequest({
        threadId,
        url: `https://github.com/${name}/pull/62`,
        expectedRevision: first.revision,
      });

      // Downgrade and upgrade the test fixture in one transaction. Readers can only observe a complete schema.
      await gw.runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DROP VIEW github_pr_projection_summaries`;
              yield* sql`ALTER TABLE thread_pull_requests DROP COLUMN projected_summary_hash`;

              const applied = yield* Migrator.make({})({
                loader: migrations.pipe(Effect.map((all) => all.filter(([, name]) => name === "github_pr_projection"))),
                table: "projection_upgrade_test",
              });

              expect(applied).toHaveLength(1);

              const stored = yield* sql<{
                size: number;
              }>`SELECT octet_length(projected_summary_hash) AS size FROM thread_pull_requests
        WHERE owner_user_id=${gw.userId}::uuid AND thread_id=${threadId}::uuid`;

              expect(stored).toEqual([{ size: 32 }, { size: 32 }]);
            }),
          ),
        ),
      );
      const revision = async () => (await gw.core.github.prs.list(threadId)).revision;
      expect(await revision()).toBe(linked.revision);
      await gw.api.getPullRequest({ pullRequestId: id });
      expect(await revision()).toBe(linked.revision);

      // An older gateway may add a link without recording a fingerprint during a rolling upgrade.
      await gw.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) => sql`UPDATE thread_pull_requests SET projected_summary_hash=NULL
      WHERE owner_user_id=${gw.userId}::uuid AND thread_id=${threadId}::uuid AND pull_request_id=${id}::uuid`,
        ),
      );
      await gw.api.getPullRequest({ pullRequestId: id });
      expect(await revision()).toBe(linked.revision + 1n);
      await gw.api.getPullRequest({ pullRequestId: id });
      expect(await revision()).toBe(linked.revision + 1n);
    } finally {
      await gw.close();
      fixture.close();
    }
  },
  60_000,
);
