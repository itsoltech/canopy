import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PermissionMode, Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonValue } from "@bufbuild/protobuf";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { connectGitHub, githubPrFixture } from "./support/github-pr.ts";

describe.skipIf(!dockerAvailable)("repository-scoped GitHub agent tools", () => {
  const fixture = githubPrFixture();
  const repo = { repositoryId: "777", repositoryName: "itsoltech/canopy" };
  const writes: { path: string; body: string }[] = [];
  const reads: string[] = [];
  const fileText = "Internal deployment notes";
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;
  let accountId: string;
  let lost = false;
  let renamed = false;
  let readable = true;
  let extraRepository = false;
  let installed = true;
  let fileGate: Promise<void> | undefined;
  let fileStarted = () => {};
  let botTool = "";

  beforeAll(async () => {
    fixture.intercept((req) => {
      const path = new URL(req.url).pathname;

      if (path === "/user/installations/101/repositories" && (extraRepository || !installed)) {
        const repositories = [
          ...(installed ? [{ id: 777, full_name: repo.repositoryName, private: true }] : []),
          ...(extraRepository ? [{ id: 888, full_name: "itsoltech/another", private: true }] : []),
        ];

        return Response.json({ total_count: repositories.length, repositories });
      }

      if (path === "/repos/itsoltech/canopy" && renamed)
        return Response.json({ id: 999, full_name: repo.repositoryName, private: true });

      if (!path.startsWith("/repositories/")) return;

      if (req.method === "POST")
        return req.text().then((body) => {
          writes.push({ path, body });

          if (lost) return Response.json({}, { status: 502 });

          if (path === "/repositories/777/issues/42/comments") return Response.json({ id: 1234 });

          if (path === "/repositories/777/pulls")
            return Response.json({
              number: 88,
              title: "Review",
              state: "open",
              head: { ref: "feature/layout" },
              base: { ref: "dev" },
            });

          if (path === "/repositories/777/issues")
            return Response.json({ number: 91, title: "Investigate", state: "open" });

          return Response.json({}, { status: 404 });
        });
      reads.push(path);

      if (path === "/repositories/777/contents/docs/private.md") {
        if (!readable) return Response.json({}, { status: 403 });
        const echo = req.headers.get("authorization")!.slice(7);
        const bytes = Buffer.from(`${fileText}: ${echo}`);
        fileStarted();

        return Promise.resolve(fileGate).then(() =>
          Response.json({
            type: "file",
            sha: "abc",
            encoding: "base64",
            content: bytes.toString("base64"),
            size: bytes.length,
            download_url: "https://example.test/signed",
          }),
        );
      }

      if (path === "/repositories/777/issues")
        return Response.json([{ number: 42, title: "Deployment", state: "open" }]);

      return Response.json({}, { status: 404 });
    });
    gw = await startTestGateway({
      github: fixture.options,
      botModel: async (input) => {
        const tool = input.tools.find((entry) => entry.remoteName === "add_comment");

        if (input.messages.at(-1)?.role === "user" && tool) {
          botTool = tool.name;

          return {
            text: "",
            calls: [{ id: "comment", name: tool.name, arguments: { number: 42, body: "Checked the deployment" } }],
          };
        }

        return { text: "Done", calls: [] };
      },
    });
    gw.worker.holdTurns = true;
    accountId = await connectGitHub(gw, fixture);
    projectId = (await gw.api.createProject({ name: "Repository tools" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);

  afterAll(async () => {
    try {
      await gw?.close();
    } finally {
      fixture.close();
    }
  });

  const access = async (projectIds: string[], allowWrites = false, botIds: string[] = []) => {
    const target = { ...repo, accountId };
    const current = await gw.api.getGitHubAgentAccess(target);

    return gw.api.setGitHubAgentAccess({
      ...target,
      projectIds,
      botIds,
      allowWrites,
      expectedRevision: current.revision,
    });
  };

  const thread = async (permissionMode: PermissionMode) => {
    const threadId = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, permissionMode }))
      .thread!.id;

    const turnId = (
      await gw.api.sendMessage({ threadId, text: "Check the repository", clientRequestId: crypto.randomUUID() })
    ).turn!.id;

    await eventually(async () => gw.worker.started.has(turnId), Boolean);
    const created = gw.worker.commands.find((c) => c.case === "createThread" && c.value.thread?.threadId === threadId);

    if (created?.case !== "createThread") throw new Error("Missing createThread command");

    const connectorTools = created.value.thread!.connectorTools.filter(
      (tool) => tool.connectorType === "github_repository",
    );

    const file = connectorTools.find((tool) => tool.remoteName === "read_file")!;
    const name = (remote: string) => file.name.replace(/read_file$/, remote);

    const call = (remote: string, args: JsonValue, callId?: string) =>
      gw.worker.callTool({
        threadId,
        turnId,
        connectorAccountId: file.accountId,
        tool: name(remote),
        args,
        ...(callId && { callId }),
      });

    return { threadId, connectorTools, call };
  };

  test("threads receive only granted operations; private reads are rechecked and writes are never repeated", async () => {
    await access([projectId]);
    const t = await thread(PermissionMode.FULL_AUTO);
    expect(t.connectorTools.find((tool) => tool.remoteName === "create_issue")).toBeUndefined();
    expect(
      (await gw.api.listConnectors({ threadId: t.threadId })).types.find((type) => type.id === "github_repository")
        ?.name,
    ).toBe("GitHub");
    expect((await gw.api.listConnectors({})).types.some((type) => type.id === "github_repository")).toBe(false);
    expect((await t.call("list_issues", {})).content).toContain("Deployment");
    const before = writes.length;
    expect((await t.call("create_issue", { title: "Investigate" })).isError).toBe(true);
    const readId = crypto.randomUUID();
    const args = { path: "docs/private.md", ref: "feature/layout" };
    const file = await t.call("read_file", args, readId);
    expect(file.isError).toBe(false);
    expect(file.content).toContain(fileText);
    expect(file.content).toContain("[REDACTED]");
    expect(file.content).not.toContain("example.test");

    for (const secret of fixture.secrets) expect(file.resultJson).not.toContain(secret);
    readable = false;

    try {
      const hidden = await t.call("read_file", args, readId);
      expect(hidden.isError).toBe(true);
      expect(hidden.resultJson).not.toContain(fileText);
    } finally {
      readable = true;
    }

    const beforeReads = reads.length;
    expect((await t.call("read_file", { path: "../another" })).isError).toBe(true);
    expect((await t.call("read_file", { ...args, repo: "other/private" })).isError).toBe(true);
    expect(reads).toHaveLength(beforeReads);
    renamed = true;

    try {
      expect((await t.call("read_file", args, readId)).isError).toBe(true);
      expect(reads).toHaveLength(beforeReads);
    } finally {
      renamed = false;
    }

    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    fileStarted = entered.resolve;
    fileGate = release.promise;
    const pending = t.call("read_file", args);

    try {
      await entered.promise;
      await access([]);
    } finally {
      release.resolve();
      fileGate = undefined;
    }

    const revoked = await pending;
    expect(revoked.isError).toBe(true);
    expect(revoked.resultJson).not.toContain(fileText);
    expect((await t.call("read_file", args, readId)).isError).toBe(true);

    await access([projectId], true);
    const limited = await thread(PermissionMode.READ_ONLY);
    expect(limited.connectorTools.some((tool) => tool.remoteName === "create_issue" && !tool.readOnly)).toBe(true);
    expect((await limited.call("create_issue", { title: "Investigate" })).isError).toBe(true);
    expect((await t.call("create_pull_request", { head: "fork:feature", base: "dev", title: "Review" })).isError).toBe(
      true,
    );
    expect(writes).toHaveLength(before);
    const pull = { head: "feature/layout", base: "dev", title: "Review", draft: true };
    const created = await t.call("create_pull_request", pull);
    expect(created.isError).toBe(false);
    expect(created.content).toContain("https://github.com/itsoltech/canopy/pull/88");
    expect(writes.at(-1)?.path).toBe("/repositories/777/pulls");
    expect(JSON.parse(writes.at(-1)!.body)).toEqual(pull);
    lost = true;

    try {
      const issueId = crypto.randomUUID();

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await t.call("create_issue", { title: "Investigate" }, issueId);
        expect(result.isError).toBe(true);
        expect(result.content).toContain("outcome is unknown");
      }

      expect(writes.slice(before).map((w) => w.path)).toEqual(["/repositories/777/pulls", "/repositories/777/issues"]);
    } finally {
      lost = false;
    }
  }, 30_000);

  test("changing the GitHub account revision while a thread awaits approval invalidates that write", async () => {
    await access([projectId], true);
    const t = await thread(PermissionMode.ASK);
    const id = crypto.randomUUID();
    const pending = t.call("create_issue", { title: "Investigate" }, id);
    const before = writes.length;
    await eventually(
      () => gw.api.getThread({ threadId: t.threadId }),
      (r) => r.thread?.pendingInteractions === 1,
    );
    extraRepository = true;
    await gw.api.listGitHubInstallations({ accountId, refresh: true });
    await gw.api.answerInteraction({ requestId: id, allow: true });
    expect((await pending).isError).toBe(true);
    expect(writes).toHaveLength(before);

    const readId = crypto.randomUUID();
    const args = { path: "docs/private.md" };
    expect((await t.call("read_file", args, readId)).content).toContain(fileText);
    installed = false;

    try {
      await gw.api.listGitHubInstallations({ accountId, refresh: true });
      expect(
        (await gw.api.listConnectors({ threadId: t.threadId })).accounts.some(
          (a) => a.connectorType === "github_repository",
        ),
      ).toBe(false);
      expect((await t.call("read_file", args, readId)).isError).toBe(true);
    } finally {
      installed = true;
      extraRepository = false;
      await gw.api.listGitHubInstallations({ accountId, refresh: true });
    }
  }, 15_000);

  test("bot dispatch uses its own grant and approval policy before posting an issue comment", async () => {
    gw.core.bots.start();
    await gw.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "repository-tools",
      label: "Fixture",
      create: true,
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture",
      allWorkers: true,
    });
    await eventually(
      () => gw.core.bots.run((s) => s.harnessModels(gw.userId, Provider.CODEX, "repository-tools")),
      (models) => models.some((m) => m.id === "gpt-6.1-sol"),
    );

    const botId = (
      await gw.api.createBot({
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name: "Issue triage",
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "repository-tools",
          model: "gpt-6.1-sol",
          approvalPolicy: "safe",
        },
      })
    ).bot!.id;

    const catalog = () => gw.core.connectors.botTools(botId);
    expect((await catalog()).filter((tool) => tool.remoteName === "read_file")).toHaveLength(0);
    await access([], false, [botId]);
    expect((await catalog()).some((tool) => tool.remoteName === "read_issue")).toBe(true);
    expect((await catalog()).some((tool) => tool.remoteName === "add_comment")).toBe(false);
    await access([], true, [botId]);
    const before = writes.length;
    await gw.api.sendBotMessage({ botId, clientRequestId: crypto.randomUUID(), text: "Comment on issue 42" });
    const conversation = () => gw.core.bots.run((s) => s.conversation(gw.userId, botId));
    const pending = await eventually(conversation, (s) => s.approvals.some((a) => a.status === "pending"));
    expect(botTool).not.toBe("");
    expect(writes).toHaveLength(before);
    await gw.api.answerBotApproval({
      approvalId: pending.approvals.find((a) => a.status === "pending")!.id,
      approve: true,
    });
    await eventually(conversation, (s) => !s.working);
    expect(writes.slice(before).map((w) => [w.path, JSON.parse(w.body)])).toEqual([
      ["/repositories/777/issues/42/comments", { body: "Checked the deployment" }],
    ]);

    await gw.api.sendBotMessage({ botId, clientRequestId: crypto.randomUUID(), text: "Comment again" });
    const next = await eventually(conversation, (s) => s.approvals.some((a) => a.status === "pending"));
    await access([], false, [botId]);
    await access([], true, [botId]);
    await gw.api.answerBotApproval({
      approvalId: next.approvals.find((a) => a.status === "pending")!.id,
      approve: true,
    });
    await eventually(conversation, (s) => !s.working);
    expect(writes).toHaveLength(before + 1);
  }, 30_000);
});
