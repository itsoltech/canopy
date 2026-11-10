import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { create, fromJson, toJson } from "@bufbuild/protobuf";
import {
  InteractionResponseSchema,
  Provider,
  ThreadEventSchema,
  ThreadSpecSchema,
  UserInputSchema,
  ui,
  type AgentToolCall,
  type ThreadEvent,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDirs } from "@canopy/testing";
import { coalesceDeltas } from "@canopy/domain/coalesce";
import type { JsonObject } from "@canopy/domain";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { Journal } from "../../apps/worker/src/journal/index.ts";
import { claudeBusServer } from "../../apps/worker/src/providers/claude/bus.ts";
import { ClaudeEventMapper } from "../../apps/worker/src/providers/claude/mapping.ts";
import { CodexThreads } from "../../apps/worker/src/providers/codex/threads.ts";
import { resolveProfiles } from "../../apps/worker/src/providers/profiles.ts";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";
import { busText as prompt, textChunks } from "./support/bus-text.ts";

const temp = tempDirs();

/** SDK event fields consumed here; usage, signatures and inference metadata are immaterial to this transcript. */
interface StreamFixtureEvent {
  type: string;
  index?: number;
  message?: { id: string };
  content_block?: { type: string; id?: string; name?: string; input?: JsonObject; text?: string };
  delta?: { type: string; text?: string; partial_json?: string };
}

