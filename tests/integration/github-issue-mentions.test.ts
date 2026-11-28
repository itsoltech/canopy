import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { MentionSchema, Provider, type ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { issueMention, mentionPlaceholder } from "@canopy/domain";
import * as githubMentions from "../../apps/gateway/src/github/issue-mentions.ts";
import { fakeConnector } from "./support/connector.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { connectGitHub } from "./support/github-pr.ts";
import { readFixture } from "./support/github-read.ts";

describe.skipIf(!dockerAvailable)("composer references from a GitHub App account", () => {
  const canopy = { id: 777, full_name: "itsoltech/canopy", private: true, permissions: { pull: true } };
  const other = { ...canopy, id: 888, full_name: "itsoltech/other" };
  let repositories = [canopy, other];

  const merged = {
    __typename: "PullRequest",
    number: 1386,
    title: "Restore sidebar navigation",
    body: "Restore keyboard focus after closing the sidebar.",
    state: "MERGED",
    isDraft: false,
    url: "https://github.com/itsoltech/canopy/pull/1386",
    repository: { databaseId: 777 },
  };

  const issue = {
    __typename: "Issue",
    number: 29,
    title: "Sidebar loses focus",
    body: "Focus escapes the sidebar.",
    issueState: "OPEN",
    url: "https://github.com/itsoltech/canopy/issues/29",
    repository: { databaseId: 777 },
  };

  const fixture = readFixture(
    (query, variables) => {
      if (query.includes("issueOrPullRequest")) {
        const hit =
          variables["owner"] === "itsoltech" && variables["name"] === "canopy" && variables["number"] === 1386;

        return Response.json({ data: { repository: { databaseId: 777, issueOrPullRequest: hit ? merged : null } } });
      }

      const q = String(variables["q"] ?? "");

      if (!q) return;
      const nodes = [];

      if (q.includes("repo:itsoltech/canopy") && q.includes("sidebar")) {
        if (q.includes("is:issue")) nodes.push(issue);

        if (q.includes("is:pr") && !q.includes("is:open")) nodes.push(merged);
      }

      return Response.json({ data: { search: { nodes } } });
    },
    (request) => {
      if (new URL(request.url).pathname === "/user/installations/101/repositories")
        return Response.json({ total_count: repositories.length, repositories });

      return undefined;
    },
  );

  let gw: TestGateway;
  let accountId: string;
  let projectId: string;
  let workspaceId: string;
  let threadId: string;

  beforeAll(async () => {
    gw = await startTestGateway({ github: fixture.options, worker: { hello: { capabilities: ["workspace_origin"] } } });
    gw.worker.handlers.set("readWorkspaceOrigin", (_request, reply) =>
      reply(true, { workspaceOrigin: "github.com/itsoltech/canopy" }),
    );
    accountId = await connectGitHub(gw, fixture);
    projectId = (await gw.api.createProject({ name: "Composer references" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
    threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!.id;
  }, 60_000);

  afterAll(async () => {
    await gw?.close();
    fixture.close();
  });

  const exact = () => gw.api.searchIssues({ scope: { threadId }, query: "1386", includePullRequests: true });

  function send(match: ui.IssueSearchMatch) {
    const data = issueMention(match);
    const text = mentionPlaceholder(data);
    const mention = create(MentionSchema, { ...data, end: text.length });

    return gw.api.sendMessage({ threadId, text, mentions: [mention], clientRequestId: crypto.randomUUID() });
  }

  test("searches the new thread's workspace for issues and opt-in pull requests", async () => {
    const request = { scope: { workspaceId }, query: "sidebar" };
    const issuesOnly = await gw.api.searchIssues(request);
    expect(issuesOnly.issues.map((match) => match.key)).toEqual(["itsoltech/canopy#29"]);
    const result = await gw.api.searchIssues({ ...request, includePullRequests: true });
    expect(result.connectedSources).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(result.issues.map((match) => [match.key, match.pullRequest]).sort()).toEqual([
      ["itsoltech/canopy#1386", true],
      ["itsoltech/canopy#29", false],
    ]);
  });

  test("looks up a merged PR by number and delivers its snapshot to the worker", async () => {
    const result = await exact();
    expect(result.warnings).toEqual([]);
    expect(result.issues).toHaveLength(1);
    const match = result.issues[0]!;
    expect(match).toMatchObject({
      provider: "github",
      accountId,
      key: "itsoltech/canopy#1386",
      title: merged.title,
      url: merged.url,
      description: merged.body,
      status: "merged",
      pullRequest: true,
    });
    const sent = await send(match);
    const input = await eventually(async () => gw.worker.started.get(sent.turn!.id), Boolean);
    expect(input?.mentions[0]).toMatchObject({ source: accountId, name: match.key, issue: { pullRequest: true } });
    expect(input?.text).toContain(merged.body);
  });

  test("rejects another repository on the same account and a selection whose installation access was removed", async () => {
    const match = (await exact()).issues[0]!;
    const foreign = { ...match, key: "itsoltech/other#1386", url: "https://github.com/itsoltech/other/pull/1386" };
    expect(await failure(send(foreign))).toContain("GitHub reference is unavailable");
    repositories = [other];

    try {
      await gw.api.listGitHubInstallations({ accountId, refresh: true });
      expect(await failure(send(match))).toContain("GitHub reference is unavailable");
      const revoked = await exact();
      expect(revoked.connectedSources).toBe(0);
      expect(revoked.issues).toEqual([]);
    } finally {
      repositories = [canopy, other];
      await gw.api.listGitHubInstallations({ accountId, refresh: true });
    }
  });

  describe("with a GitHub MCP connector granted to the same project", () => {
    let connector: ReturnType<typeof fakeConnector>;
    let connectorId: string;
    let waitForReply: Promise<void> | undefined;

    const lookup = (limit: number) =>
      gw.api.searchIssues({ scope: { threadId }, query: merged.url, includePullRequests: true, limit });

    beforeAll(async () => {
      connector = fakeConnector({
        response: async (method, id) => {
          if (method === "tools/list")
            return Response.json({
              jsonrpc: "2.0",
              id,
              result: {
                tools: [
                  { name: "pull_request_read", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
                ],
              },
            });

          if (method === "tools/call") await waitForReply;

          return undefined;
        },
        call: () => ({ number: 1386, html_url: merged.url, title: "MCP snapshot", state: "closed", merged: true }),
      });

      const account = (
        await gw.api.saveConnectorAccount({
          connectorType: "github",
          name: "MCP GitHub",
          url: connector.url,
          authKind: "headers",
          token: connector.secret,
        })
      ).account!;

      connectorId = account.id;
      await gw.api.setConnectorAccess({
        accountId: account.id,
        expectedRevision: account.revision,
        projectIds: [projectId],
      });
    });

    afterAll(async () => {
      try {
        if (connectorId) await gw.api.deleteConnectorAccount({ accountId: connectorId });
      } finally {
        await connector?.close();
      }
    });

    test("keeps the native snapshot once when both sources return the same PR", async () => {
      for (const limit of [1, 10]) {
        const result = await lookup(limit);
        expect(result.warnings).toEqual([]);
        expect(result.connectedSources).toBe(2);
        expect(result.issues.map((match) => [match.accountId, match.url, match.title])).toEqual([
          [accountId, merged.url, merged.title],
        ]);
      }
    });

    test("drops a completed native page if installation access changes while MCP is still responding", async () => {
      const native = spyOn(githubMentions, "searchGitHubMentions");
      const release = Promise.withResolvers<void>();
      waitForReply = release.promise;
      const pending = lookup(10);

      try {
        // Observe the real native result at the gateway before revoking access.
        const finished = await eventually(async () => native.mock.results[0], Boolean);

        if (finished?.type !== "return") throw new Error("Native GitHub lookup was not started");
        expect((await finished.value).issues.map((match) => match.accountId)).toEqual([accountId]);
        repositories = [other];
        await gw.api.listGitHubInstallations({ accountId, refresh: true });
        release.resolve();
        const result = await pending;
        expect(result.connectedSources).toBe(1);
        expect(result.warnings).toEqual([]);
        expect(result.issues.map((match) => [match.accountId, match.url, match.title])).toEqual([
          [connectorId, merged.url, "MCP snapshot"],
        ]);
      } finally {
        release.resolve();
        waitForReply = undefined;
        native.mockRestore();
        repositories = [canopy, other];
        await gw.api.listGitHubInstallations({ accountId, refresh: true });
        await pending;
      }
    }, 15_000);
  });
});
