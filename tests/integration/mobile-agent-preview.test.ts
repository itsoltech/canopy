/** Native Connect over pinned TLS -> gateway -> WorkerLink, without UI or model processes. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  AgentTool,
  Provider,
  RunAgentToolSchema,
  ui,
  type AgentPreviewCommand,
  type AgentPreviewEvent,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";
import { emptyPreview, NativePreviewSession } from "../../apps/mobile/src/features/preview/preview-session.ts";
import { SERVICE_TOKEN, eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { nodePinnedTransport } from "./support/phone.ts";

type PreviewScope = MessageInitShape<typeof ui.WatchAgentPreviewRequestSchema>["scope"];

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGLsAAAAASUVORK5CYII=",
  "base64",
);

let gw: TestGateway;
let network: NetworkAccess;
let unmount: () => void;
let phone: ReturnType<typeof routedMobileClient>;
let deviceId: string;
let threadId: string;
const controllers = new Set<AbortController>();
const tasks = new Set<Promise<void>>();
const transport = nodePinnedTransport();

const client = (token?: string) =>
  routedMobileClient({ connection: gw.core.mobile.networkRoutes(), ...(token && { token }), transport });

const code = (result: Promise<unknown>) =>
  result.then(
    () => 0,
    (cause: unknown) => ConnectError.from(cause).code,
  );

const commands = (kind: AgentPreviewCommand["kind"]["case"]) =>
  gw.worker.previewCommands.filter((command) => command.kind.case === kind);

function start(id = threadId, scope: PreviewScope = { tool: AgentTool.BROWSER }) {
  const abort = new AbortController();
  controllers.add(abort);
  const events: AgentPreviewEvent[] = [];
  let failure = 0;

  const done = (async () => {
    try {
      for await (const event of phone.api.watchAgentPreview(
        { threadId: id, scope, maxFps: 4 },
        { signal: abort.signal, timeoutMs: 8000 },
      ))
        events.push(event);
    } catch (cause) {
      failure = ConnectError.from(cause).code;
    }
  })();

  tasks.add(done);

  return { abort, events, done, failure: () => failure };
}

async function opened(scope: PreviewScope = { tool: AgentTool.BROWSER }) {
  const watch = start(threadId, scope);
  await eventually(
    async () => watch.events.length,
    (length) => length > 0,
  );
  expect(watch.events[0]?.state).toBe("ready");

  return { ...watch, previewId: watch.events[0]!.previewId };
}

async function setupPhone() {
  const invitation = await gw.api.createMobilePairing({});

  const paired = await client().pairing.exchangeMobilePairing({
    code: invitation.code,
    name: "Preview Android",
    platform: "android",
  });

  deviceId = paired.device!.id;
  phone = client(paired.deviceToken);
  const overview = await phone.api.getOverview({});
  const project = overview.projects.find((project) => project.kind === "scratch")!;
  const workspace = project.workspaces.find((workspace) => workspace.workerId === gw.workerId)!;

  threadId = (
    await phone.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      title: "Native preview",
    })
  ).thread!.id;
  expect(
    (
      await eventually(
        () => phone.api.getThread({ threadId }),
        (result) => result.thread?.status === "idle",
      )
    ).thread?.status,
  ).toBe("idle");
}

describe.skipIf(!dockerAvailable)("paired mobile Connect agent preview", () => {
  beforeAll(async () => {
    gw = await startTestGateway({ worker: { hello: { capabilities: ["agent_tools_v1", "agent_preview_v1"] } } });
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));

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
        tools: [AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE].map((tool) => ({
          tool,
          installed: true,
          ready: true,
          screenshot: true,
          version: tool === AgentTool.DEVICE ? "0.21.37" : tool === AgentTool.DESKTOP ? "1.3.1" : "0.43.0",
        })),
      },
    });
    expect(
      (
        await eventually(
          () => gw.api.getOverview({}),
          (overview) => overview.workers.find((worker) => worker.id === gw.workerId)?.agentTools.length === 3,
        )
      ).workers.find((worker) => worker.id === gw.workerId)?.agentTools,
    ).toHaveLength(3);
  }, 60_000);

  beforeEach(async () => {
    for (const tool of [AgentTool.BROWSER, AgentTool.DESKTOP, AgentTool.DEVICE])
      await gw.api.setAgentToolEnabled({ workerId: gw.workerId, tool, enabled: true });
    await setupPhone();
    gw.worker.previewCommands.length = 0;
  });

  afterEach(async () => {
    for (const controller of controllers) controller.abort();
    await Promise.allSettled(tasks);
    controllers.clear();
    tasks.clear();
    expect(
      await eventually(
        async () => gw.core.link.connections.get(gw.workerId)?.previewWatches.size,
        (size) => size === 0,
      ),
    ).toBe(0);
  });

  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
  }, 30_000);

  test.each([
    { label: "browser", scope: { tool: AgentTool.BROWSER } },
    { label: "desktop", scope: { tool: AgentTool.DESKTOP, windowId: "42" } },
    { label: "device", scope: { tool: AgentTool.DEVICE, platform: "android", deviceId: "emulator-5554" } },
  ])("$label streams binary frames, forwards touch/text input and releases its watch on abort", async ({ scope }) => {
    const watch = await opened(scope);
    const command = commands("start")[0]!.kind;
    expect(command.case === "start" && command.value).toMatchObject({
      previewId: watch.previewId,
      threadId,
      scope: { ...scope, session: threadId },
      maxFps: 4,
    });
    gw.worker.link.send({
      case: "agentPreview",
      value: {
        previewId: watch.previewId,
        state: "frame",
        frameId: 1n,
        data: png,
        mimeType: "image/png",
        width: 1,
        height: 1,
      },
    });
    expect(await eventually(async () => watch.events.find((event) => event.state === "frame"), Boolean)).toMatchObject({
      frameId: 1n,
      data: new Uint8Array(png),
      mimeType: "image/png",
      width: 1,
      height: 1,
    });

    const inputs = [
      { kind: "pointer-down", x: 0.25, y: 0.75, buttons: 1 },
      { kind: "pointer-up", x: 0.25, y: 0.75 },
      { kind: "text", text: "Zażółć 🌳\nMobile" },
    ];

    await phone.api.sendAgentPreviewInput({ threadId, previewId: watch.previewId, inputs });
    expect(
      await eventually(
        async () => commands("input").length,
        (length) => length === 1,
      ),
    ).toBe(1);
    const input = commands("input")[0]!.kind;

    expect(input.case === "input" && input.value).toMatchObject({ previewId: watch.previewId, inputs });
    expect(
      await eventually(
        async () => commands("ack").some((command) => command.kind.case === "ack" && command.kind.value.frameId === 1n),
        Boolean,
      ),
    ).toBe(true);
    watch.abort.abort();
    await watch.done;
    expect(watch.failure()).toBe(Code.Canceled);
    expect(
      await eventually(
        async () => commands("stop").length,
        (length) => length === 1,
      ),
    ).toBe(1);
    expect(commands("stop")[0]?.kind.value).toMatchObject({ previewId: watch.previewId });
    expect(gw.core.link.connections.get(gw.workerId)?.previewWatches.size).toBe(0);
    expect(
      await code(
        phone.api.sendAgentPreviewInput({ threadId, previewId: watch.previewId, inputs: [{ kind: "release" }] }),
      ),
    ).toBe(Code.NotFound);
    expect(commands("input")).toHaveLength(1);
  });

  test("native Browser session clears its previous frame when ready switches targets before the next frame", async () => {
    let snapshot = emptyPreview();

    const session = new NativePreviewSession(
      phone.api,
      threadId,
      create(RunAgentToolSchema, { tool: AgentTool.BROWSER }),
      (next) => {
        snapshot = next;
      },
    );

    const done = session.start();
    tasks.add(done);

    try {
      expect(
        await eventually(
          async () => snapshot.state,
          (state) => state === "ready",
        ),
      ).toBe("ready");
      const command = commands("start")[0]!.kind;
      expect(command.case).toBe("start");

      if (command.case !== "start") throw new Error("Missing native preview start");
      const previewId = command.value.previewId;

      gw.worker.link.send({
        case: "agentPreview",
        value: {
          previewId,
          state: "frame",
          frameId: 1n,
          targetId: "tab-a",
          data: png,
          mimeType: "image/png",
          width: 1,
          height: 1,
        },
      });
      expect(
        await eventually(
          async () => snapshot.frame?.frameId,
          (id) => id === 1n,
        ),
      ).toBe(1n);
      expect(snapshot.targetId).toBe("tab-a");
      expect(snapshot.uri).toBe(`data:image/png;base64,${png.toString("base64")}`);
      gw.worker.link.send({
        case: "agentPreview",
        value: { previewId, state: "ready", targetId: "tab-b", title: "Second tab" },
      });
      expect(
        await eventually(
          async () => snapshot.targetId,
          (id) => id === "tab-b",
        ),
      ).toBe("tab-b");
      expect(snapshot.state).toBe("ready");
      expect(snapshot.title).toBe("Second tab");
      expect(snapshot.frame).toBeUndefined();
      expect(snapshot.uri).toBeUndefined();
      gw.worker.link.send({
        case: "agentPreview",
        value: {
          previewId,
          state: "frame",
          frameId: 2n,
          targetId: "tab-b",
          data: png,
          mimeType: "image/png",
          width: 1,
          height: 1,
        },
      });
      expect(
        await eventually(
          async () => snapshot.frame?.frameId,
          (id) => id === 2n,
        ),
      ).toBe(2n);
      expect(snapshot.targetId).toBe("tab-b");
      expect(snapshot.frame?.targetId).toBe("tab-b");
      expect(snapshot.uri).toBe(`data:image/png;base64,${png.toString("base64")}`);
    } finally {
      session.stop();
      await done;
    }

    expect(
      await eventually(
        async () => commands("stop").length,
        (length) => length === 1,
      ),
    ).toBe(1);
  });

  test("owner and thread scoping reject foreign watches and mismatched input before forwarding", async () => {
    const owner = await gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("mobile-preview-other@example.test", "Other owner")),
    );

    const foreignId = crypto.randomUUID();

    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(
          `INSERT INTO threads (id,project_id,owner_user_id,kind,root_thread_id,depth,runtime,provider,worker_id,workspace_id,cwd,title,status)
          SELECT $1::uuid,project_id,$2::uuid,'main',$1::uuid,0,runtime,provider,worker_id,workspace_id,cwd,'Private preview','idle'
          FROM threads WHERE id=$3::uuid`,
          [foreignId, owner, threadId],
        );
      }),
    );
    const foreign = start(foreignId);
    await foreign.done;
    expect(foreign.failure()).toBe(Code.NotFound);
    expect(commands("start")).toHaveLength(0);
    const watch = await opened();
    expect(
      await code(
        phone.api.sendAgentPreviewInput({
          threadId: foreignId,
          previewId: watch.previewId,
          inputs: [{ kind: "release" }],
        }),
      ),
    ).toBe(Code.NotFound);
    expect(
      await code(
        phone.api.sendAgentPreviewInput({ threadId, previewId: crypto.randomUUID(), inputs: [{ kind: "release" }] }),
      ),
    ).toBe(Code.NotFound);
    expect(commands("input")).toHaveLength(0);
    expect(gw.core.link.connections.get(gw.workerId)?.previewWatches.size).toBe(1);
  });

  test("revoking the owner grant closes an idle mobile watch and refuses new watches and input", async () => {
    const watch = await opened();
    await gw.api.setAgentToolEnabled({ workerId: gw.workerId, tool: AgentTool.BROWSER, enabled: false });
    expect(
      await code(
        phone.api.sendAgentPreviewInput({ threadId, previewId: watch.previewId, inputs: [{ kind: "release" }] }),
      ),
    ).toBe(Code.PermissionDenied);
    await watch.done;
    expect(watch.failure()).toBe(Code.PermissionDenied);
    const denied = start();
    await denied.done;
    expect(denied.failure()).toBe(Code.PermissionDenied);
    expect(commands("start")).toHaveLength(1);
    expect(commands("input")).toHaveLength(0);
    expect(
      await eventually(
        async () => commands("stop").length,
        (length) => length === 1,
      ),
    ).toBe(1);
  }, 12_000);

  test("unpairing closes the preview and revokes subsequent native RPCs", async () => {
    const watch = await opened();
    await gw.api.revokeMobileDevice({ id: deviceId });
    await watch.done;
    expect(
      await eventually(
        async () => commands("stop").length,
        (length) => length === 1,
      ),
    ).toBe(1);
    const denied = start();
    await denied.done;
    expect(denied.failure()).toBe(Code.Unauthenticated);
    expect(
      await code(
        phone.api.sendAgentPreviewInput({ threadId, previewId: watch.previewId, inputs: [{ kind: "release" }] }),
      ),
    ).toBe(Code.Unauthenticated);
    expect(commands("start")).toHaveLength(1);
    expect(commands("input")).toHaveLength(0);
  });
});
