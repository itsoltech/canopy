import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, Provider, type connectors, type ui, type Mention } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { issueMention, mentionPlaceholder } from "@canopy/domain";
import { qualifyId, splitId } from "@canopy/domain/computers";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";
import { fakeConnector } from "./support/connector.ts";
import { eventually, failure } from "./support/gateway.ts";

function messageWithMentions(prefix: string, values: Mention[]) {
  let text = prefix;
  const mentions: Mention[] = [];

  for (const value of values) {
    const start = text.length;
    text += mentionPlaceholder(value);
    mentions.push(create(MentionSchema, { ...value, start, end: text.length }));
    text += " ";
  }

  return { text: text.trimEnd(), mentions };
}

describe.skipIf(!dockerAvailable)("issue mentions through the home gateway", () => {
  let home: ConfigComputer;
  let client: ConfigComputer;
  let fake: ReturnType<typeof fakeConnector>;
  let projectId: string;
  let workspaceId: string;
  let scratch: ui.Workspace;
  let threadId: string;
  let account: connectors.ConnectorAccount;
  let readOnly = true;
  let paused: (() => Promise<void>) | undefined;

  const q = (id: string) => qualifyId(id, home.node);

  const search = (scope: { threadId?: string; workspaceId?: string }) =>
    client.gateway.api.searchIssues({ scope, query: "LIN-42" });

  const access = async (grant: { allProjects?: boolean; noProject?: boolean; projectIds?: string[] }) => {
    account = (
      await home.gateway.api.setConnectorAccess({
        accountId: account.id,
        expectedRevision: account.revision,
        ...grant,
      })
    ).account!;
  };

  beforeAll(async () => {
    home = await configComputer("Issue home");
    client = await configComputer("Composer");
    await pairConfig(client, home, false, false);
    await eventually(async () => client.links.reachable().includes(home.node), Boolean, 20_000);
    fake = fakeConnector({
      response: async (method, id) => {
        if (method === "tools/list")
          return Response.json({
            jsonrpc: "2.0",
            id,
            result: {
              tools: ["get_issue", "search_issues", "search_pull_requests"].map((name) => ({
                name,
                inputSchema: { type: "object" },
                annotations: { readOnlyHint: readOnly },
              })),
            },
          });

        if (method === "tools/call") await paused?.();

        return undefined;
      },
      call: (name) => {
        if (name === "get_issue")
          return {
            id: crypto.randomUUID(),
            identifier: "LIN-42",
            title: "Add filtering",
            description: `Test description ${fake.secret}`,
            url: "https://linear.app/work/issue/LIN-42",
            status: "Open",
          };

        const pull = name === "search_pull_requests";
        const url = `https://github.com/example/app/${pull ? "pull/43" : "issues/41"}`;

        return {
          total_count: 1,
          items: [
            {
              number: pull ? 43 : 41,
              title: pull ? "Implement filtering" : "Filtering request",
              state: "open",
              body: pull ? "Review this change" : "Build this feature",
              html_url: url,
              ...(pull && { pull_request: { html_url: url } }),
            },
          ],
        };
      },
    });

    const { api, workerId } = home.gateway;
    projectId = (await api.createProject({ name: "Issues" })).project!.id;
    workspaceId = (await api.createWorkspace({ projectId, workerId, rootPath: "/repo" })).workspace!.id;
    scratch = (await api.getOverview({})).projects
      .find((p) => p.kind === "scratch")!
      .workspaces.find((w) => w.workerId === workerId)!;
    threadId = (await api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Issue thread" }))
      .thread!.id;
    account = (
      await api.saveConnectorAccount({
        connectorType: "linear",
        name: "Engineering",
        url: fake.url,
        authKind: "headers",
        token: fake.secret,
      })
    ).account!;

    const other = crypto.randomUUID();
    const privateAccount = crypto.randomUUID();
    await home.store.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other owner','user')", [
      other,
      `${other}@test`,
    ]);
    await home.store.query(
      `INSERT INTO connector_accounts(id,owner_user_id,connector_type,name,namespace,url,transport,auth_kind,status,all_projects,no_project)
        VALUES ($1::uuid,$2::uuid,'linear','Private account',$1::text,$3,'http','headers','connected',true,true)`,
      [privateAccount, other, fake.url],
    );
  }, 90_000);

  afterAll(async () => {
    await client?.close();
    await home?.close();
    await fake?.close();
  }, 30_000);

  test("uses the selected workspace grant, separates scratch, and delivers a linked issue snapshot", async () => {
    await access({ allProjects: true });
    const scratchScope = { workspaceId: q(scratch.id) };
    const before = fake.calls.length;
    expect((await search(scratchScope)).connectedSources).toBe(0);
    expect(fake.calls.length).toBe(before);

    const matches = await search({ workspaceId: q(workspaceId) });
    expect(matches.connectedSources).toBe(1);
    expect(matches.warnings).toEqual([]);
    expect(matches.issues).toHaveLength(1);
    const issue = matches.issues[0]!;
    expect(issue).toMatchObject({
      accountId: q(account.id),
      accountLabel: "Engineering",
      provider: "linear",
      key: "LIN-42",
      description: "Test description [REDACTED]",
      title: "Add filtering",
      status: "Open",
    });
    expect((await search({ threadId: q(threadId) })).issues).toEqual(matches.issues);
    expect(fake.calls.slice(before)).toEqual(
      Array.from({ length: 2 }, () => ({ name: "get_issue", args: { id: "LIN-42" } })),
    );
    const data = issueMention(issue);
    const text = mentionPlaceholder(data);
    const mention = create(MentionSchema, { ...data, end: text.length });

    const sent = await client.gateway.api.sendMessage({
      threadId: q(threadId),
      text,
      mentions: [mention],
      clientRequestId: crypto.randomUUID(),
    });

    expect(sent.turn?.mentions).toEqual([mention]);

    const started = await eventually(
      async () => home.gateway.worker.started.get(splitId(sent.turn!.id).id),
      (input) => !!input,
    );

    expect(started?.text).toContain(issue.url);
    expect(started?.text).toContain(issue.description);
    expect(started?.mentions[0]?.source).toBe(account.id);

    const prefix = "/goal Resolve ";

    const goal = await client.gateway.api.sendMessage({
      threadId: q(threadId),
      text: `${prefix}${text} this week`,
      mentions: [
        { kind: MentionKind.COMMAND, name: "goal", source: "platform", end: 5 },
        { ...mention, start: prefix.length, end: prefix.length + text.length },
      ],
    });

    expect(goal.goal?.objective).toBe(`Resolve ${issue.key} (${issue.title}, ${issue.url}) this week`);

    await access({ allProjects: false, noProject: true });
    expect((await search(scratchScope)).issues).toHaveLength(1);
    expect((await search({ workspaceId: q(workspaceId) })).connectedSources).toBe(0);
    expect(
      await failure(client.gateway.api.sendMessage({ threadId: q(threadId), text, mentions: [mention] })),
    ).toContain("connector account");
    expect(
      await failure(
        client.gateway.api.createThread({
          projectId: q(projectId),
          workspaceId: q(workspaceId),
          provider: Provider.CODEX,
          initialMessage: text,
          initialMentions: [mention],
        }),
      ),
    ).toContain("connector account");
  }, 30_000);

  test("checks current read-only annotations and withholds results revoked during a provider call", async () => {
    await access({ projectIds: [projectId], noProject: false });
    const scope = { threadId: q(threadId) };
    readOnly = false;
    const before = fake.calls.length;
    const denied = await search(scope);
    expect(denied.issues).toEqual([]);
    expect(denied.warnings).toHaveLength(1);
    expect(fake.calls.length).toBe(before);
    readOnly = true;

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    paused = () => {
      entered.resolve();

      return release.promise;
    };

    const pending = search(scope);

    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Search finished before the provider received its call");
        }),
      ]);
      await access({ allProjects: false });
    } finally {
      release.resolve();
      paused = undefined;
      await pending;
    }

    const revoked = await pending;
    expect(revoked.issues).toEqual([]);
    expect(revoked.warnings).toEqual([]);
    expect(revoked.connectedSources).toBe(0);
  }, 30_000);

  test("sends distinct GitHub issues, pull requests and thread references through the same linked composer", async () => {
    const api = client.gateway.api;
    const gw = home.gateway;

    const destination = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title: "Mixed references",
      })
    ).thread!;

    const scope = { threadId: q(destination.id) };

    const saved = (
      await gw.api.saveConnectorAccount({
        connectorType: "github",
        name: "Source",
        authKind: "headers",
        url: fake.url,
        token: fake.secret,
      })
    ).account!;

    const granted = (
      await gw.api.setConnectorAccess({
        accountId: saved.id,
        expectedRevision: saved.revision,
        projectIds: [projectId],
      })
    ).account!;

    const before = fake.calls.length;
    const ordinary = await api.searchIssues({ scope, query: "filter" });
    expect(ordinary.issues.map((row) => row.key)).toEqual(["example/app#41"]);
    expect(fake.calls.slice(before).map((call) => call.name)).toEqual(["search_issues"]);

    const combined = await api.searchIssues({ scope, query: "filter", includePullRequests: true });
    expect(combined.warnings).toEqual([]);
    expect(combined.issues).toHaveLength(2);
    const issue = combined.issues.find((row) => !row.pullRequest)!;
    const pr = combined.issues.find((row) => row.pullRequest)!;
    expect(pr).toMatchObject({
      accountId: q(saved.id),
      key: "example/app#43",
      url: "https://github.com/example/app/pull/43",
    });

    const issueRef = create(MentionSchema, issueMention(issue));
    const prRef = create(MentionSchema, issueMention(pr));
    const threadRef = create(MentionSchema, { kind: MentionKind.THREAD, name: q(threadId), label: "Issue thread" });
    const mixed = messageWithMentions("Compare ", [threadRef, issueRef, prRef]);
    expect(mixed.text).toBe("Compare #Issue thread example/app#41 example/app#43");

    const goal = messageWithMentions("", [
      create(MentionSchema, { kind: MentionKind.COMMAND, name: "goal", source: "platform" }),
      prRef,
    ]);

    expect((await api.sendMessage({ ...scope, ...goal })).goal?.objective).toBe(
      `Pull request ${pr.key} (${pr.title}, ${pr.url})`,
    );

    gw.worker.holdTurns = true;
    let running = "";

    try {
      const sent = (await api.sendMessage({ ...scope, ...mixed, clientRequestId: crypto.randomUUID() })).turn!;
      running = splitId(sent.id).id;
      const input = await eventually(async () => gw.worker.started.get(running), Boolean);
      expect(input?.mentions.map((m) => [m.kind, m.source, m.issue?.pullRequest])).toEqual([
        [MentionKind.THREAD, "", undefined],
        [MentionKind.ISSUE, saved.id, false],
        [MentionKind.ISSUE, saved.id, true],
      ]);
      expect(input?.text).toContain(`thread_id: ${threadId}`);
      expect(input?.text).toContain('"kind":"issue"');
      expect(input?.text).toContain('"kind":"pull_request"');
      expect(input?.text).toContain(pr.description);
      expect(sent.mentions).toEqual(mixed.mentions);

      const queued = (await api.sendMessage({ ...scope, text: "Review pending", clientRequestId: crypto.randomUUID() }))
        .turn!;

      expect(queued.status).toBe("queued");
      const change = messageWithMentions("Review ", [prRef]);

      const edited = (
        await api.editQueuedTurn({
          turnId: queued.id,
          expectedRevision: queued.revision,
          mentionsComplete: true,
          ...change,
        })
      ).turn!;

      expect(edited.mentions).toEqual(change.mentions);

      await gw.api.setConnectorAccess({ accountId: saved.id, expectedRevision: granted.revision, allProjects: false });
      expect(
        await failure(
          api.editQueuedTurn({
            turnId: queued.id,
            expectedRevision: edited.revision,
            mentionsComplete: true,
            ...change,
          }),
        ),
      ).toContain("connector account");
      expect((await api.searchIssues({ scope, query: "filter", includePullRequests: true })).issues).toEqual([]);
      await api.deleteQueuedTurn({ turnId: queued.id });
    } finally {
      gw.worker.holdTurns = false;

      if (running) {
        gw.worker.finish(destination.id, running);
        await eventually(
          () => gw.api.getThread({ threadId: destination.id }),
          (value) => value.thread?.status === "idle",
        );
      }
    }

    expect(
      fake.calls
        .slice(before)
        .map((call) => call.name)
        .sort(),
    ).toEqual(["search_issues", "search_issues", "search_pull_requests"]);
    expect(
      await home.store.query("SELECT 1 FROM thread_pull_requests WHERE thread_id=$1::uuid", [destination.id]),
    ).toHaveLength(0);
  }, 30_000);
});
