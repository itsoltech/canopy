import { expect, test } from "bun:test";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { AgentToolCallSchema, AgentToolResultSchema, WelcomeSchema, type AgentToolCall } from "@canopy/contracts";
import { tempDir } from "@canopy/testing";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ManagedRuntime } from "effect";
import type { GatewayLink } from "../gateway-link/index.ts";
import { Journal } from "../journal/index.ts";
import { claudeBusServer } from "../providers/claude/bus.ts";
import { HostContext } from "./host-context.ts";
import { HostState } from "./host-state.ts";

function fixture() {
  const dataDir = tempDir("canopy-image-link-");
  const runtime = ManagedRuntime.make(Journal.layer(join(dataDir, "journal.db")));
  const state = new HostState({ runtime, dataDir, clientVersion: "test" });
  const host = new HostContext(state, { applyConfig: async () => ({}), sendPreviews: () => {} });

  return { state, ops: host.ops, close: () => runtime.dispose() };
}

function mockLink(send: GatewayLink["send"]): GatewayLink {
  return {
    welcome: create(WelcomeSchema),
    messages: { async *[Symbol.asyncIterator]() {} },
    closed: Promise.resolve({}),
    close: () => {},
    send,
  };
}

test("Claude receives a show_images error on link loss and the call is removed from replay", async () => {
  const { state, ops, close } = fixture();
  const sent = Promise.withResolvers<string>();

  const link = mockLink((payload) => {
    if (payload.case === "agentToolCall" && payload.value.toolName === "show_images" && payload.value.callId)
      sent.resolve(payload.value.callId);
  });

  state.link = link;
  const source = { threadId: crypto.randomUUID(), turnId: crypto.randomUUID() };
  const wait = create(AgentToolCallSchema, { ...source, callId: crypto.randomUUID(), toolName: "wait_threads" });
  const waiting = ops.callTool(wait);

  const server = claudeBusServer({
    ...source,
    depth: 0,
    agentBus: true,
    turnId: () => source.turnId,
    toolUseId: () => "image-tool-use",
    callTool: ops.callTool,
  });

  const client = new Client({ name: "image-link-fixture", version: "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  try {
    await server.instance.connect(serverSide);
    await client.connect(clientSide);

    const pending = client.callTool(
      { name: "show_images", arguments: { images: [{ path: "preview.png", alt: "Example preview" }] } },
      undefined,
      { timeout: 2_000 },
    );

    const [callId, result] = await Promise.all([
      sent.promise.then((callId) => {
        expect(state.toolCalls.has(callId)).toBe(true);
        ops.detachGateway(link);

        return callId;
      }),
      pending,
    ]);

    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining("could not confirm that the images were published") }],
    });
    expect([...state.toolCalls.keys()]).toEqual([wait.callId]);
    ops.toolResult(create(AgentToolResultSchema, { callId, content: '{"delivered":true}' }));
    const reply = create(AgentToolResultSchema, { callId: wait.callId, content: '{"threads":[]}' });

    ops.toolResult(reply);
    expect(await waiting).toEqual(reply);
  } finally {
    await client.close();
    await server.instance.close();
    await close();
  }
});

test("show_images settles if already offline or if the link closes before the call can be sent", async () => {
  const { state, ops, close } = fixture();

  const image = (): AgentToolCall =>
    create(AgentToolCallSchema, {
      callId: crypto.randomUUID(),
      threadId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      toolName: "show_images",
    });

  try {
    const signal = AbortSignal.timeout(1_000);

    expect(await ops.callTool(image(), signal)).toMatchObject({
      isError: true,
      content: expect.stringContaining("gateway is offline"),
    });
    state.link = mockLink(() => {
      throw new Error("gateway link is closed");
    });
    expect(await ops.callTool(image(), signal)).toMatchObject({
      isError: true,
      content: expect.stringContaining("Lost the connection to the gateway"),
    });
    expect(state.toolCalls.size).toBe(0);
  } finally {
    await close();
  }
});

test("local automation grants, cancellations and finishes belong to their original gateway link", async () => {
  const { state, ops, close } = fixture();
  const sent: string[] = [];
  const replacement: string[] = [];

  const link = mockLink((payload) => {
    if (payload.case === "localAutomationFinished") sent.push(`finished:${payload.value.callId}`);

    if (payload.case === "agentToolCall")
      sent.push(`${payload.value.cancelled ? "cancel" : "grant"}:${payload.value.callId}`);
  });

  const call = () =>
    create(AgentToolCallSchema, {
      callId: crypto.randomUUID(),
      threadId: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      toolName: "authorize_local_automation",
    });

  const pending = call();
  const admitted = call();
  const cancelled = call();
  const abort = new AbortController();
  let finish: (() => void) | undefined;

  try {
    expect((await ops.callTool(call())).isError).toBe(true);
    state.link = link;

    const grant = ops.callTool(admitted, undefined, (complete) => {
      finish = complete;
    });

    ops.toolResult(create(AgentToolResultSchema, { callId: admitted.callId, content: "allowed" }));
    expect((await grant).isError).toBe(false);
    expect(finish).toBeDefined();
    finish?.();
    const waiting = ops.callTool(pending);
    const interrupted = ops.callTool(cancelled, abort.signal);
    abort.abort();
    expect((await interrupted).isError).toBe(true);
    ops.detachGateway(link);
    state.link = mockLink((payload) => {
      replacement.push(payload.case);
    });
    expect((await waiting).isError).toBe(true);
    finish?.();
    expect(sent).toEqual([
      `grant:${admitted.callId}`,
      `finished:${admitted.callId}`,
      `grant:${pending.callId}`,
      `grant:${cancelled.callId}`,
      `cancel:${cancelled.callId}`,
    ]);
    expect(replacement).toEqual([]);
    expect(state.toolCalls.size).toBe(0);
  } finally {
    await close();
  }
});