describe.skipIf(!dockerAvailable)("agent bus whitespace through harnesses, PostgreSQL and gRPC", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  const query = <A extends object>(statement: string, id: string) =>
    gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(statement, [id])));

  const snapshot = async (threadId: string) => {
    const updates = await watchUntil(gw.api, threadId, (rows) => rows.some((r) => r.change.case === "snapshot"));
    const first = updates.find((r) => r.change.case === "snapshot")!.change;

    if (first.case !== "snapshot") throw new Error("Expected thread snapshot");

    // The web BFF also serializes the protobuf to JSON; mobile receives the binary response directly.
    return fromJson(ui.ThreadSnapshotSchema, JSON.parse(JSON.stringify(toJson(ui.ThreadSnapshotSchema, first.value))));
  };

  const start = async () => {
    const parent = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title: "Parent",
        initialMessage: "delegate",
      })
    ).thread!;

    const [turn] = await eventually(
      () => query<{ id: string; status: string }>("SELECT id, status FROM turns WHERE thread_id = $1::uuid", parent.id),
      (rows) => rows[0]?.status === "running",
    );

    const spawned = await gw.worker.callTool({
      threadId: parent.id,
      turnId: turn!.id,
      tool: "spawn_thread",
      args: { title: "Child", prompt: "work", notify: false },
    });

    expect(spawned.isError).toBe(false);
    const child: { thread_id: string; turn_id: string } = JSON.parse(spawned.resultJson);
    await eventually(
      () => query<{ status: string }>("SELECT status FROM turns WHERE thread_id = $1::uuid", child.thread_id),
      (rows) => rows[0]?.status === "running",
    );

    return { parentId: parent.id, parentTurn: turn!.id, childId: child.thread_id, childTurn: child.turn_id };
  };

  type Pair = Awaited<ReturnType<typeof start>>;

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

  const publish = (event: ThreadEvent) => {
    if (event.body.case === "itemStarted" || event.body.case === "itemDelta" || event.body.case === "itemCompleted")
      gw.worker.emit(event.threadId, event.turnId, event.body, event.rawJson);
  };

  async function codex(pair: Pair, delivery: string, calls: AgentToolCall[]) {
    const root = temp("canopy-bus-whitespace-codex-");
    const profile = resolveProfiles([{ kind: "native", id: "native", providers: ["codex"] }])[0]!.resolved!;

    const runtime = ManagedRuntime.make(
      CodexThreads.layer({
        launch: {
          command: [process.execPath, join(import.meta.dir, "support/bus-app-server.ts")],
          env: { PATH: process.env["PATH"] },
        },
        clientVersion: "test",
        profile: () => profile,
        publish,
        interact: async () => create(InteractionResponseSchema, { allow: false }),
        callTool: forward(calls),
      }).pipe(Layer.provide(Journal.layer(join(root, "journal.db")))),
    );

    try {
      await runtime.runPromise(
        CodexThreads.use((threads) =>
          Effect.gen(function* () {
            const spec = create(ThreadSpecSchema, {
              threadId: pair.childId,
              provider: Provider.CODEX,
              providerProfileId: "native",
              cwd: root,
              depth: 1,
              enableAgentBus: true,
            });

            yield* threads.create(spec);
            yield* threads.startTurn(
              spec,
              pair.childTurn,
              create(UserInputSchema, {
                text: JSON.stringify({ thread_id: pair.parentId, prompt, delivery, notify: false }),
              }),
            );

            while (threads.hasActiveTurns()) yield* Effect.sleep("5 millis");
          }).pipe(Effect.timeout("10 seconds")),
        ),
      );
    } finally {
      await runtime.dispose();
    }
  }

  async function claude(pair: Pair, delivery: string, calls: AgentToolCall[]) {
    const mapper = new ClaudeEventMapper(pair.childTurn);

    const map = (message: Parameters<ClaudeEventMapper["map"]>[0]) => {
      for (const event of mapper.map(message))
        publish(
          create(ThreadEventSchema, {
            threadId: pair.childId,
            turnId: event.turnId ?? "",
            rawJson: event.rawJson ?? "",
            ...(event.body && { body: event.body }),
          }),
        );
    };

    const args = { thread_id: pair.parentId, prompt, delivery, notify: false };

    // SAFETY: Synthetic stream envelopes omit metadata the mapper does not read, retaining SDK event shapes.
    const stream = (event: StreamFixtureEvent) =>
      map({
        type: "stream_event",
        uuid: Bun.randomUUIDv7(),
        session_id: "fixture",
        parent_tool_use_id: null,
        event,
      } as Parameters<ClaudeEventMapper["map"]>[0]);

    stream({ type: "message_start", message: { id: "tool-message" } });
    stream({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "bus-call",
        name: "mcp__canopy__send_message",
        input: {},
      },
    });

    for (const partial_json of JSON.stringify(args))
      stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json } });
    stream({ type: "content_block_stop", index: 0 });

    // Canopy does not assemble partial JSON: the SDK provides this complete object to MCP and tool_use.
    const server = claudeBusServer({
      threadId: pair.childId,
      depth: 1,
      agentBus: true,
      turnId: () => pair.childTurn,
      toolUseId: () => "bus-call",
      callTool: forward(calls),
    });

    const client = new Client({ name: "bus-whitespace", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
      await server.instance.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: "send_message", arguments: args });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.instance.close();
    }

    // SAFETY: Synthetic SDK envelopes omit only metadata the mapper does not read; content uses SDK tool_use shapes.
    map({
      type: "assistant",
      uuid: Bun.randomUUIDv7(),
      session_id: "fixture",
      parent_tool_use_id: null,
      message: {
        id: "tool-message",
        role: "assistant",
        model: "fixture",
        content: [{ type: "tool_use", id: "bus-call", name: "mcp__canopy__send_message", input: args }],
        stop_reason: "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null },
      },
    } as Parameters<ClaudeEventMapper["map"]>[0]);
    stream({ type: "message_start", message: { id: "streamed-message" } });
    stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });

    for (const text of textChunks)
      stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  }

  async function follow(threadId: string) {
    const abort = new AbortController();
    let state: ui.ThreadSnapshot | undefined;

    const reading = (async () => {
      try {
        const source = gw.api.watchThread({ threadId, incremental: true }, { signal: abort.signal });

        for await (const update of coalesceDeltas(source)) {
          const json = JSON.parse(JSON.stringify(toJson(ui.ThreadUpdateSchema, update)));
          state = applyThreadUpdate(state, fromJson(ui.ThreadUpdateSchema, json));
        }
      } catch (error) {
        if (!abort.signal.aborted) throw error;
      }
    })();

    await eventually(async () => Boolean(state), Boolean);

    return {
      async verify() {
        await eventually(
          async () =>
            state?.items.some((i) => i.item?.content.case === "agentMessage" && i.item.content.value.text === prompt),
          Boolean,
        );
        expect(
          state?.items.some(
            (i) =>
              i.item?.content.case === "agentMessage" &&
              Buffer.from(i.item.content.value.text).equals(Buffer.from(prompt)),
          ),
        ).toBe(true);
      },
      async close() {
        abort.abort();
        await reading;
      },
    };
  }

  beforeAll(async () => {
    gw = await startTestGateway();
    gw.worker.holdTurns = true;
    projectId = (await gw.api.createProject({ name: "Bus whitespace" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/bus-whitespace" }))
      .workspace!.id;
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers[0]?.appliedVersion === 2n,
    );
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  for (const adapter of [codex, claude])
    for (const delivery of ["queue", "steer"]) {
      test(`${adapter.name} preserves a child's ${delivery} message and whitespace-only text deltas`, async () => {
        const pair = await start();
        const calls: AgentToolCall[] = [];
        const live = await follow(pair.childId);

        try {
          await adapter(pair, delivery, calls);
          await live.verify();
        } finally {
          await live.close();
        }

        expect(calls).toHaveLength(1);
        expect(JSON.parse(calls[0]!.argumentsJson).prompt).toBe(prompt);
        const callId = calls[0]!.callId;

        const [stored] = await query<{ arguments: { prompt: string }; hops: number }>(
          "SELECT arguments, hops FROM agent_bus_calls WHERE id = $1::uuid",
          callId,
        );

        expect(Buffer.from(stored!.arguments.prompt)).toEqual(Buffer.from(prompt));
        expect(stored!.hops).toBe(2); // Parent → child task, then child → parent message.

        const [input] = await query<{ input: { message: string; text: string; note: string }; id: string }>(
          delivery === "steer"
            ? "SELECT id, input FROM turn_steers WHERE agent_call_id = $1::uuid"
            : "SELECT id, input FROM turns WHERE agent_call_id = $1::uuid",
          callId,
        );

        expect(Buffer.from(input!.input.message)).toEqual(Buffer.from(prompt));

        if (delivery === "queue") gw.worker.finish(pair.parentId, pair.parentTurn);
        await eventually(async () => gw.worker.started.has(input!.id), Boolean);
        expect(gw.worker.started.get(input!.id)?.text).toBe(`${input!.input.note}\n\n${prompt}`);
        const view = await snapshot(pair.parentId);

        const displayed =
          delivery === "queue"
            ? view.turns.find((t) => t.id === input!.id)?.messageText
            : view.steers.find((s) => s.id === input!.id)?.text;

        expect(Buffer.from(displayed ?? "")).toEqual(Buffer.from(prompt));

        const source = await eventually(
          () => snapshot(pair.childId),
          (s) => s.items.some((i) => i.item?.content.case === "agentMessage" && i.item.content.value.text === prompt),
        );

        expect(
          source.items.some((i) => i.item?.content.case === "agentMessage" && i.item.content.value.text === prompt),
        ).toBe(true);
        expect(
          source.items.some(
            (i) =>
              i.item?.content.case === "agentBusCall" &&
              JSON.parse(i.item.content.value.argumentsJson).prompt === prompt,
          ),
        ).toBe(true);

        if (adapter === codex)
          expect(
            source.items.some(
              (i) =>
                i.item?.content.case === "toolCall" && JSON.parse(i.item.content.value.inputJson).prompt === prompt,
            ),
          ).toBe(true);
        gw.worker.finish(pair.childId, pair.childTurn);
        gw.worker.finish(pair.parentId, delivery === "queue" ? input!.id : pair.parentTurn);
      }, 30_000);
    }
});
