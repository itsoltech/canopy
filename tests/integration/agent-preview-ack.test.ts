/** Client paint acknowledgements cross real UI gRPC and WorkerLink without releasing unseen frames. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { AgentPreviewEventSchema, AgentTool, Provider, ui, type AgentPreviewEvent } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { qualifyId } from "@canopy/domain/computers";
import { GatewayStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { expectLinkedAgentPreviewWithClientAck } from "./support/agent-preview-linked.ts";
import { configComputer, pairConfig, type ConfigComputer } from "./support/config-sync.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGLsAAAAASUVORK5CYII=",
  "base64",
);

const capabilities = ["agent_tools_v1", "agent_preview_v1"];
let gateway: TestGateway;
let threadId: string;
const controllers = new Set<AbortController>();
const tasks = new Set<Promise<void>>();

const code = (result: Promise<object>) =>
  result.then(
    () => 0,
    (cause) => ConnectError.from(cause).code,
  );

const query = (statement: string, params: readonly string[]) =>
  gateway.runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      return yield* sql.unsafe(statement, params);
    }),
  );

async function makeThread() {
  const project = (await gateway.api.createProject({ name: "Paint acknowledgements" })).project!;

  const workspace = (
    await gateway.api.createWorkspace({ projectId: project.id, workerId: gateway.workerId, rootPath: "/repo/preview" })
  ).workspace!;

  return (
    await gateway.api.createThread({ projectId: project.id, workspaceId: workspace.id, provider: Provider.CODEX })
  ).thread!.id;
}

function controller() {
  const abort = new AbortController();
  controllers.add(abort);

  return abort;
}

async function watch(clientAck = true) {
  const abort = controller();
  const events: AgentPreviewEvent[] = [];

  const done = (async () => {
    try {
      for await (const event of gateway.api.watchAgentPreview(
        { threadId, scope: { tool: AgentTool.BROWSER }, clientAck },
        { signal: abort.signal, timeoutMs: 0 },
      ))
        events.push(event);
    } catch (cause) {
      if (!abort.signal.aborted && ConnectError.from(cause).code !== Code.Unavailable) throw cause;
    }
  })();

  tasks.add(done);
  await eventually(
    async () => events.length,
    (count) => count > 0,
  );

  return { abort, done, events, previewId: events[0]!.previewId };
}

function sendFrame(previewId: string, frameId: bigint) {
  gateway.worker.link.send({
    case: "agentPreview",
    value: create(AgentPreviewEventSchema, {
      previewId,
      frameId,
      state: "frame",
      data: png,
      mimeType: "image/png",
      width: 1,
      height: 1,
    }),
  });
}

const acknowledgements = (previewId: string) =>
  gateway.worker.previewCommands.flatMap((command) =>
    command.kind.case === "ack" && command.kind.value.previewId === previewId ? [command.kind.value.frameId] : [],
  );

const ack = (previewId: string, frameId: bigint, id = threadId) =>
  gateway.api.ackAgentPreview({ threadId: id, previewId, frameId });

describe.skipIf(!dockerAvailable)("preview client paint acknowledgements", () => {
  beforeAll(async () => {
    gateway = await startTestGateway({ worker: { hello: { capabilities } } });
    gateway.worker.previewHandler = (command) => {
      if (command.kind.case === "start")
        gateway.worker.link.send({
          case: "agentPreview",
          value: { previewId: command.kind.value.previewId, state: "ready" },
        });
    };

    gateway.worker.link.send({
      case: "agentToolsReport",
      value: {
        tools: [{ tool: AgentTool.BROWSER, installed: true, ready: true, version: "0.43.0" }],
      },
    });
    await eventually(
      async () => (await gateway.api.getOverview({})).workers.find((worker) => worker.id === gateway.workerId),
      (worker) => worker?.agentTools[0]?.tool?.ready === true,
    );
  }, 60_000);

  beforeEach(async () => {
    await gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool: AgentTool.BROWSER, enabled: true });
    threadId = await makeThread();
    gateway.worker.previewCommands.length = 0;
  });

  afterEach(async () => {
    for (const abort of controllers) abort.abort();
    await Promise.allSettled(tasks);
    controllers.clear();
    tasks.clear();
    await eventually(
      async () => gateway.core.link.connections.get(gateway.workerId)?.previewWatches.size,
      (n) => n === 0,
    );
  });

  afterAll(async () => {
    await gateway?.close();
  }, 30_000);

  test("heartbeats renew the lease with only the painted frame and cancellation removes its watch", async () => {
    const current = await watch();
    sendFrame(current.previewId, 1n);
    await eventually(
      async () => current.events.length,
      (n) => n === 2,
    );
    await eventually(
      async () => acknowledgements(current.previewId).length,
      (n) => n > 0,
      2000,
    );
    expect(acknowledgements(current.previewId).every((id) => id === 0n)).toBe(true);
    await ack(current.previewId, 1n);
    await eventually(async () => acknowledgements(current.previewId).includes(1n), Boolean);
    sendFrame(current.previewId, 2n);
    await eventually(
      async () => current.events.length,
      (n) => n === 3,
    );
    const before = acknowledgements(current.previewId).length;
    await eventually(
      async () => acknowledgements(current.previewId).length,
      (n) => n > before,
      2000,
    );
    expect(acknowledgements(current.previewId).slice(before)).toEqual([1n]);
    await ack(current.previewId, 1n);
    expect(await code(ack(current.previewId, 3n))).toBe(Code.InvalidArgument);
    expect(acknowledgements(current.previewId).includes(2n)).toBe(false);
    await ack(current.previewId, 2n);
    await eventually(async () => acknowledgements(current.previewId).includes(2n), Boolean);
    expect(await code(ack(current.previewId, 1n))).toBe(Code.InvalidArgument);
    current.abort.abort();
    await current.done;
    await eventually(
      async () =>
        gateway.worker.previewCommands.some(
          (command) => command.kind.case === "stop" && command.kind.value.previewId === current.previewId,
        ),
      Boolean,
    );
    expect(await code(ack(current.previewId, 2n))).toBe(Code.NotFound);
  });

  test("rejects zero, future, missing, mismatched-thread and other-watch acknowledgements", async () => {
    const first = await watch();
    const second = await watch();
    sendFrame(first.previewId, 1n);
    sendFrame(second.previewId, 7n);
    await eventually(
      async () => first.events.length + second.events.length,
      (n) => n === 4,
    );

    for (const [previewId, frameId, id, expected] of [
      [first.previewId, 0n, threadId, Code.InvalidArgument],
      [first.previewId, 2n, threadId, Code.InvalidArgument],
      [first.previewId, 7n, threadId, Code.InvalidArgument],
      [second.previewId, 1n, threadId, Code.InvalidArgument],
      [first.previewId, 1n, crypto.randomUUID(), Code.NotFound],
      [crypto.randomUUID(), 1n, threadId, Code.NotFound],
      ["invalid", 1n, threadId, Code.InvalidArgument],
    ] as const)
      expect(await code(ack(previewId, frameId, id))).toBe(expected);
    expect(acknowledgements(first.previewId).some((id) => id > 0n)).toBe(false);
    expect(acknowledgements(second.previewId).some((id) => id > 0n)).toBe(false);
    await ack(first.previewId, 1n);
    await ack(second.previewId, 7n);
  });

  test("received and coalesced worker frames cannot be acknowledged before the consumer receives them", async () => {
    const abort = controller();

    const iterator = gateway.core.agentPreviews
      .watch(
        create(ui.WatchAgentPreviewRequestSchema, {
          threadId,
          clientAck: true,
          scope: { tool: AgentTool.BROWSER },
        }),
        abort.signal,
      )
      [Symbol.asyncIterator]();

    const previewId = (await iterator.next()).value!.previewId;
    const source = gateway.core.link.connections.get(gateway.workerId)!;
    const deliver = source.deliver.bind(source);
    let received = 0n;

    const spy = spyOn(source, "deliver").mockImplementation((message) => {
      deliver(message);

      if (message.payload.case === "agentPreview") received = message.payload.value.frameId;
    });

    try {
      sendFrame(previewId, 1n);
      await eventually(
        async () => received,
        (id) => id === 1n,
      );
      expect(await code(ack(previewId, 1n))).toBe(Code.InvalidArgument);
      expect((await iterator.next()).value?.frameId).toBe(1n);
      await ack(previewId, 1n);
      sendFrame(previewId, 2n);
      sendFrame(previewId, 3n);
      await eventually(
        async () => received,
        (id) => id === 3n,
      );
      expect(await code(ack(previewId, 2n))).toBe(Code.InvalidArgument);
      expect(await code(ack(previewId, 3n))).toBe(Code.InvalidArgument);
      expect((await iterator.next()).value?.frameId).toBe(3n);
      expect(await code(ack(previewId, 2n))).toBe(Code.InvalidArgument);
      await ack(previewId, 3n);
      await eventually(async () => acknowledgements(previewId).includes(3n), Boolean);
      expect(acknowledgements(previewId).includes(2n)).toBe(false);
    } finally {
      spy.mockRestore();
      abort.abort();
      await iterator.return?.();
    }
  });

  test("rejects other owners' threads and rechecks the current tool grant before forwarding an acknowledgement", async () => {
    const current = await watch();
    sendFrame(current.previewId, 1n);
    await eventually(
      async () => current.events.length,
      (n) => n === 2,
    );

    const owner = await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("paint-owner@example.test", "Other owner")),
    );

    const privateId = crypto.randomUUID();
    await query(
      `INSERT INTO threads (id,project_id,owner_user_id,kind,root_thread_id,depth,runtime,provider,worker_id,workspace_id,cwd,title,status)
      SELECT $1::uuid,project_id,$2::uuid,'main',$1::uuid,0,runtime,provider,worker_id,workspace_id,cwd,'Private preview','idle'
      FROM threads WHERE id=$3::uuid`,
      [privateId, owner, threadId],
    );
    expect(await code(ack(current.previewId, 1n, privateId))).toBe(Code.NotFound);

    const foreign = gateway.api
      .watchAgentPreview({ threadId: privateId, clientAck: true, scope: { tool: AgentTool.BROWSER } })
      [Symbol.asyncIterator]();

    expect(await code(foreign.next())).toBe(Code.NotFound);

    expect(acknowledgements(current.previewId).some((id) => id > 0n)).toBe(false);
    await gateway.api.setAgentToolEnabled({ workerId: gateway.workerId, tool: AgentTool.BROWSER, enabled: false });
    expect([Code.PermissionDenied, Code.NotFound]).toContain(await code(ack(current.previewId, 1n)));
    expect(acknowledgements(current.previewId).some((id) => id > 0n)).toBe(false);
  });

  test("legacy clients still acknowledge stream consumption and cannot inject paint acknowledgements", async () => {
    const current = await watch(false);
    sendFrame(current.previewId, 1n);
    await eventually(
      async () => current.events.length,
      (n) => n === 2,
    );
    await eventually(async () => acknowledgements(current.previewId).includes(1n), Boolean);
    expect(await code(ack(current.previewId, 1n))).toBe(Code.FailedPrecondition);
  });

  test("a replacement worker link never receives an acknowledgement belonging to the original watch", async () => {
    const current = await watch();
    sendFrame(current.previewId, 1n);
    await eventually(
      async () => current.events.length,
      (n) => n === 2,
    );

    const replacement = await gateway.connect(gateway.workerId, gateway.workerCredential, undefined, {
      hello: { capabilities },
    });

    expect([Code.NotFound, Code.Unavailable]).toContain(await code(ack(current.previewId, 1n)));
    expect(replacement.previewCommands.some((command) => command.kind.case === "ack")).toBe(false);
  });

  test("routes explicit acknowledgements to the linked home while preview IDs stay opaque", async () => {
    await expectLinkedAgentPreviewWithClientAck();
  }, 60_000);

  test("refuses paint acknowledgements before opening a watch on a linked home without support", async () => {
    let viewer: ConfigComputer | undefined;
    let home: ConfigComputer | undefined;
    let restore: (() => void) | undefined;

    try {
      viewer = await configComputer("Paint viewer");
      home = await configComputer("Legacy preview home");
      const hello = home.links.hello.bind(home.links);

      const spy = spyOn(home.links, "hello").mockImplementation(() => {
        const message = hello();

        message.capabilities = message.capabilities.filter((name) => name !== "agent_preview_client_ack_v1");

        return message;
      });

      restore = () => spy.mockRestore();
      await pairConfig(viewer, home);
      const id = qualifyId(crypto.randomUUID(), home.node);
      const abort = controller();

      const iterator = viewer.gateway.api
        .watchAgentPreview(
          { threadId: id, clientAck: true, scope: { tool: AgentTool.BROWSER } },
          { signal: abort.signal, timeoutMs: 0 },
        )
        [Symbol.asyncIterator]();

      expect(await code(iterator.next())).toBe(Code.Unimplemented);
      expect(
        await code(viewer.gateway.api.ackAgentPreview({ threadId: id, previewId: crypto.randomUUID(), frameId: 1n })),
      ).toBe(Code.Unimplemented);
      expect(home.gateway.worker.previewCommands).toHaveLength(0);
    } finally {
      restore?.();
      await Promise.allSettled([viewer?.close(), home?.close()]);
    }
  }, 60_000);
});
