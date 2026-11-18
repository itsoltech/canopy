import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { HelloSchema, ItemDeltaField, WorkerMessageSchema, type GatewayMessage } from "@canopy/contracts";
import { AsyncChannel } from "@canopy/transport";
import { WorkerConnection } from "./connection.ts";

test("outbox retries preserve command id across connections; concurrent sends share one acknowledgement", async () => {
  const commandId = Bun.randomUUIDv7();

  const command = {
    case: "steerTurn" as const,
    value: { threadId: "parent", turnId: "turn", inputId: "report", input: { text: "child result" } },
  };

  for (let restart = 0; restart < 2; restart++) {
    const outbound = new AsyncChannel<GatewayMessage>();
    const connection = new WorkerConnection("worker", create(HelloSchema), outbound);

    try {
      const first = connection.sendCommand(command, 1000, commandId);
      const concurrent = connection.sendCommand(command, 1000, commandId);
      expect(concurrent).toBe(first);
      const sent = await outbound[Symbol.asyncIterator]().next();
      expect(sent.value?.payload.case === "command" ? sent.value.payload.value.commandId : undefined).toBe(commandId);
      connection.deliver(
        create(WorkerMessageSchema, { payload: { case: "commandResult", value: { commandId, ok: true } } }),
      );
      expect((await first).ok).toBe(true);
      expect((await concurrent).commandId).toBe(commandId);
      connection.close();
      expect((await outbound[Symbol.asyncIterator]().next()).done).toBe(true);
    } finally {
      connection.close();
    }
  }
});

test("query progress reaches only the pending query on its authenticated worker connection", async () => {
  const first = new WorkerConnection("first", create(HelloSchema), new AsyncChannel<GatewayMessage>());
  const other = new WorkerConnection("other", create(HelloSchema), new AsyncChannel<GatewayMessage>());
  const commandId = Bun.randomUUIDv7();
  const observed: string[] = [];

  const query = first.sendCommand(
    { case: "createWorktree", value: { repoPath: "/fixture" } },
    1000,
    commandId,
    undefined,
    (progress) => observed.push(progress.step),
  );

  const progress = (id: string) =>
    create(WorkerMessageSchema, {
      payload: { case: "queryProgress", value: { commandId: id, step: "create_worktree", status: "running" } },
    });

  try {
    other.deliver(progress(commandId));
    first.deliver(progress(Bun.randomUUIDv7()));
    expect(observed).toEqual([]);
    first.deliver(progress(commandId));
    expect(observed).toEqual(["create_worktree"]);
    first.deliver(create(WorkerMessageSchema, { payload: { case: "commandResult", value: { commandId, ok: true } } }));
    await query;
    first.deliver(progress(commandId));
    expect(observed).toEqual(["create_worktree"]);
  } finally {
    first.close();
    other.close();
  }
});

test("text batches respect inline control frames, raw payload size and journal gaps", async () => {
  const connection = new WorkerConnection("worker", create(HelloSchema), new AsyncChannel<GatewayMessage>());

  const send = (seq: bigint, bytes = 0) =>
    connection.deliver(
      create(WorkerMessageSchema, {
        payload: {
          case: "threadEvent",
          value: {
            threadId: "thread",
            journalSeq: seq,
            rawJson: "x".repeat(bytes),
            body: {
              case: "itemDelta",
              value: { field: ItemDeltaField.TEXT, chunk: "a" },
            },
          },
        },
      }),
    );

  const next = async () => {
    const { value } = await connection.messages[Symbol.asyncIterator]().next();

    if (value?.payload.case !== "threadEvent") throw new Error("expected text delta");

    return connection.eventBatch(value.payload.value).map((event) => event.journalSeq);
  };

  try {
    send(1n);
    expect(await next()).toEqual([1n]);
    send(2n);
    send(3n);
    connection.deliver(create(WorkerMessageSchema, { payload: { case: "queryProgress", value: {} } }));
    send(4n);
    send(5n, 150 * 1024);
    send(6n, 150 * 1024);
    send(8n);
    expect(await next()).toEqual([2n, 3n]);
    expect(await next()).toEqual([4n]);
    expect(await next()).toEqual([5n]);
    expect(await next()).toEqual([6n]);
    expect(await next()).toEqual([8n]);
  } finally {
    connection.close();
  }
});
