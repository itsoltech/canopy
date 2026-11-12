import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { prCitation, prCommentCitation } from "@canopy/domain";
import { startInstanceFixture } from "./support/instance-fixture.ts";
import { readFixture } from "./support/github-read.ts";
import { connectGitHub } from "./support/github-pr.ts";
import { failure } from "./support/gateway.ts";
import { inputRecords } from "./fixtures/instance-probe.ts";

describe.skipIf(!dockerAvailable)("PR citations through gateway and real harness adapters", () => {
  const github = readFixture((query) => {
    if (!query.includes("query CanopyReviewThreads")) return undefined;

    return Response.json({
      data: {
        repository: {
          pullRequest: {
            id: "PR_fixture_42",
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: "REVIEW_THREAD",
                  path: "src/safe.ts",
                  line: 3,
                  isResolved: false,
                  isOutdated: false,
                  pullRequest: { id: "PR_fixture_42" },
                  comments: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: "REVIEW_COMMENT",
                        body: "Validate this input before saving.",
                        url: "https://github.com/itsoltech/canopy/pull/42#discussion_r1",
                        createdAt: "2026-11-10T12:00:00Z",
                        author: { login: "reviewer" },
                        originalCommit: { oid: "a".repeat(40) },
                        diffHunk: "@@ -1,2 +1,3 @@\n+validate(input);\n" + " context\n".repeat(1500),
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    });
  });

  let fixture: Awaited<ReturnType<typeof startInstanceFixture>>;
  let account: string;

  beforeAll(async () => {
    fixture = await startInstanceFixture(false, { github: github.options });

    for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK])
      await fixture.save(provider, "pr-citations");
    account = await connectGitHub(fixture.gw, github);
    await fixture.gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
    github.close();
  });

  async function link(threadId: string) {
    const linked = await fixture.gw.api.linkThreadPullRequest({
      threadId,
      url: "https://github.com/itsoltech/canopy/pull/42",
    });

    const id = linked.links[0]!.summary!.ref!.id;

    return fixture.gw.api.getPullRequest({ pullRequestId: id });
  }

  for (const provider of [Provider.CLAUDE, Provider.CODEX, Provider.GROK]) {
    test(`${Provider[provider]} receives labelled PR sources at the exact text positions without a GitHub request`, async () => {
      const thread = await fixture.thread(provider);
      const snapshot = await link(thread.id);
      const id = snapshot.summary!.ref!.id;
      const timeline = await fixture.gw.api.listPullRequestTimeline({ pullRequestId: id, oldestFirst: true });
      const reviews = await fixture.gw.api.listPullRequestReviewThreads({ pullRequestId: id });
      const comment = timeline.items.find((item) => item.content.case === "comment")!.content.value!;
      const review = timeline.items.find((item) => item.content.case === "review")!.content.value!;
      const inline = reviews.threads[0]!;

      const quotes = [
        prCommentCitation(snapshot, comment),
        prCommentCitation(snapshot, inline.comments[0]!, "review_comment", inline),
        prCommentCitation(snapshot, review, "review"),
      ];

      const text = "Before [a] between [b] after [c] end.";

      const ranges = [
        [7, 10],
        [19, 22],
        [29, 32],
      ];

      const calls = [...github.counts];
      // Descriptive fields from a client must never override the source in the owner-scoped cache.
      quotes[1]!.sourceAuthor = "forged";
      quotes[1]!.pullRequest!.repository = "foreign/private";
      quotes[1]!.pullRequest!.path = "wrong.ts";
      quotes[1]!.pullRequest!.diffHunk = "untrusted client context";

      const sent = await fixture.gw.api.sendMessage({
        threadId: thread.id,
        text,
        clientRequestId: crypto.randomUUID(),
        quotes: quotes
          .map((quote, index) => ({ ...quote, start: ranges[index]![0], end: ranges[index]![1] }))
          .reverse(),
      });

      const turn = await fixture.finished(thread.id, sent.turn!.id);
      expect(turn.status).toBe("completed");
      expect(turn.quotes.map((q) => q.pullRequest?.kind)).toEqual(["comment", "review_comment", "review"]);
      expect(turn.quotes[1]!.pullRequest?.repository).toBe("itsoltech/canopy");
      expect(turn.quotes[1]!.pullRequest?.path).toBe("src/safe.ts");
      expect(turn.quotes[1]!.pullRequest?.line).toBe(3);
      expect(turn.quotes[1]!.pullRequest?.diffHunk).toHaveLength(8000);
      expect(turn.quotes[1]!.sourceAuthor).toBe("reviewer");
      expect(turn.inputText).toContain(
        "Pull request review comment by @reviewer on itsoltech/canopy#42 (src/safe.ts:3):",
      );
      expect(turn.inputText).toContain("#discussion_r1 · 2026-11-10T12:00:00.000Z");
      expect(turn.inputText).toContain("Diff context:\n```diff\n@@ -1,2 +1,3 @@");
      expect(turn.inputText).not.toContain("untrusted client context");
      expect(turn.inputText.indexOf(comment.body)).toBeLessThan(turn.inputText.indexOf("between"));
      expect(turn.inputText.indexOf("between")).toBeLessThan(turn.inputText.indexOf("Validate this input"));
      expect(turn.inputText.indexOf("Validate this input")).toBeLessThan(turn.inputText.indexOf(" after "));
      expect(turn.inputText.indexOf(" after ")).toBeLessThan(turn.inputText.indexOf(review.body));
      expect(turn.inputText.endsWith(" end.")).toBe(true);
      expect(
        inputRecords(fixture.trace)
          .at(-1)!
          .parts.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n"),
      ).toContain(turn.inputText);
      expect([...github.counts]).toEqual(calls);

      const stored = await fixture.query<{ input: { quotes: { pullRequest: { resourceId: string } }[] } }>(
        "SELECT input FROM turns WHERE id=$1::uuid",
        [turn.id],
      );

      expect(stored[0]!.input.quotes.map((q) => q.pullRequest.resourceId)).toEqual(
        quotes.map((q) => q.pullRequest!.resourceId),
      );
    }, 30_000);
  }

  test("failed checks, failed jobs and cached log excerpts keep their sources and make no GitHub request on send", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const snapshot = await link(thread.id);
    const id = snapshot.summary!.ref!.id;
    const checks = await fixture.gw.api.listPullRequestChecks({ pullRequestId: id });
    const check = checks.checks.find((c) => c.state === "failure")!;
    const jobs = await fixture.gw.api.listPullRequestCheckJobs({ pullRequestId: id, resourceId: check.runId });
    const job = jobs.jobs[0]!;
    const log = await fixture.gw.api.getPullRequestJobLog({ pullRequestId: id, resourceId: job.id });
    const calls = [...github.counts];

    const quotes = [
      prCitation(snapshot, "check", check.nodeId, check.output, { url: check.url }),
      prCitation(snapshot, "job", job.id, job.name, { url: job.url }),
      prCitation(snapshot, "log", job.id, log.text.slice(0, 100), { firstLine: log.firstLine }),
    ];

    const text = "[a] fix [b] using [c]";

    const sent = await fixture.gw.api.sendMessage({
      threadId: thread.id,
      text,
      clientRequestId: crypto.randomUUID(),
      quotes: quotes.map((q, i) => ({ ...q, start: [0, 8, 18][i], end: [3, 11, 21][i] })),
    });

    const turn = await fixture.finished(thread.id, sent.turn!.id);
    expect(turn.status).toBe("completed");
    expect(turn.quotes.map((q) => q.pullRequest?.kind)).toEqual(["check", "job", "log"]);
    expect(turn.inputText).toContain("Pull request log excerpt by @GitHub Actions on itsoltech/canopy#42");
    expect(turn.inputText).not.toContain("private-value");
    expect([...github.counts]).toEqual(calls);
  }, 30_000);

  test("foreign-owner PR caches, missing sources, unlinked PRs and revoked account revisions are rejected before delivery", async () => {
    const thread = await fixture.thread(Provider.CODEX);
    const snapshot = await link(thread.id);
    const id = snapshot.summary!.ref!.id;
    const page = await fixture.gw.api.listPullRequestTimeline({ pullRequestId: id, oldestFirst: true });
    const comment = page.items.find((i) => i.content.case === "comment")!.content.value!;
    const quote = prCommentCitation(snapshot, comment);
    const foreign = Bun.randomUUIDv7();
    const foreignPr = Bun.randomUUIDv7();
    const foreignAccount = Bun.randomUUIDv7();
    await fixture.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other','user')", [
      foreign,
      `${foreign}@example.test`,
    ]);
    await fixture.query(
      `INSERT INTO github_pull_requests(id,owner_user_id,repository_id,repository_name,number,node_id,created_at)
      SELECT $1::uuid,$2::uuid,repository_id,repository_name,number,node_id,created_at FROM github_pull_requests WHERE id=$3::uuid`,
      [foreignPr, foreign, id],
    );
    await fixture.query(
      `INSERT INTO github_accounts(id,owner_user_id,github_user_id,login,account_type,auth_kind,status,credentials,key_id,revision)
      SELECT $1::uuid,$2::uuid,github_user_id,login,account_type,auth_kind,status,credentials,key_id,revision FROM github_accounts WHERE id=$3::uuid`,
      [foreignAccount, foreign, account],
    );
    await fixture.query(
      `INSERT INTO github_pr_cache(owner_user_id,account_id,access_revision,cache_key,payload,verified_at,expires_at)
      SELECT $1::uuid,$2::uuid,access_revision,cache_key,payload,verified_at,expires_at FROM github_pr_cache WHERE account_id=$3::uuid`,
      [foreign, foreignAccount, account],
    );
    expect(
      (await fixture.query("SELECT cache_key FROM github_pr_cache WHERE owner_user_id=$1::uuid", [foreign])).length,
    ).toBeGreaterThan(0);
    const before = inputRecords(fixture.trace).length;
    const calls = [...github.counts];

    async function refused(value: ui.Quote) {
      expect(
        await failure(
          fixture.gw.api.sendMessage({
            threadId: thread.id,
            text: "[q]",
            clientRequestId: crypto.randomUUID(),
            quotes: [{ ...value, start: 0, end: 3 }],
          }),
        ),
      ).toContain("Citation source unavailable");
    }

    await refused(
      create(ui.QuoteSchema, { ...quote, pullRequest: { ...quote.pullRequest!, pullRequestId: foreignPr } }),
    );
    await refused(create(ui.QuoteSchema, { ...quote, pullRequest: { ...quote.pullRequest!, resourceId: "missing" } }));
    await fixture.query(
      "UPDATE thread_pull_requests SET unlinked_at=now() WHERE thread_id=$1::uuid AND pull_request_id=$2::uuid",
      [thread.id, id],
    );
    await refused(quote);
    await fixture.query(
      "UPDATE thread_pull_requests SET unlinked_at=NULL WHERE thread_id=$1::uuid AND pull_request_id=$2::uuid",
      [thread.id, id],
    );
    await fixture.query("UPDATE github_accounts SET revision=revision+1 WHERE id=$1::uuid", [account]);
    await refused(quote);
    expect(inputRecords(fixture.trace)).toHaveLength(before);
    expect(await fixture.query("SELECT id FROM turns WHERE thread_id=$1::uuid", [thread.id])).toHaveLength(0);
    expect([...github.counts]).toEqual(calls);
  });
});
