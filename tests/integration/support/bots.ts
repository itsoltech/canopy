/**
 * Shared setup of the bots integration files: a test gateway with a bot model the tests swap, a provider instance,
 * a project with a workspace and a remote MCP fixture whose write tool counts calls (and can hang until aborted).
 */
import { afterAll, beforeAll } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { bots, Provider, ProviderProfileKind } from "@canopy/contracts";
import { GatewayCore } from "@canopy/gateway/core";
import { startGrpcServer } from "@canopy/transport";
import { openGatewayLink } from "@canopy/worker/gateway-link";
import type { BotModel, ModelInput, ModelReply } from "../../../apps/gateway/src/bots/types.ts";
import { eventually, ScriptedWorker, startTestGateway, type TestGateway } from "./gateway.ts";

export const reply = (text: string): ModelReply => ({ text, calls: [] });

export const tool = (name: string, args: JsonObject = {}): ModelReply => ({
  text: "",
  calls: [{ id: "model-call", name, arguments: args }],
});

export const lastInput = (input: ModelInput) => input.messages.findLast((m) => m.role === "user")?.text ?? "";

/** State a bots test file shares with its hooks; the gateway fields are set in beforeAll, `current` again on restart. */
export class BotsState {
  gw!: TestGateway;
  current!: GatewayCore;
  currentWorker!: ScriptedWorker;
  model: BotModel = async (i) => reply(`Reply: ${lastInput(i)}`);
  /** tools/call requests the MCP fixture received. */
  writes = 0;
  /** Makes the MCP fixture hold tools/call until the request is aborted. */
  holdMcp = false;
  serverId = "";
  workspaceId = "";
  projectId = "";
}

/** Registers beforeAll/afterAll for the enclosing describe and returns the state plus bot helpers. */
export function botsSuite() {
  const suite = new BotsState();
  let fixture: ReturnType<typeof Bun.serve> | undefined;
  let closeRestartedLink = async () => {};

  const configuration = (name: string, extra: MessageInitShape<typeof bots.BotConfigurationSchema> = {}) =>
    create(bots.BotConfigurationSchema, {
      name,
      shape: "round",
      color: "#22aaff",
      provider: Provider.CODEX,
      providerInstance: "bots-test",
      model: "gpt-6.1-sol",
      ...extra,
    });

  const add = async (name: string, extra: MessageInitShape<typeof bots.BotConfigurationSchema> = {}) =>
    (await suite.gw.api.createBot({ configuration: configuration(name, extra), clientRequestId: Bun.randomUUIDv7() }))
      .bot!;

  const read = (id: string) => suite.current.bots.run((s) => s.conversation(suite.gw.userId, id));

  const settled = (id: string) =>
    eventually(
      () => read(id),
      (s) => !s.working,
      10_000,
    );

  const send = (id: string, text: string) =>
    suite.current.bots.send(
      create(bots.SendBotMessageRequestSchema, { botId: id, text, clientRequestId: Bun.randomUUIDv7() }),
    );

  const restart = async () => {
    await suite.current.bots.stop();
    await closeRestartedLink();
    suite.gw.worker.link.close();
    suite.current = new GatewayCore({
      runtime: suite.gw.runtime,
      userId: suite.gw.userId,
      instanceId: Bun.randomUUIDv7(),
      botModel: (i) => suite.model(i),
    });
    const core = suite.current;
    const grpc = await startGrpcServer({ routes: (router) => core.link.routes(router) });

    const link = await openGatewayLink({
      baseUrl: grpc.url,
      credential: suite.gw.workerCredential,
      hello: {
        workerId: suite.gw.workerId,
        journalId: "bots-restarted",
        scratchRoot: "/worker-data/scratch",
        homeDirectory: "/home/test",
      },
    });

    suite.currentWorker = new ScriptedWorker(link);
    closeRestartedLink = async () => {
      link.close();
      await core.link.shutdown();
      await grpc.close();
    };

    suite.current.bots.start();
  };

  beforeAll(async () => {
    suite.gw = await startTestGateway({ botModel: (input) => suite.model(input) });
    suite.current = suite.gw.core;
    suite.currentWorker = suite.gw.worker;
    suite.current.bots.start();
    await suite.gw.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "bots-test",
      label: "Bots test",
      create: true,
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture",
      allWorkers: true,
    });
    const project = (await suite.gw.api.createProject({ name: "Bot project" })).project!;
    suite.projectId = project.id;
    suite.workspaceId = (
      await suite.gw.api.createWorkspace({ projectId: suite.projectId, workerId: suite.gw.workerId, rootPath: "/repo" })
    ).workspace!.id;
    fixture = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.method !== "POST") return new Response(null, { status: 405 });
        const body = (await request.json()) as { id?: number; method: string };

        if (body.method.startsWith("notifications/")) return new Response(null, { status: 202 });
        let result: JsonValue = {};

        if (body.method === "initialize")
          result = {
            protocolVersion: "2025-03-26",
            serverInfo: { name: "fixture", version: "1" },
            capabilities: { tools: {} },
          };

        if (body.method === "tools/list")
          result = {
            tools: [
              {
                name: "send_external_message",
                description: "Send externally",
                inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                annotations: { readOnlyHint: false },
              },
              {
                name: "update_external_view",
                description: "Update another view",
                inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
                annotations: { readOnlyHint: false },
              },
            ],
          };

        if (body.method === "tools/call") {
          suite.writes++;

          if (suite.holdMcp)
            await new Promise<void>((resolve) =>
              request.signal.addEventListener("abort", () => resolve(), { once: true }),
            );
          result = { content: [{ type: "text", text: "Sent once" }] };
        }

        return Response.json({ jsonrpc: "2.0", id: body.id, result });
      },
    });
    suite.serverId = (
      await suite.gw.api.saveBotMcpServer({
        name: "Notion",
        url: `${fixture.url}mcp`,
        transport: "http",
        enabled: true,
        headers: { authorization: "Bearer fixture-secret" },
      })
    ).server!.id;
  }, 30_000);
  afterAll(async () => {
    await suite.current?.bots.stop();
    await closeRestartedLink();
    await fixture?.stop(true);
    await suite.gw?.close();
  });

  return { suite, configuration, add, read, settled, send, restart };
}
