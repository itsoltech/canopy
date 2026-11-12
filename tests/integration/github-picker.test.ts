import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import { create } from "@bufbuild/protobuf";
import { github, GitPrContextSchema } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { Code, ConnectError } from "@connectrpc/connect";
import { connectGitHub, githubThread } from "./support/github-pr.ts";
import { githubPickerFixture } from "./support/github-picker.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("repository PR picker through owner-scoped gRPC and GitHub fixtures", () => {
  let gw: TestGateway;
  let fixture: ReturnType<typeof githubPickerFixture>;
  let account: string;
  let thread: string;

  beforeAll(async () => {
    fixture = githubPickerFixture();
    gw = await startTestGateway({ github: fixture.options });
    account = await connectGitHub(gw, fixture);
    thread = await githubThread(gw);
    await origin(thread, "github.com/itsoltech/canopy");
    await gw.core.github.run((s) =>
      s.detectionSaveContext(
        gw.userId,
        thread,
        create(GitPrContextSchema, {
          branch: "feat/picker",
          headOid: "a".repeat(40),
          pushRef: "feat/picker",
          pushRemote: "origin",
          upstreamRemote: "origin",
          upstreamRef: "feat/picker",
          ambiguous: false,
          remotes: [],
          ancestorOids: [],
        }),
      ),
    );
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    fixture?.close();
  });

  async function origin(id: string, value: string) {
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE project_workspaces SET git_origin=${value} WHERE id=(SELECT workspace_id FROM threads WHERE id=${id}::uuid)`;
      }),
    );
  }

  const page = (query = "", includeClosed = false, cursor = "") =>
    gw.api.listRepositoryPullRequests({ threadId: thread, query, includeClosed, cursor });

  async function collect(query = "", all = false) {
    const items: github.RepositoryPullRequest[] = [];
    let cursor = "";

    do {
      const result = await page(query, all, cursor);
      expect(result.state).toBe("ready");
      expect(result.items.length).toBeLessThanOrEqual(30);
      items.push(...result.items);
      cursor = result.nextCursor;
    } while (cursor);

    return items;
  }

  test("requires an explicit account choice before reading repository PRs", async () => {
    const calls = fixture.pickerCalls;
    const result = await page();
    expect(result.state).toBe("choose_account");
    expect(result.selection?.candidates.map((candidate) => candidate.id)).toEqual([account]);
    expect(result.items).toHaveLength(0);
    expect(fixture.pickerCalls).toBe(calls);
    await gw.api.setGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy", accountId: account });
  });

  test("pins matching branches, then the viewer's PRs, then recently updated PRs; warms cache", async () => {
    const first = await page();
    expect(first.repositoryName).toBe("itsoltech/canopy");
    expect(first.items.slice(0, 2).map((pr) => pr.number)).toEqual([42, 45]);
    expect(first.items.slice(0, 2).every((pr) => pr.currentBranch)).toBe(true);
    expect(first.items[1]!.state).toBe("draft");
    const calls = fixture.pickerCalls;
    expect((await page()).items).toEqual(first.items);
    expect(fixture.pickerCalls).toBe(calls);
    const items = await collect();
    expect(items).toHaveLength(73);
    expect(new Set(items.map((pr) => pr.number)).size).toBe(73);
    expect(items.slice(2, 17).every((pr) => pr.viewerIsAuthor)).toBe(true);
    expect(items.slice(17).every((pr) => !pr.viewerIsAuthor && !pr.currentBranch)).toBe(true);

    for (const secret of fixture.secrets) expect(inspect(items, { depth: null })).not.toContain(secret);
  });

  test("all includes closed and merged; paging preserves updated order inside each priority", async () => {
    const items = await collect("", true);
    expect(items).toHaveLength(75);
    expect(items.find((pr) => pr.number === 69)?.state).toBe("merged");
    expect(items.find((pr) => pr.number === 70)?.state).toBe("closed");
    const rest = items.filter((pr) => !pr.currentBranch && !pr.viewerIsAuthor);
    expect(rest.map((pr) => pr.number)).toEqual(rest.map((pr) => pr.number).toSorted((a, b) => a - b));
  });

  test("server-side search matches number, title, branch and author across pages", async () => {
    expect((await collect("#42")).map((pr) => pr.number)).toEqual([42]);
    expect((await collect("restore keyboard")).map((pr) => pr.number)).toEqual([18]);
    expect((await collect("fix/keyboard-focus")).map((pr) => pr.number)).toEqual([18]);
    expect((await collect("contributor-74")).map((pr) => pr.number)).toEqual([75]);
    expect(await collect("no-such-pull-request")).toHaveLength(0);
  });

  test("expired REST pages send ETags and serve 304 content from the durable cache", async () => {
    await collect();
    fixture.advance(31_000);
    expect(await collect()).toHaveLength(73);
    expect(fixture.pickerNotModified).toBeGreaterThan(0);
  });

  test("already-linked rows are disabled data and selecting uses the existing link action", async () => {
    const current = await gw.api.listThreadPullRequests({ threadId: thread });
    await gw.api.linkThreadPullRequest({
      threadId: thread,
      url: "https://github.com/itsoltech/canopy/pull/42",
      expectedRevision: current.revision,
    });
    expect((await page()).items.find((pr) => pr.number === 42)?.linked).toBe(true);
  });

  test("cursors are fenced to thread, query, filters, account access and signature", async () => {
    const first = await page();

    for (const request of [
      { threadId: thread, query: "different", cursor: first.nextCursor },
      { threadId: thread, includeClosed: true, cursor: first.nextCursor },
      { threadId: thread, cursor: `${first.nextCursor}broken` },
    ]) {
      const result = await gw.api.listRepositoryPullRequests(request);
      expect(result.state).not.toBe("ready");
      expect(result.items).toHaveLength(0);
    }

    expect(
      await gw.api.listRepositoryPullRequests({ threadId: crypto.randomUUID() }).then(
        () => 0,
        (cause) => ConnectError.from(cause).code,
      ),
    ).toBe(Code.NotFound);
    const selection = await gw.api.getGitHubRepositoryAccount({ repositoryName: "itsoltech/canopy" });
    await gw.api.setGitHubRepositoryAccount({
      repositoryName: "itsoltech/canopy",
      accountId: account,
      expectedRevision: selection.revision,
    });
    const changed = await page("", false, first.nextCursor);
    expect(changed.state).toBe("unavailable");
    expect(changed.items).toHaveLength(0);
  });

  test("an upstream failure clears rows and offers a retry", async () => {
    await gw.core.github.run((s) => s.cacheInvalidate(gw.userId, account));
    fixture.pickerStatus(422);

    try {
      const result = await page();
      expect(result.state).toBe("unavailable");
      expect(result.detail).toContain("retry");
      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBe("");
    } finally {
      fixture.pickerStatus(200);
    }
  });

  test("exposes matching accounts in the picker and remembers the account per repository", async () => {
    const second = await connectGitHub(gw, fixture, 202);

    try {
      const original = (await page()).selection!;
      expect(original.accountId).toBe(account);
      expect(original.candidates.map((candidate) => candidate.id)).toEqual([account, second]);
      await gw.api.setGitHubRepositoryAccount({
        repositoryName: "itsoltech/canopy",
        accountId: second,
        expectedRevision: original.revision,
      });
      const selected = (await page()).selection!;
      expect(selected.accountId).toBe(second);
      expect((await page()).selection?.accountId).toBe(second);
      await gw.api.setGitHubRepositoryAccount({
        repositoryName: "itsoltech/canopy",
        accountId: account,
        expectedRevision: selected.revision,
      });
    } finally {
      await gw.api.disconnectGitHubAccount({ accountId: second });
    }
  });

  test("empty repository and non-GitHub remotes have distinct states", async () => {
    await gw.core.github.run((s) => s.cacheInvalidate(gw.userId, account));
    fixture.empty(true);
    expect(await collect()).toHaveLength(0);
    fixture.empty(false);
    const other = await githubThread(gw);
    await origin(other, "gitlab.com/owner/project");
    const calls = fixture.pickerCalls;
    expect((await gw.api.listRepositoryPullRequests({ threadId: other })).state).toBe("not_github");
    expect(fixture.pickerCalls).toBe(calls);
  });

  test("installation, disconnected account and rate limit errors carry actionable states", async () => {
    const other = await githubThread(gw);
    await origin(other, "github.com/other/private");
    expect((await gw.api.listRepositoryPullRequests({ threadId: other })).state).toBe("installation_required");
    await gw.core.github.run((s) => s.cacheInvalidate(gw.userId, account));
    fixture.pickerStatus(429);
    const limited = await page();
    expect(limited.state).toBe("rate_limited");
    expect(limited.retryAt).toBeDefined();
    expect(limited.items).toHaveLength(0);
    fixture.pickerStatus(200);
    fixture.advance(1_000_000);
    fixture.pickerStatus(404);
    expect((await page()).state).toBe("installation_required");
    fixture.pickerStatus(200);
    await gw.api.disconnectGitHubAccount({ accountId: account });
    const disconnected = await page();
    expect(disconnected.state).toBe("account_required");
    expect(disconnected.detail).toContain("Connect GitHub");
  });
});
