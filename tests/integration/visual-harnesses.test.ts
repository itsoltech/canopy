import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  AgentToolCallSchema,
  InteractionResponseSchema,
  Provider,
  ThreadSpecSchema,
  UserInputSchema,
  WelcomeSchema,
  type AgentToolCall,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { agentBusToolsFor, type JsonObject } from "@canopy/domain";
import { THREAD_VISUALS_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { Journal } from "../../apps/worker/src/journal/index.ts";
import { claudeBusServer } from "../../apps/worker/src/providers/claude/bus.ts";
import { codexAgentBusTools } from "../../apps/worker/src/providers/codex/dynamic-tools.ts";
import { CodexThreads } from "../../apps/worker/src/providers/codex/threads.ts";
import { platformMcp } from "../../apps/worker/src/providers/mcp-bus.ts";
import { gatewayToolRefusal } from "../../apps/worker/src/runtime/tool-gates.ts";
import { resolveProfiles } from "../../apps/worker/src/providers/profiles.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const temp = tempDirs();

const args: JsonObject = {
  title: "Deploy flow",
  description: "Step through the deploy pipeline.",
  spec: {
    schema_version: 1,
    state: { step: 0 },
    root: {
      type: "stack",
      children: [
        { type: "stepper", state_key: "step", steps: [{ title: "Build" }, { title: "Release" }] },
        {
          type: "flow",
          highlight_from: "step",
          nodes: [
            { id: "build", label: "Build" },
            { id: "release", label: "Release" },
          ],
          edges: [{ from: "build", to: "release" }],
        },
      ],
    },
  },
};

describe.skipIf(!dockerAvailable)("render_visual through each harness adapter, gRPC and PostgreSQL", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  const visuals = (threadId: string) =>
    gw.runtime.runPromise(
      SqlClient.SqlClient.use((sql) =>
        sql.unsafe<{ version: number; title: string }>(
          "SELECT version, title FROM thread_visuals WHERE thread_id = $1::uuid",
          [threadId],
        ),
      ),
    );

  const forward = (calls: AgentToolCall[]) => async (call: AgentToolCall) => {
    calls.push(call);

    return gw.worker.callTool({
      threadId: call.threadId,
      turnId: call.turnId,
      callId: call.callId,
      tool: call.toolName,
      args: JSON.parse(call.argumentsJson),
    });
  };

  beforeAll(async () => {
    gw = await startTestGateway({ worker: { hello: { capabilities: [THREAD_VISUALS_CAPABILITY] } } });
    projectId = (await gw.api.createProject({ name: "Visual harnesses" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/harness" }))
      .workspace!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  // The gateway thread only anchors the call; the adapter under test is driven directly.
  async function running() {
    gw.worker.holdTurns = true;

    const thread = (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX, title: "Visual" }))
      .thread!;

    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );

    const turn = (
      await gw.api.sendMessage({ threadId: thread.id, text: "Show it", clientRequestId: crypto.randomUUID() })
    ).turn!;

    await eventually(
      () => gw.runtime.runPromise(GatewayStore.use((s) => s.turnsOf(thread.id))),
      (rows) => rows.some((row) => row.id === turn.id && row.status === "running"),
    );

    return { threadId: thread.id, turnId: turn.id };
  }

  test("is offered at both levels with an object schema", () => {
    expect(agentBusToolsFor(0)).toContain("render_visual");
    expect(agentBusToolsFor(1)).toContain("render_visual");
    const codex = codexAgentBusTools(1).find((tool) => tool.type === "function" && tool.name === "render_visual");
    expect(codex?.type === "function" && codex.inputSchema).toMatchObject({
      type: "object",
      required: ["title", "description", "spec"],
    });
  });

  test("Codex app-server: a dynamic tool call publishes the visual", async () => {
    const source = await running();
    const calls: AgentToolCall[] = [];
    const root = temp("canopy-visual-codex-");
    const profile = resolveProfiles([{ kind: "native", id: "native", providers: ["codex"] }])[0]!.resolved!;

    const runtime = ManagedRuntime.make(
      CodexThreads.layer({
        launch: {
          command: [process.execPath, join(import.meta.dir, "support/bus-app-server.ts"), "render_visual"],
          env: { PATH: process.env["PATH"] },
        },
        clientVersion: "test",
        profile: () => profile,
        publish: () => {},
        interact: async () => create(InteractionResponseSchema, { allow: false }),
        callTool: forward(calls),
      }).pipe(Layer.provide(Journal.layer(join(root, "journal.db")))),
    );

    try {
      await runtime.runPromise(
        CodexThreads.use((threads) =>
          Effect.gen(function* () {
            const spec = create(ThreadSpecSchema, {
              threadId: source.threadId,
              provider: Provider.CODEX,
              providerProfileId: "native",
              cwd: root,
              enableAgentBus: true,
            });

            yield* threads.create(spec);
            yield* threads.startTurn(spec, source.turnId, create(UserInputSchema, { text: JSON.stringify(args) }));

            while (threads.hasActiveTurns()) yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("10 seconds")),
        ),
      );
    } finally {
      await runtime.dispose();
    }

    expect(calls.map((call) => call.toolName)).toEqual(["render_visual"]);
    expect(await visuals(source.threadId)).toEqual([{ version: 1, title: "Deploy flow" }]);
  });

  test("Claude Agent SDK: the in-process MCP server publishes the visual", async () => {
    const source = await running();
    const calls: AgentToolCall[] = [];

    const server = claudeBusServer({
      threadId: source.threadId,
      depth: 0,
      agentBus: true,
      turnId: () => source.turnId,
      toolUseId: () => "visual-call",
      callTool: forward(calls),
    });

    const client = new Client({ name: "visual-harness", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("render_visual");
      const result = await client.callTool({ name: "render_visual", arguments: args });
      expect(result.isError).not.toBe(true);
      expect(JSON.stringify(result.content)).toContain("delivered");
    } finally {
      await client.close();
      await server.instance.close();
    }

    expect(await visuals(source.threadId)).toEqual([{ version: 1, title: "Deploy flow" }]);
  });

  test("Grok ACP: the local HTTP MCP publishes the visual and reports spec errors", async () => {
    const source = await running();
    const calls: AgentToolCall[] = [];

    const mcp = platformMcp({
      threadId: source.threadId,
      depth: 1,
      turnId: () => source.turnId,
      callTool: forward(calls),
    });

    const rpc = async (id: number, method: string, params: JsonObject) => {
      const response = await fetch(mcp.server.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: mcp.server.headers[0]!.value },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });

      return JSON.stringify(await response.json());
    };

    try {
      expect(await rpc(1, "tools/list", {})).toContain('"render_visual"');
      expect(await rpc(2, "tools/call", { name: "render_visual", arguments: args })).toContain("delivered");

      const invalid = await rpc(3, "tools/call", {
        name: "render_visual",
        arguments: { ...args, spec: { schema_version: 1, root: { type: "html", html: "<b>" } } },
      });

      expect(invalid).toContain("isError");
    } finally {
      mcp.close();
    }

    expect(await visuals(source.threadId)).toEqual([{ version: 1, title: "Deploy flow" }]);
  });

  test("an older gateway gets no render_visual call; the model hears to update it", () => {
    const call = create(AgentToolCallSchema, {
      callId: Bun.randomUUIDv7(),
      threadId: Bun.randomUUIDv7(),
      toolName: "render_visual",
      argumentsJson: JSON.stringify(args),
    });

    expect(gatewayToolRefusal(call, create(WelcomeSchema, {}))).toMatchObject({
      isError: true,
      content: "Update Canopy on the gateway computer to show visuals.",
    });
    expect(gatewayToolRefusal(call, create(WelcomeSchema, { threadVisualsV1: true }))).toBeUndefined();
    expect(gatewayToolRefusal({ ...call, toolName: "ask_user" }, create(WelcomeSchema, {}))).toBeUndefined();
  });
});
