/** The owner fills a project login in Browser Preview: only the gateway reads it and swaps in the value. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AgentTool, PermissionMode, Provider, type AgentPreviewEvent } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { LOGIN_PASSWORD_MAX, PROJECT_LOGINS } from "@canopy/domain/project-logins";
import { validatePreviewInputs as validateWorkerInputs } from "../../apps/worker/src/agent-preview/validation.ts";
import { Code, ConnectError } from "@connectrpc/connect";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const login = {
  websites: ["https://staging.example.test"],
  username: "abc@example.test",
  showUsername: false,
  notes: "",
  askEachTime: true,
  outsideBrowser: false,
  oneTimeCode: false,
};

describe.skipIf(!dockerAvailable)("project logins in Browser Preview", () => {
  let gw: TestGateway;
  const abort = new AbortController();

  const code = (result: Promise<unknown>) =>
    result.then(
      () => 0,
      (cause: unknown) => ConnectError.from(cause).code,
    );

  async function thread(name: string) {
    const project = (await gw.api.createProject({ name })).project!;

    const workspace = (
      await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: `/repo/${name}` })
    ).workspace!;

    const created = await gw.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.READ_ONLY,
    });

    return { projectId: project.id, threadId: created.thread!.id };
  }

  beforeAll(async () => {
    gw = await startTestGateway({
      worker: { hello: { capabilities: ["agent_tools_v1", "agent_preview_v1", PROJECT_LOGINS] } },
    });
    gw.worker.previewHandler = (command) => {
      if (command.kind.case === "start")
        gw.worker.link.send({
          case: "agentPreview",
          value: { previewId: command.kind.value.previewId, state: "ready" },
        });
    };

    gw.worker.link.send({
      case: "agentToolsReport",
      value: {
        tools: [{ tool: AgentTool.BROWSER, installed: true, ready: true, screenshot: true, version: "0.43.0" }],
      },
    });
    await eventually(
      async () => (await gw.api.getOverview({})).workers.find((worker) => worker.id === gw.workerId),
      (worker) => Boolean(worker?.agentTools.length),
    );
    await gw.api.setAgentToolEnabled({ workerId: gw.workerId, tool: AgentTool.BROWSER, enabled: true });
  }, 60_000);

  afterAll(async () => {
    abort.abort();
    await gw?.close();
  }, 30_000);

  test("sends the value only for a login of the thread's own project", async () => {
    const own = await thread("Login preview");
    const other = await thread("Other login project");
    // The longest password, in three-byte characters: the worker's own validator must accept what it gets.
    const password = "€".repeat(LOGIN_PASSWORD_MAX);
    await gw.api.putProjectLogin({ projectId: own.projectId, name: "STAGING_ADMIN", login, password });
    await gw.api.putProjectLogin({ projectId: other.projectId, name: "OTHER_LOGIN", login, password: "other" });
    const events: AgentPreviewEvent[] = [];

    void (async () => {
      for await (const event of gw.api.watchAgentPreview(
        { threadId: own.threadId, scope: { tool: AgentTool.BROWSER }, maxFps: 0, followAgent: false },
        { signal: abort.signal, timeoutMs: 0 },
      ))
        events.push(event);
    })().catch(() => undefined);

    await eventually(
      async () => events.length,
      (count) => count > 0,
    );
    const previewId = events[0]!.previewId;

    const send = (text: string, key: string) =>
      gw.api.sendAgentPreviewInput({ threadId: own.threadId, previewId, inputs: [{ kind: "login", text, key }] });

    await send("STAGING_ADMIN", "password");

    const sent = await eventually(
      async () =>
        gw.worker.previewCommands.flatMap((command) =>
          command.kind.case === "input" ? command.kind.value.inputs : [],
        ),
      (inputs) => inputs.length > 0,
    );

    expect(sent.map((input) => input.kind)).toEqual(["login-text"]);
    expect(sent[0]!.login).toMatchObject({
      name: "STAGING_ADMIN",
      text: password,
      websites: login.websites,
      masked: true,
      field: "password",
    });
    expect(sent[0]!.text).toBe("");
    expect(() => validateWorkerInputs(sent)).not.toThrow();
    expect(await code(send("OTHER_LOGIN", "password"))).toBe(Code.NotFound);
    expect(await code(send("STAGING_ADMIN", "one_time_code"))).toBe(Code.FailedPrecondition);
    expect(await code(send("STAGING_ADMIN", "token"))).toBe(Code.InvalidArgument);

    const twice = gw.api.sendAgentPreviewInput({
      threadId: own.threadId,
      previewId,
      inputs: [
        { kind: "login", text: "STAGING_ADMIN", key: "username" },
        { kind: "login", text: "STAGING_ADMIN", key: "password" },
      ],
    });

    expect(await code(twice)).toBe(Code.InvalidArgument);
    expect(gw.worker.previewCommands.filter((command) => command.kind.case === "input")).toHaveLength(1);
  }, 30_000);
});
