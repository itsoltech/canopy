import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { CommandSchema } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore } from "@canopy/gateway/store";
import { coreRedeliver } from "../../apps/gateway/src/core/core-commands.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("bounded durable command redelivery", () => {
  let gateway: TestGateway;
  beforeAll(async () => {
    gateway = await startTestGateway();
  }, 60000);
  afterAll(async () => {
    await gateway?.close();
  });

  test("keyset pages retain equal-timestamp order after the cursor command completes", async () => {
    const saved = await seedCommands(4097);

    const first = await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.pendingCommands(gateway.workerId)),
    );

    expect(first).toHaveLength(2048);
    await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.commandDone(first.at(-1)!.command.commandId, true, {})),
    );

    const second = await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.pendingCommands(gateway.workerId, first.at(-1)!.command.commandId)),
    );

    const third = await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.pendingCommands(gateway.workerId, second.at(-1)!.command.commandId)),
    );

    expect([...first, ...second, ...third].map((pending) => pending.command.commandId)).toEqual(saved.toSorted());
    await gateway.core.linkedAgents.query(
      "UPDATE worker_commands SET status='completed',completed_at=now() WHERE id=ANY($1::uuid[])",
      [saved],
    );
  });

  test("a single oversized payload progresses without decoding the rest of the queue", async () => {
    const saved: string[] = [];

    for (let i = 0; i < 3; i++) {
      const command = await gateway.runtime.runPromise(
        GatewayStore.use((store) =>
          store.enqueueCommand({
            workerId: gateway.workerId,
            ttlSeconds: 3600,
            command: {
              kind: {
                case: "steerTurn",
                value: {
                  threadId: Bun.randomUUIDv7(),
                  turnId: Bun.randomUUIDv7(),
                  input: { text: "x".repeat(600000) },
                },
              },
            },
          }),
        ),
      );

      saved.push(command.commandId);
    }

    const first = await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.pendingCommands(gateway.workerId)),
    );

    expect(first.map((pending) => pending.command.commandId)).toEqual(saved.slice(0, 1));

    const next = await gateway.runtime.runPromise(
      GatewayStore.use((store) => store.pendingCommands(gateway.workerId, saved[0])),
    );

    expect(next.map((pending) => pending.command.commandId)).toEqual(saved.slice(1, 2));
    expect(
      await gateway.runtime.runPromise(GatewayStore.use((store) => store.pendingCommands(Bun.randomUUIDv7()))),
    ).toEqual([]);
    await gateway.core.linkedAgents.query(
      "UPDATE worker_commands SET status='completed',completed_at=now() WHERE id=ANY($1::uuid[])",
      [saved],
    );
  });

  test("reconnect delivery caps in-flight commands and drains all later pages", async () => {
    const replies: (() => void)[] = [];
    let holding = true;
    gateway.worker.handlers.set("unloadThread", (_, reply) => {
      if (holding) replies.push(() => reply(true));
      else reply(true);
    });
    const saved = await seedCommands(2050);

    try {
      await coreRedeliver(gateway.core, gateway.workerId);
      await until(async () => replies.length === 64);
      expect(replies).toHaveLength(64);
      holding = false;

      for (const reply of replies) reply();
      await until(async () => {
        const rows = await gateway.core.linkedAgents.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM worker_commands WHERE id=ANY($1::uuid[]) AND status='completed'",
          [saved],
        );

        return rows[0]?.count === saved.length;
      });
      expect(gateway.worker.commands.filter((command) => command.case === "unloadThread")).toHaveLength(saved.length);
    } finally {
      holding = false;

      for (const reply of replies) reply();
      gateway.worker.handlers.delete("unloadThread");
    }
  });

  test("a command expiring behind an ACK batch is not sent from the prefetched page", async () => {
    const replies: (() => void)[] = [];
    let holding = true;
    const before = gateway.worker.commands.filter((command) => command.case === "unloadThread").length;
    gateway.worker.handlers.set("unloadThread", (_, reply) => {
      if (holding) replies.push(() => reply(true));
      else reply(true);
    });
    const saved = await seedCommands(66);
    const expiring = saved.toSorted().at(-2)!;
    await gateway.core.linkedAgents.query(
      "UPDATE worker_commands SET expires_at=now()+interval '1 second' WHERE id=$1::uuid",
      [expiring],
    );

    try {
      await coreRedeliver(gateway.core, gateway.workerId);
      await until(async () => replies.length === 64);
      await until(async () => {
        const rows = await gateway.core.linkedAgents.query<{ expired: boolean }>(
          "SELECT expires_at<=now() AS expired FROM worker_commands WHERE id=$1::uuid",
          [expiring],
        );

        return rows[0]?.expired === true;
      });
      holding = false;

      for (const reply of replies) reply();
      await until(async () => {
        const rows = await gateway.core.linkedAgents.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM worker_commands WHERE id=ANY($1::uuid[]) AND status='completed'",
          [saved],
        );

        return rows[0]?.count === 65;
      });
      expect(gateway.worker.commands.filter((command) => command.case === "unloadThread").length - before).toBe(65);

      const rows = await gateway.core.linkedAgents.query<{ status: string }>(
        "SELECT status FROM worker_commands WHERE id=$1::uuid",
        [expiring],
      );

      expect(rows[0]?.status).toBe("pending");
    } finally {
      holding = false;

      for (const reply of replies) reply();
      gateway.worker.handlers.delete("unloadThread");
    }
  });

  async function seedCommands(count: number) {
    const payload = toBinary(
      CommandSchema,
      create(CommandSchema, {
        kind: { case: "unloadThread", value: { threadId: Bun.randomUUIDv7() } },
      }),
    );

    const inserted = await gateway.core.linkedAgents.query<{ id: string }>(
      `INSERT INTO worker_commands(id,worker_id,kind,payload,expires_at,created_at)
       SELECT gen_random_uuid(),$1::uuid,'unloadThread',$2::bytea,now()+interval '1 hour','2026-01-01'
       FROM generate_series(1,$3::int) RETURNING id::text`,
      [gateway.workerId, payload, count],
    );

    return inserted.map((row) => row.id);
  }

  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 10000;

    while (!(await check())) {
      if (Date.now() > deadline) throw new Error("Command delivery did not make progress");
      await Bun.sleep(10);
    }
  }
});
