/** Real UI RPCs and WorkerLink exercise ephemeral previews without automation commands or transcripts. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  AgentTool,
  AgentPreviewEventSchema,
  AgentPreviewInputSchema,
  AgentToolInfoSchema,
  PermissionMode,
  Provider,
  WorkerMessageSchema,
  ui,
  type AgentPreviewEvent,
  type AgentPreviewCommand,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { AGENT_PREVIEW_FOLLOW_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { expectLinkedAgentPreview } from "./support/agent-preview-linked.ts";

const capabilities = ["agent_tools_v1", "agent_preview_v1", AGENT_PREVIEW_FOLLOW_CAPABILITY];

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGLsAAAAASUVORK5CYII=",
  "base64",
);

let gateway: TestGateway;
let threadId: string;
let revision = 0;
const controllers = new Set<AbortController>();
const tasks = new Set<Promise<void>>();

const query = <A extends object>(statement: string, params: readonly string[] = []) =>
  gateway.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.unsafe<A>(statement, params);
    }),
  );

const code = (result: Promise<unknown>) =>
  result.then(
    () => 0,
    (cause: unknown) => ConnectError.from(cause).code,
  );

const commands = (worker = gateway.worker) => worker.previewCommands;

const ofKind = (kind: AgentPreviewCommand["kind"]["case"], worker = gateway.worker) =>
  commands(worker).filter((command) => command.kind.case === kind);

async function ready(
  worker = gateway.worker,
  workerId = gateway.workerId,
  override: MessageInitShape<typeof AgentToolInfoSchema> = {},
) {
  const detail = `Preview report ${++revision}`;
  worker.previewHandler = (command) => {
    if (command.kind.case === "start")
      worker.link.send({ case: "agentPreview", value: { previewId: command.kind.value.previewId, state: "ready" } });
  };

  const value = {
    tools: [AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE].map((tool) => ({
      tool,
      installed: true,
      ready: true,
      screenshot: true,
      version: tool === AgentTool.DEVICE ? "0.21.37" : tool === AgentTool.DESKTOP ? "1.3.1" : "0.43.0",
      detail,
    })),
  };

  worker.link.send({ case: "agentToolsReport", value });
  await eventually(
    async () => (await gateway.api.getOverview({})).workers.find((worker) => worker.id === workerId),
    (worker) => worker?.agentTools[0]?.tool?.detail === detail,
  );

  for (const tool of [AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE])
    await gateway.api.setAgentToolEnabled({ workerId, tool, enabled: true });

  if (override.tool) {
    const changed = `${detail} changed`;

    const tools = value.tools.map((tool) => ({
      ...tool,
      ...(override.tool === tool.tool && override),
      detail: changed,
    }));

    worker.link.send({ case: "agentToolsReport", value: { tools } });
    await eventually(
      async () => (await gateway.api.getOverview({})).workers.find((worker) => worker.id === workerId),
      (worker) => worker?.agentTools[0]?.tool?.detail === changed,
    );
  }
}

async function makeThread(workerId = gateway.workerId) {
  const project = (await gateway.api.createProject({ name: "Interactive preview" })).project!;

  const workspace = (await gateway.api.createWorkspace({ projectId: project.id, workerId, rootPath: "/repo/preview" }))
    .workspace!;

  const thread = (
    await gateway.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      permissionMode: PermissionMode.READ_ONLY,
    })
  ).thread!;

  await eventually(
    () => query<{ status: string }>("SELECT status FROM threads WHERE id=$1::uuid", [thread.id]),
    (rows) => rows[0]?.status === "idle",
  );

  return thread.id;
}

function start(
  id = threadId,
  scope: MessageInitShape<typeof ui.WatchAgentPreviewRequestSchema>["scope"] = { tool: AgentTool.BROWSER },
  maxFps = 0,
  followAgent = false,
) {
  const abort = new AbortController();
  controllers.add(abort);
  const events: AgentPreviewEvent[] = [];
  let failure = 0;

  const done = (async () => {
    try {
      for await (const event of gateway.api.watchAgentPreview(
        { threadId: id, scope, maxFps, followAgent },
        { signal: abort.signal, timeoutMs: 0 },
      ))
        events.push(event);
    } catch (cause) {
      failure = ConnectError.from(cause).code;
    }
  })();

  tasks.add(done);

  return { abort, events, done, failure: () => failure };
}

async function opened(id = threadId, worker = gateway.worker, tool = AgentTool.BROWSER) {
  const watch = start(id, { tool });
  await eventually(
    async () => watch.events.length,
    (count) => count > 0,
  );
  expect(watch.events[0]?.state).toBe("ready");
  const previewId = watch.events[0]!.previewId;

  const command = ofKind("start", worker).find(
    (item) => item.kind.case === "start" && item.kind.value.previewId === previewId,
  );

  expect(command?.kind.case).toBe("start");

  return { ...watch, previewId };
}

const frame = (previewId: string, frameId = 1n, overrides: MessageInitShape<typeof AgentPreviewEventSchema> = {}) =>
  create(AgentPreviewEventSchema, {
    previewId,
    frameId,
    state: "frame",
    data: png,
    mimeType: "image/png",
    width: 1,
    height: 1,
    ...overrides,
  });

describe.skipIf(!dockerAvailable)("thread preview streaming and human input", () => {
  beforeAll(async () => {
    gateway = await startTestGateway({ worker: { hello: { capabilities } } });
  }, 60_000);

  beforeEach(async () => {
    await ready();
    threadId = await makeThread();
    commands().length = 0;
  });

  afterEach(async () => {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(tasks);
    controllers.clear();
    tasks.clear();
    expect(
      await eventually(
        async () => gateway.core.link.connections.get(gateway.workerId)?.previewWatches.size,
        (size) => size === 0,
      ),
    ).toBe(0);
  });

  afterAll(async () => {
    await gateway?.close();
  }, 30_000);

  test("human mouse and keyboard input uses the owned thread session without requiring an active turn", async () => {
    const before = await query("SELECT seq FROM thread_events WHERE thread_id=$1::uuid", [threadId]);
    const watch = await opened();
    const start = ofKind("start")[0]!.kind;
    expect(start.case === "start" && start.value).toMatchObject({
      threadId,
      previewId: watch.previewId,
      maxFps: 12,
      followAgent: false,
      scope: { tool: AgentTool.BROWSER, session: threadId, operation: "", target: "", value: "" },
    });

    const inputs = [
      { kind: "pointer-move", x: 0.5, y: 0.25 },
      { kind: "pointer-down", x: 0.5, y: 0.25, buttons: 1 },
      { kind: "pointer-up", x: 0.5, y: 0.25 },
      { kind: "wheel", deltaY: 120 },
      { kind: "key-down", key: "a", code: "KeyA", modifiers: 2 },
      { kind: "key-up", key: "a", code: "KeyA" },
      { kind: "text", text: "Hello\nworld" },
      { kind: "navigate", text: "http://localhost:8000/preview" },
      { kind: "back" },
      { kind: "forward" },
      { kind: "reload" },
      { kind: "home" },
      { kind: "resize", width: 1280, height: 720 },
      { kind: "release" },
    ];

    await gateway.api.sendAgentPreviewInput({ threadId, previewId: watch.previewId, inputs });
    await eventually(
      async () => ofKind("input").length,
      (count) => count === 1,
    );
    const sent = ofKind("input")[0]!.kind;
    expect(sent.case === "input" && sent.value).toMatchObject({ previewId: watch.previewId, inputs });
    gateway.worker.link.send({ case: "agentPreview", value: frame(watch.previewId) });
    await eventually(
      async () => watch.events.length,
      (count) => count === 2,
    );
    expect(watch.events[1]?.data).toEqual(new Uint8Array(png));
    await eventually(
      async () => ofKind("ack").some((command) => command.kind.case === "ack" && command.kind.value.frameId === 1n),
      Boolean,
    );
    expect(gateway.worker.commands.some((command) => command.case === "runAgentTool")).toBe(false);
    expect(await query("SELECT id FROM worker_commands WHERE kind ILIKE '%preview%'")).toEqual([]);
    expect(await query("SELECT seq FROM thread_events WHERE thread_id=$1::uuid", [threadId])).toEqual(before);
    expect(await query("SELECT id FROM attachments WHERE thread_id=$1::uuid", [threadId])).toEqual([]);
  });

  test("scope, frame-rate, grants, owner and old-worker checks refuse a preview before start", async () => {
    for (const scope of [
      {},
      { tool: 99 as AgentTool },
      ...["session", "operation", "target", "value"].map((field) => ({ tool: AgentTool.BROWSER, [field]: "injected" })),
      { tool: AgentTool.BROWSER, windowId: "1" },
      { tool: AgentTool.DEVICE, deviceId: "1", platform: "unsupported" },
    ]) {
      const watch = start(threadId, scope);
      await watch.done;
      expect(watch.failure()).toBe(Code.InvalidArgument);
    }

    const fps = start(threadId, { tool: AgentTool.BROWSER }, 21);
    await fps.done;
    expect(fps.failure()).toBe(Code.InvalidArgument);

    const invalidFollow = start(threadId, { tool: AgentTool.BROWSER }, 4, true);
    await invalidFollow.done;
    expect(invalidFollow.failure()).toBe(Code.InvalidArgument);

    for (const id of ["invalid", crypto.randomUUID()]) {
      const watch = start(id);
      await watch.done;
      expect([Code.InvalidArgument, Code.NotFound]).toContain(watch.failure());
    }

    await gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool: AgentTool.BROWSER });
    const disabled = start();
    await disabled.done;
    expect(disabled.failure()).toBe(Code.PermissionDenied);
    await gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool: AgentTool.BROWSER, enabled: true });
    const connection = gateway.core.link.connections.get(gateway.workerId)!;
    connection.hello.capabilities = ["agent_tools_v1"];

    try {
      const old = start();
      await old.done;
      expect(old.failure()).toBe(Code.Unimplemented);
      connection.hello.capabilities = ["agent_tools_v1", "agent_preview_v1"];
      const oldDesktop = start(threadId, { tool: AgentTool.DESKTOP }, 4, true);
      await oldDesktop.done;
      expect(oldDesktop.failure()).toBe(Code.Unimplemented);
    } finally {
      connection.hello.capabilities = capabilities;
    }

    const owner = await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("preview-owner@example.test", "Other owner")),
    );

    const privateId = crypto.randomUUID();
    await query(
      `INSERT INTO threads (id,project_id,owner_user_id,kind,root_thread_id,depth,runtime,provider,worker_id,workspace_id,cwd,title,status)
      SELECT $1::uuid,project_id,$2::uuid,'main',$1::uuid,0,runtime,provider,worker_id,workspace_id,cwd,'Private preview','idle'
      FROM threads WHERE id=$3::uuid`,
      [privateId, owner, threadId],
    );
    const foreign = start(privateId);
    await foreign.done;
    expect(foreign.failure()).toBe(Code.NotFound);
    expect(ofKind("start")).toHaveLength(0);
  });

  test("Linux and Web preview selectors accept catalog IDs without widening manual operations", async () => {
    for (const platform of ["linux", "web"]) {
      const deviceId = `${platform}:catalog-device-123`;
      const scope = { tool: AgentTool.DEVICE, platform, deviceId };
      const watch = start(threadId, scope);
      await eventually(
        async () => watch.events.length,
        (count) => count > 0,
      );
      expect(watch.events[0]?.state).toBe("ready");
      const sent = ofKind("start").at(-1)?.kind;
      expect(sent?.case === "start" && sent.value.scope).toMatchObject({ ...scope, session: threadId });
      expect(
        await code(
          gateway.api.runAgentTool({ workerId: gateway.workerId, operation: { ...scope, operation: "snapshot" } }),
        ),
      ).toBe(Code.InvalidArgument);
      watch.abort.abort();
      await watch.done;
      const before = ofKind("start").length;

      for (const invalid of [
        "-option",
        "   ",
        "bad\nselector",
        "bad\tselector",
        "bad\u0085selector",
        "x".repeat(16_385),
      ]) {
        const refused = start(threadId, { ...scope, deviceId: invalid });
        await refused.done;
        expect(refused.failure()).toBe(Code.InvalidArgument);
      }

      expect(ofKind("start")).toHaveLength(before);
    }

    expect(gateway.worker.commands.some((command) => command.case === "runAgentTool")).toBe(false);
  });

  test("device preview discovery still requires the owner grant, exact pinned installation and live worker", async () => {
    await ready(gateway.worker, gateway.workerId, { tool: AgentTool.DEVICE, ready: false });
    await gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool: AgentTool.DEVICE });
    const disabled = start(threadId, { tool: AgentTool.DEVICE });
    await disabled.done;
    expect(disabled.failure()).toBe(Code.PermissionDenied);

    for (const override of [
      { installed: false, ready: false },
      { version: "0.21.36", ready: false },
      { version: "0.21.36", ready: true },
      { ready: false, install: { state: "running", installId: crypto.randomUUID() } },
    ]) {
      await ready(gateway.worker, gateway.workerId, { tool: AgentTool.DEVICE, ...override });
      const refused = start(threadId, { tool: AgentTool.DEVICE });
      await refused.done;
      expect(refused.failure()).toBe(Code.FailedPrecondition);
    }

    for (const tool of [AgentTool.BROWSER, AgentTool.DESKTOP]) {
      await ready(gateway.worker, gateway.workerId, { tool, ready: false });
      const refused = start(threadId, { tool });
      await refused.done;
      expect(refused.failure()).toBe(Code.FailedPrecondition);
    }

    expect(ofKind("start")).toHaveLength(0);
    await ready(gateway.worker, gateway.workerId, { tool: AgentTool.DEVICE, ready: false });
    const source = gateway.core.link.connections.get(gateway.workerId)!;
    source.hello.capabilities = ["agent_tools_v1"];

    try {
      const old = start(threadId, { tool: AgentTool.DEVICE });
      await old.done;
      expect(old.failure()).toBe(Code.Unimplemented);
    } finally {
      source.hello.capabilities = capabilities;
    }
  });

  test("device preview and MCP can select an unready device while manual calls still require readiness", async () => {
    await ready(gateway.worker, gateway.workerId, { tool: AgentTool.DEVICE, ready: false });
    gateway.worker.previewHandler = (command) => {
      if (command.kind.case !== "start") return;
      workerReady(command.kind.value.previewId, Boolean(command.kind.value.scope?.deviceId));
    };

    const workerReady = (previewId: string, selected: boolean) =>
      gateway.worker.link.send({
        case: "agentPreview",
        value: {
          previewId,
          state: "ready",
          targetId: selected ? "web:chromium" : "",
          targets: [{ id: "web:chromium", deviceId: "chromium", platform: "web", label: "Chromium", active: selected }],
        },
      });

    const discovery = start(threadId, { tool: AgentTool.DEVICE });
    await eventually(
      async () => discovery.events.length,
      (count) => count === 1,
    );
    expect(discovery.events[0]).toMatchObject({ targetId: "", targets: [{ deviceId: "chromium", platform: "web" }] });
    discovery.abort.abort();
    await discovery.done;
    const selected = start(threadId, { tool: AgentTool.DEVICE, platform: "web", deviceId: "chromium" });
    await eventually(
      async () => selected.events.length,
      (count) => count === 1,
    );
    const previewId = selected.events[0]!.previewId;
    expect(selected.events[0]?.targetId).toBe("web:chromium");
    await gateway.api.sendAgentPreviewInput({ threadId, previewId, inputs: [{ kind: "text", text: "Hello device" }] });
    expect(
      await eventually(
        async () => ofKind("input").length,
        (count) => count === 1,
      ),
    ).toBe(1);
    expect(
      await eventually(
        async () =>
          ofKind("ack").some((command) => command.kind.case === "ack" && command.kind.value.previewId === previewId),
        Boolean,
        2000,
      ),
    ).toBe(true);
    expect(selected.failure()).toBe(0);
    expect(await code(gateway.core.agentTools.authorize(gateway.workerId, AgentTool.DEVICE))).toBe(
      Code.FailedPrecondition,
    );
    expect(await gateway.core.agentTools.readyTools(gateway.workerId)).toContain(AgentTool.DEVICE);
    expect(
      await code(
        gateway.api.runAgentTool({
          workerId: gateway.workerId,
          operation: { tool: AgentTool.DEVICE, operation: "snapshot" },
        }),
      ),
    ).toBe(Code.FailedPrecondition);
    gateway.worker.holdTurns = true;

    const turn = (
      await gateway.api.sendMessage({
        threadId,
        text: "Check permissions",
        clientRequestId: crypto.randomUUID(),
        permissionMode: PermissionMode.FULL_AUTO,
      })
    ).turn!;

    try {
      expect(
        (
          await eventually(
            () => gateway.runtime.runPromise(GatewayStore.use((store) => store.runningTurn(threadId))),
            (running) => running?.id === turn.id,
          )
        )?.id,
      ).toBe(turn.id);

      const authorize = (tool: AgentTool) =>
        gateway.worker.callTool({
          threadId,
          turnId: turn.id,
          tool: "authorize_local_automation",
          args: { tool, name: "snapshot", arguments: "{}" },
          expiresAt: new Date(Date.now() + 5000),
        });

      expect((await authorize(AgentTool.BROWSER)).isError).toBe(false);
      expect((await authorize(AgentTool.DEVICE)).isError).toBe(false);
    } finally {
      gateway.worker.finish(threadId, turn.id);
      gateway.worker.holdTurns = false;
    }

    await gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool: AgentTool.DEVICE });
    expect(await code(gateway.api.sendAgentPreviewInput({ threadId, previewId, inputs: [{ kind: "release" }] }))).toBe(
      Code.PermissionDenied,
    );
    await selected.done;
    expect(selected.failure()).toBe(Code.PermissionDenied);
  }, 10_000);

  test("bounded input batches reject unknown kinds, malformed numbers and commands without forwarding", async () => {
    const watch = await opened();

    const invalid: MessageInitShape<typeof AgentPreviewInputSchema>[][] = [
      [],
      Array.from({ length: 65 }, () => ({ kind: "release" })),
      [{ kind: "execute" }],
      [{ kind: "pointer-down", x: -0.01 }],
      [{ kind: "pointer-down", y: 1.01 }],
      [{ kind: "pointer-move", x: NaN }],
      [{ kind: "wheel", deltaX: Infinity }],
      [{ kind: "wheel", deltaY: 100_001 }],
      [{ kind: "key-down", key: "x".repeat(129) }],
      [{ kind: "key-down", code: "\0" }],
      [{ kind: "text", text: "é".repeat(4097) }],
      [{ kind: "text", text: "\0" }],
      [{ kind: "pointer-down", button: 3 }],
      [{ kind: "pointer-down", buttons: 8 }],
      [{ kind: "key-up", modifiers: 16 }],
      [{ kind: "resize", width: 0, height: 200 }],
      [{ kind: "resize", width: 8193, height: 200 }],
      [{ kind: "navigate", text: "javascript:alert(1)" }],
      [{ kind: "navigate", text: "invalid" }],
      Array.from({ length: 5 }, () => ({ kind: "text", text: "x".repeat(8192) })),
    ];

    for (const inputs of invalid)
      expect(await code(gateway.api.sendAgentPreviewInput({ threadId, previewId: watch.previewId, inputs }))).toBe(
        Code.InvalidArgument,
      );

    for (const { id, previewId } of [
      { id: crypto.randomUUID(), previewId: watch.previewId },
      { id: threadId, previewId: crypto.randomUUID() },
    ])
      expect(
        await code(gateway.api.sendAgentPreviewInput({ threadId: id, previewId, inputs: [{ kind: "release" }] })),
      ).toBe(Code.NotFound);
    expect(
      await code(gateway.api.sendAgentPreviewInput({ threadId, previewId: "invalid", inputs: [{ kind: "release" }] })),
    ).toBe(Code.InvalidArgument);
    expect(ofKind("input")).toHaveLength(0);
  });

  test("a stalled consumer keeps only the newest frame and heartbeat never acknowledges its unconsumed frame", async () => {
    const abort = new AbortController();
    controllers.add(abort);

    const iterator = gateway.core.agentPreviews
      .watch(
        create(ui.WatchAgentPreviewRequestSchema, {
          threadId,
          scope: { tool: AgentTool.BROWSER },
          maxFps: 20,
        }),
        abort.signal,
      )
      [Symbol.asyncIterator]();

    const initial = await iterator.next();
    const previewId = initial.value!.previewId;
    const source = gateway.core.link.connections.get(gateway.workerId)!;
    let received = 0n;
    const deliver = source.deliver.bind(source);

    const spy = spyOn(source, "deliver").mockImplementation((message) => {
      deliver(message);

      if (message.payload.case === "agentPreview") received = message.payload.value.frameId;
    });

    try {
      gateway.worker.link.send({ case: "agentPreview", value: frame(previewId) });
      expect((await iterator.next()).value?.frameId).toBe(1n);
      await eventually(
        async () => ofKind("ack").length,
        (count) => count > 0,
        2000,
      );
      expect(ofKind("ack").every((command) => command.kind.case === "ack" && command.kind.value.frameId === 0n)).toBe(
        true,
      );

      for (let id = 2n; id <= 20n; id++)
        gateway.worker.link.send({ case: "agentPreview", value: frame(previewId, id) });
      expect(
        await eventually(
          async () => received,
          (id) => id === 20n,
        ),
      ).toBe(20n);
      expect((await iterator.next()).value?.frameId).toBe(20n);
      await eventually(
        async () => ofKind("ack").some((command) => command.kind.case === "ack" && command.kind.value.frameId === 1n),
        Boolean,
      );
      expect(ofKind("ack").some((command) => command.kind.case === "ack" && command.kind.value.frameId === 20n)).toBe(
        false,
      );
    } finally {
      spy.mockRestore();
      abort.abort();
      await iterator.return?.();
    }

    await eventually(
      async () => ofKind("stop").length,
      (count) => count === 1,
    );
    expect(ofKind("stop")).toHaveLength(1);
  }, 10_000);

  test("invalid or oversized worker frames close only their preview and release its slot", async () => {
    for (const overrides of [
      { data: new Uint8Array(2 * 1024 * 1024 + 1) },
      { mimeType: "text/html" },
      { width: 8193 },
      { height: 0 },
      { state: "unknown" },
      { frameId: 0n },
      { url: "x".repeat(8193) },
      { title: "x".repeat(4097) },
      { targets: Array.from({ length: 65 }, () => ({ id: "window" })) },
      { targets: Array.from({ length: 64 }, () => ({ label: "x".repeat(600) })) },
      { mode: "screenshots", targetId: "w-12", cursor: { actionId: "click-1", x: 0.5, y: 0.25, click: true } },
    ]) {
      const watch = await opened();
      gateway.worker.link.send({ case: "agentPreview", value: frame(watch.previewId, 1n, overrides) });
      await watch.done;
      expect(watch.failure()).toBe(Code.DataLoss);
      expect(watch.events.map((event) => event.state)).toEqual(["ready"]);
    }

    expect(gateway.core.link.connections.get(gateway.workerId)?.isOpen).toBe(true);
    expect(gateway.core.link.connections.get(gateway.workerId)?.previewWatches.size).toBe(0);
  });

  test("an automatic Desktop watch receives confirmed window frames and refuses an ordinary foreground capture", async () => {
    const abort = new AbortController();

    const request = create(ui.WatchAgentPreviewRequestSchema, {
      threadId,
      scope: { tool: AgentTool.DESKTOP },
      followAgent: true,
      clientAck: true,
    });

    const stream = gateway.core.agentPreviews.watch(request, abort.signal)[Symbol.asyncIterator]();

    try {
      const previewId = (await stream.next()).value!.previewId;
      expect(ofKind("start")[0]?.kind.value).toMatchObject({ followAgent: true, scope: { session: threadId } });
      expect(
        await code(gateway.api.sendAgentPreviewInput({ threadId, previewId, inputs: [{ kind: "release" }] })),
      ).toBe(Code.FailedPrecondition);
      expect(ofKind("input")).toHaveLength(0);
      const target = { mode: "screenshots", targetId: "w-12", followingAgent: true };
      gateway.worker.link.send({ case: "agentPreview", value: frame(previewId, 1n, target) });
      gateway.worker.link.send({ case: "agentPreview", value: { previewId, state: "ready" } });
      await eventually(
        async () => ofKind("ack").some((cmd) => cmd.kind.case === "ack" && cmd.kind.value.frameId === 1n),
        Boolean,
      );
      expect((await stream.next()).value?.state).toBe("ready");
      expect(await code(gateway.api.ackAgentPreview({ threadId, previewId, frameId: 1n }))).toBe(Code.InvalidArgument);
      gateway.worker.link.send({ case: "agentPreview", value: frame(previewId, 2n, target) });
      expect((await stream.next()).value).toMatchObject({ ...target, frameId: 2n });
      const observed = { mode: "screenshots", agentObservation: true, targetId: "", title: "Agent screenshot" };
      gateway.worker.link.send({ case: "agentPreview", value: frame(previewId, 3n, observed) });
      expect((await stream.next()).value).toMatchObject({ ...observed, frameId: 3n, data: new Uint8Array(png) });
      gateway.worker.link.send({ case: "agentPreview", value: frame(previewId, 4n, observed) });
      gateway.worker.link.send({ case: "agentPreview", value: { previewId, state: "ready" } });
      await eventually(
        async () => ofKind("ack").some((cmd) => cmd.kind.case === "ack" && cmd.kind.value.frameId === 4n),
        Boolean,
      );
      expect((await stream.next()).value?.state).toBe("ready");
      gateway.worker.link.send({
        case: "agentPreview",
        value: frame(previewId, 5n, { mode: "screenshots", targetId: "other-window" }),
      });
      expect(await code(stream.next())).toBe(Code.DataLoss);
    } finally {
      abort.abort();
      await stream.return?.();
    }
  });

  test("a Desktop viewer receives a window-relative cursor and rejects an out-of-frame action", async () => {
    const watch = await opened(threadId, gateway.worker, AgentTool.DESKTOP);
    const cursor = { actionId: "click-1", x: 0, y: 1, click: true };
    const desktop = { mode: "screenshots", targetId: "w-12", cursor };
    gateway.worker.link.send({ case: "agentPreview", value: frame(watch.previewId, 1n, desktop) });
    const received = await eventually(async () => watch.events.find((event) => event.frameId === 1n), Boolean);
    expect(received).toMatchObject(desktop);
    gateway.worker.link.send({
      case: "agentPreview",
      value: frame(watch.previewId, 2n, { ...desktop, cursor: { ...cursor, x: 1.1 } }),
    });
    await watch.done;
    expect(watch.failure()).toBe(Code.DataLoss);
    expect(watch.events.some((event) => event.frameId === 2n)).toBe(false);
  });

  test("revoking the grant or archiving the thread stops an idle watch and refuses late input", async () => {
    const revoked = await opened();
    await gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool: AgentTool.BROWSER });
    expect(
      await code(
        gateway.api.sendAgentPreviewInput({ threadId, previewId: revoked.previewId, inputs: [{ kind: "release" }] }),
      ),
    ).toBe(Code.PermissionDenied);
    await revoked.done;
    expect(revoked.failure()).toBe(Code.PermissionDenied);
    await ready();
    const archived = await opened();
    await gateway.api.setThreadArchived({ threadId, archived: true });
    await archived.done;
    expect(archived.failure()).toBe(Code.FailedPrecondition);
    expect(ofKind("input")).toHaveLength(0);

    const stops = await eventually(
      async () => ofKind("stop").length,
      (count) => count === 2,
    );

    expect(stops).toBe(2);
  }, 10_000);

  test("cancellation and worker replacement close exact source watches and never replay on reconnect", async () => {
    const canceled = await opened();
    canceled.abort.abort();
    await canceled.done;
    await eventually(
      async () => ofKind("stop").length,
      (count) => count === 1,
    );
    expect(
      await code(
        gateway.api.sendAgentPreviewInput({ threadId, previewId: canceled.previewId, inputs: [{ kind: "release" }] }),
      ),
    ).toBe(Code.NotFound);
    const live = await opened();
    const source = gateway.core.link.connections.get(gateway.workerId)!;

    const replacement = await gateway.connect(gateway.workerId, gateway.workerCredential, undefined, {
      hello: { capabilities },
    });

    await live.done;
    expect(live.failure()).toBe(Code.Unavailable);
    expect(source.previewWatches.size).toBe(0);
    source.deliver(create(WorkerMessageSchema, { payload: { case: "agentPreview", value: frame(live.previewId) } }));
    expect(live.events.map((event) => event.state)).toEqual(["ready"]);
    expect(replacement.previewCommands).toEqual([]);
    expect(
      await code(
        gateway.api.sendAgentPreviewInput({ threadId, previewId: live.previewId, inputs: [{ kind: "release" }] }),
      ),
    ).toBe(Code.NotFound);
    expect(await query("SELECT id FROM worker_commands WHERE kind ILIKE '%preview%'")).toEqual([]);
    gateway.worker.link.close();
    // Restore the fixture's primary source after exercising a real replacement.
    replacement.link.close();

    const restored = await gateway.connect(gateway.workerId, gateway.workerCredential, undefined, {
      hello: { capabilities },
    });

    Object.assign(gateway, { worker: restored });
  });

  test("per-worker limits bound active watches and cancellation immediately frees capacity", async () => {
    const watches = await Promise.all(Array.from({ length: 4 }, () => opened()));
    const refused = start();
    await refused.done;
    expect(refused.failure()).toBe(Code.ResourceExhausted);
    expect(gateway.core.link.connections.get(gateway.workerId)?.previewWatches.size).toBe(4);
    watches[0]!.abort.abort();
    await watches[0]!.done;
    const reopened = await opened();
    expect(reopened.events[0]?.state).toBe("ready");
    expect(gateway.core.link.connections.get(gateway.workerId)?.previewWatches.size).toBe(4);
  });

  test("revoked workers cannot retain a preview even while their original link is still open", async () => {
    const watch = await opened();

    try {
      await query("UPDATE workers SET revoked_at=now() WHERE id=$1::uuid", [gateway.workerId]);
      expect(
        await code(
          gateway.api.sendAgentPreviewInput({ threadId, previewId: watch.previewId, inputs: [{ kind: "release" }] }),
        ),
      ).toBe(Code.NotFound);
      await watch.done;
      expect(watch.failure()).toBe(Code.NotFound);
      expect(gateway.core.link.connections.get(gateway.workerId)?.previewWatches.size).toBe(0);
    } finally {
      await query("UPDATE workers SET revoked_at=NULL WHERE id=$1::uuid", [gateway.workerId]);
    }
  });

  test("global limits bound sessions across workers and cancellation frees one shared slot", async () => {
    const primary = await Promise.all(Array.from({ length: 4 }, () => opened()));

    for (let index = 1; index < 16; index++) {
      const registered = await gateway.addWorker(`Global preview worker ${index}`);

      const worker = await gateway.connect(registered.workerId, registered.credential, undefined, {
        hello: { capabilities },
      });

      await ready(worker, registered.workerId);
      const id = await makeThread(registered.workerId);
      await Promise.all(Array.from({ length: 4 }, () => opened(id, worker)));
    }

    const overflow = await gateway.addWorker("Overflow preview worker");

    const worker = await gateway.connect(overflow.workerId, overflow.credential, undefined, {
      hello: { capabilities },
    });

    await ready(worker, overflow.workerId);
    const id = await makeThread(overflow.workerId);
    const refused = start(id);
    await refused.done;
    expect(refused.failure()).toBe(Code.ResourceExhausted);
    expect(ofKind("start", worker)).toHaveLength(0);
    primary[0]!.abort.abort();
    await primary[0]!.done;
    expect((await opened(id, worker)).events[0]?.state).toBe("ready");
  }, 30_000);

  test(
    "linked previews route the thread while preserving native target and preview IDs",
    expectLinkedAgentPreview,
    90_000,
  );
});
