import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { GitHubAccounts } from "../../apps/gateway/src/github/service.ts";
import { connectGitHub, githubPrFixture, githubThread } from "./support/github-pr.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bounded linked pull requests", () => {
  let gw: TestGateway;
  let fixture: ReturnType<typeof githubPrFixture>;
  let thread: string;
  let account: string;

  const sql = (query: string, params: unknown[] = []) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (s) => s.unsafe(query, params)));

  beforeAll(async () => {
    fixture = githubPrFixture();
    gw = await startTestGateway({ github: fixture.options });
    account = await connectGitHub(gw, fixture);
    thread = await githubThread(gw);
    await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
    await sql(
      `INSERT INTO github_pull_requests(id,owner_user_id,repository_id,repository_name,number,node_id,created_at,
      summary,summary_account_id) SELECT gen_random_uuid(),$1::uuid,'777','itsoltech/canopy',n,'PR_'||n,now(),
      jsonb_build_object('title','Pull request '||n,'state',CASE WHEN n<=30 THEN 'open' ELSE 'merged' END,
        'updatedAt',to_char('2026-11-01'::timestamp+n*interval '1 minute','YYYY-MM-DD"T"HH24:MI:SS"Z"')),
      $2::uuid FROM generate_series(1,500) n`,
      [gw.userId, account],
    );
    // A remembered summary includes its canonical ref, just like a successful GitHub read.
    await sql(
      `UPDATE github_pull_requests SET summary=summary||jsonb_build_object('ref',jsonb_build_object(
      'id',id,'host','github.com','repositoryId',repository_id,'repositoryName',repository_name,'number',number,'nodeId',node_id))
      WHERE owner_user_id=$1::uuid`,
      [gw.userId],
    );
    await sql(
      `INSERT INTO thread_pull_requests(owner_user_id,thread_id,pull_request_id,source,evidence)
      SELECT owner_user_id,$2::uuid,id,'manual','manual' FROM github_pull_requests WHERE owner_user_id=$1::uuid`,
      [gw.userId, thread],
    );
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
    fixture?.close();
  });

  test("500 links page in active/recent order with a hard cap and owner scoping", async () => {
    const first = await gw.core.github.prs.list(thread, 500);
    expect(first.totalCount).toBe(500);
    expect(first.links).toHaveLength(20);
    expect(first.nextOffset).toBe(20);
    expect((await gw.core.github.prs.list(thread, 4)).nextOffset).toBe(4);
    expect(first.links.map((l) => l.summary!.ref!.number)).toEqual(Array.from({ length: 20 }, (_, i) => 30 - i));
    const numbers: number[] = [];

    for (let offset = 0; offset < 500; offset += 20) {
      const page = await gw.core.github.prs.list(thread, 20, offset);
      numbers.push(...page.links.map((l) => l.summary!.ref!.number));
      expect(page.totalCount).toBe(500);
      expect(page.nextOffset).toBe(offset === 480 ? 0 : offset + 20);
    }

    expect(new Set(numbers).size).toBe(500);
    expect(numbers.slice(30, 33)).toEqual([500, 499, 498]);
    expect((await gw.api.listThreadPullRequests({ threadId: thread, offset: 500 })).links).toHaveLength(0);
    const foreign = new GitHubAccounts(gw.runtime, crypto.randomUUID(), fixture.options);

    try {
      expect(await foreign.prs.list(thread).catch((e) => ConnectError.from(e).code)).toBe(Code.NotFound);
    } finally {
      await foreign.stop();
    }
  });

  test("only the requested page refreshes, in five shared batches rather than 500 requests", async () => {
    const before = fixture.calls;
    const first = await gw.api.listThreadPullRequests({ threadId: thread });
    expect(first.links).toHaveLength(20);
    // Repeated reads while the page refreshes join the same bounded work.
    await Promise.all(Array.from({ length: 8 }, () => gw.api.listThreadPullRequests({ threadId: thread })));
    await eventually(
      () => gw.core.github.prs.list(thread),
      (r) => r.links.every((l) => !l.stale),
    );
    expect(fixture.calls - before).toBe(5);
    expect(
      (
        await sql("SELECT id FROM github_pull_requests WHERE owner_user_id=$1::uuid AND refreshed_at IS NOT NULL", [
          gw.userId,
        ])
      ).length,
    ).toBe(20);
    const terminal = await gw.api.listThreadPullRequests({ threadId: thread, offset: 100 });
    expect(terminal.links.every((l) => l.summary?.state === "merged")).toBe(true);
    expect(fixture.calls - before).toBe(5);
  }, 60_000);

  test("a shared rate limit stops the remaining batches and repeated page reads do not retry", async () => {
    const before = fixture.calls;
    fixture.status(429);
    await gw.api.listThreadPullRequests({ threadId: thread, offset: 20 });

    const failed = await eventually(
      () => gw.core.github.prs.list(thread, 20, 20),
      (r) => r.links.some((l) => l.detail.includes("request limit")),
    );

    expect(failed.links.some((l) => l.summary?.title)).toBe(true);
    expect(fixture.calls - before).toBe(1);
    await gw.api.listThreadPullRequests({ threadId: thread, offset: 20 });
    await gw.api.listThreadPullRequests({ threadId: thread, offset: 20 });
    expect(fixture.calls - before).toBe(1);
    fixture.status(200);
  }, 60_000);
});
