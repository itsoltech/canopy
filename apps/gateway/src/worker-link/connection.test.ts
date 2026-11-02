import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { HelloSchema, WorkerMessageSchema, type GatewayMessage } from "@open-agents/contracts";
import { AsyncChannel } from "@open-agents/transport";
import { WorkerConnection } from "./connection.ts";

test("outbox retries preserve command id across connections; concurrent sends share one acknowledgement", async () => {
  const commandId = Bun.randomUUIDv7();
  const command = { case: "steerTurn" as const, value: { threadId: "parent", turnId: "turn", inputId: "report", input: { text: "child result" } } };
  for (let restart = 0; restart < 2; restart++) {
    const outbound = new AsyncChannel<GatewayMessage>();
    const connection = new WorkerConnection("worker", create(HelloSchema), outbound);
    try {
      const first = connection.sendCommand(command, 1000, commandId);
      const concurrent = connection.sendCommand(command, 1000, commandId);
      expect(concurrent).toBe(first);
      const sent = await outbound[Symbol.asyncIterator]().next();
      expect(sent.value?.payload.case === "command" ? sent.value.payload.value.commandId : undefined).toBe(commandId);
      connection.deliver(create(WorkerMessageSchema, { payload: { case: "commandResult", value: { commandId, ok: true } } }));
      expect((await first).ok).toBe(true);
      expect((await concurrent).commandId).toBe(commandId);
      connection.close();
      expect((await outbound[Symbol.asyncIterator]().next()).done).toBe(true);
    } finally { connection.close(); }
  }
});
