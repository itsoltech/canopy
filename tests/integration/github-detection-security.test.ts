import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { create } from "@bufbuild/protobuf";
import { timestampNow } from "@bufbuild/protobuf/wkt";
import { ItemStatus, ThreadEventSchema, type ui } from "@canopy/contracts";
import { GitHubDetection } from "../../apps/gateway/src/github/detection.ts";
import { githubCleanupProof } from "../../apps/gateway/src/github/cleanup-proof.ts";
import { commit, git, worktreeFixture } from "./support/worktrees.ts";
import { connectGitHub } from "./support/github-pr.ts";
import { eventually } from "./support/gateway.ts";
import { detectionPull, githubDetectionFixture } from "./support/github-detection.ts";

describe.skipIf(!dockerAvailable)("GitHub detection races, replay and cleanup authorization", () => {
  const dir = tempDir("canopy-github-detection-security-");
  const fixture = githubDetectionFixture();
  let f: Awaited<ReturnType<typeof worktreeFixture>>;
  let detection: GitHubDetection;
  let thread: ui.Thread;

  let branch = "",
    head = "",
    account = "";

  const request = async () => {
    await detection.tick();
    await f.gw.core.github.run((s) => s.detectionRequest(f.gw.userId, thread.id));
    await detection.tick();

    return f.gw.core.github.prs.list(thread.id);
  };

  beforeAll(async () => {
    f = await worktreeFixture(dir, { github: fixture.options, capabilities: ["git_pr_context_v1"] });
    await f.gw.core.githubDetection.stop();
    detection = new GitHubDetection(f.gw.core);
    git(f.repo, "config", `url.${f.origin}.insteadOf`, "https://github.com/itsoltech/canopy.git");
    git(f.repo, "remote", "set-url", "origin", "https://github.com/itsoltech/canopy.git");
    thread = await f.tree();
    branch = git(thread.cwd, "branch", "--show-current");
    head = git(thread.cwd, "rev-parse", "HEAD");
    account = await connectGitHub(f.gw, fixture);
    await f.gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
    fixture.pulls.set(60, detectionPull(60, branch, head));
    await request();
  }, 60_000);
  afterAll(async () => {
    await detection?.stop();
    await f?.close();
    fixture.close();
  });

  test("unlink wins while discovery is in flight, and another account cannot consume the old cache", async () => {
    const list = await request();
    const pr = list.links[0]!.summary!.ref!;
    let release = () => {};

    fixture.wait(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await f.sql((sql) => sql`DELETE FROM github_pr_cache WHERE cache_key LIKE 'discovery:%'`);
    const count = fixture.requests.length;
    const pending = request();
    await eventually(
      async () => fixture.requests.length,
      (n) => n > count,
    );
    await f.gw.api.unlinkThreadPullRequest({
      threadId: thread.id,
      pullRequestId: pr.id,
      expectedRevision: list.revision,
    });
    release();
    expect((await pending).links).toHaveLength(0);
    const other = await connectGitHub(f.gw, fixture, 202);
    const mapping = await f.gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await f.gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: other,
      expectedRevision: mapping.revision,
    });
    const calls = fixture.requests.length;
    expect((await request()).links).toHaveLength(0);
    expect(fixture.requests.length).toBeGreaterThan(calls);
    expect(await githubCleanupProof(f.gw.core.github, f.gw.userId, f.workerId, "itsoltech/canopy", branch, head)).toBe(
      false,
    );
  });

  test("worker tool event is replayed after a detector restart without reviving its tombstone", async () => {
    fixture.pulls.set(61, detectionPull(61, "created-stack-head", head));

    const event = create(ThreadEventSchema, {
      threadId: thread.id,
      eventId: crypto.randomUUID(),
      journalSeq: 1000n,
      occurredAt: timestampNow(),
      body: {
        case: "itemCompleted",
        value: {
          item: {
            itemId: "mcp-created-pr",
            status: ItemStatus.COMPLETED,
            content: {
              case: "toolCall",
              value: {
                name: "create_pull_request",
                output: JSON.stringify({ html_url: "https://github.com/itsoltech/canopy/pull/61" }),
              },
            },
          },
        },
      },
    });

    f.send({ case: "threadEvent", value: event });
    await eventually(
      () =>
        f.sql(
          (sql) =>
            sql`SELECT 1 FROM thread_events WHERE thread_id=${thread.id}::uuid AND event_id=${event.eventId}::uuid`,
        ),
      (rows) => rows.length === 1,
    );
    await detection.stop();
    detection = new GitHubDetection(f.gw.core);
    const list = await request();
    expect(list.links[0]).toMatchObject({ source: "auto", evidence: "tool_output" });
    await f.gw.api.unlinkThreadPullRequest({
      threadId: thread.id,
      pullRequestId: list.links[0]!.summary!.ref!.id,
      expectedRevision: list.revision,
    });
    await detection.stop();
    detection = new GitHubDetection(f.gw.core);
    f.send({ case: "threadEvent", value: event });
    expect((await request()).links).toHaveLength(0);

    const rows = await f.sql(
      (sql) => sql`SELECT 1 FROM thread_events WHERE thread_id=${thread.id}::uuid AND event_id=${event.eventId}::uuid`,
    );

    expect(rows).toHaveLength(1);
  });

  test("periodic ref discovery needs no push event, bounds pages and keeps branch reuse separate", async () => {
    const old = head;
    head = commit(thread.cwd, "reused.txt");
    fixture.pulls.clear();
    fixture.pulls.set(62, detectionPull(62, branch, old, { state: "merged" }));

    for (let n = 100; n < 201; n++) fixture.pulls.set(n, detectionPull(n, branch, "0".repeat(40), { state: "closed" }));
    fixture.pulls.set(202, detectionPull(202, branch, head));
    await f.sql((sql) => sql`DELETE FROM github_pr_cache WHERE cache_key LIKE 'discovery:%'`);
    await detection.stop();
    detection = new GitHubDetection(f.gw.core);
    expect((await request()).links).toHaveLength(0);
    expect((await f.gw.core.github.run((s) => s.detectionDetail(f.gw.userId, thread.id)))[0]?.detail).toContain(
      "More results",
    );
    expect((await request()).links.map((l) => l.summary?.ref?.number)).toEqual([202]);
  });

  test("failed tools and URLs past the output byte limit cannot create links", async () => {
    for (const number of [64, 65]) {
      fixture.pulls.set(number, detectionPull(number, "unrelated-stack-head", head));

      const event = create(ThreadEventSchema, {
        threadId: thread.id,
        eventId: crypto.randomUUID(),
        journalSeq: BigInt(1000 + number),
        occurredAt: timestampNow(),
        body: {
          case: "itemCompleted",
          value: {
            item: {
              itemId: `bounded-output-${number}`,
              status: ItemStatus.COMPLETED,
              content: {
                case: "toolCall",
                value: {
                  name: "create_pull_request",
                  isError: number === 64,
                  output: `${number === 65 ? "x".repeat(65_536) : ""}\nhttps://github.com/itsoltech/canopy/pull/${number}`,
                },
              },
            },
          },
        },
      });

      f.send({ case: "threadEvent", value: event });
      await eventually(
        () => f.sql((sql) => sql`SELECT 1 FROM thread_events WHERE event_id=${event.eventId}::uuid`),
        (rows) => rows.length === 1,
      );
    }

    const result = await request();
    expect(result.links.some((link) => [64, 65].includes(link.summary?.ref?.number ?? 0))).toBe(false);
  });

  test("cleanup needs the selected PAT's worker grant and fresh exact merged proof", async () => {
    fixture.pulls.clear();
    fixture.pulls.set(63, detectionPull(63, branch, head, { state: "merged" }));

    const connector = (
      await f.gw.api.saveConnectorAccount({
        connectorType: "github",
        name: "Cleanup PAT",
        authKind: "headers",
        token: fixture.pat(303),
      })
    ).account!;

    const pat = (await f.gw.api.useGitHubPat({ connectorAccountId: connector.id })).account!;
    const mapping = await f.gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await f.gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: pat.id,
      expectedRevision: mapping.revision,
    });

    const proof = (sha = head) =>
      githubCleanupProof(f.gw.core.github, f.gw.userId, f.workerId, "itsoltech/canopy", branch, sha);

    expect(await proof()).toBe(false);
    await f.gw.api.setConnectorAccess({
      accountId: connector.id,
      expectedRevision: connector.revision,
      workerIds: [f.workerId],
    });
    // Grant changes the connector revision and requires an explicit PAT reselection.
    await f.gw.api.useGitHubPat({ connectorAccountId: connector.id });
    expect(await proof()).toBe(true);
    expect(await proof("0".repeat(40))).toBe(false);
    fixture.pulls.set(63, detectionPull(63, branch, head, { state: "closed" }));
    expect(await proof()).toBe(false);

    const commands = await f.sql(
      (sql) => sql<{ kind: string }>`SELECT kind FROM worker_commands WHERE thread_id=${thread.id}::uuid`,
    );

    expect(commands.every((c) => c.kind !== "readGitPrContext")).toBe(true);
  });
});
