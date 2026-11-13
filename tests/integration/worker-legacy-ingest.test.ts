import { expect, test } from "bun:test";
import { join } from "node:path";
import { createWorkerLink } from "@canopy/gateway/worker-link";
import { tempDir } from "@canopy/testing";
import { startGrpcServer } from "@canopy/transport";
import { journalHello, openGatewayLink, resendPending, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually } from "./support/gateway.ts";

test("a new worker caps a legacy ingest drain, retains the backlog across restart, and resumes on gateway upgrade", async () => {
  const directory = tempDir("canopy-legacy-ingest-");
  const path = join(directory, "journal.db");
  const workerId = Bun.randomUUIDv7();
  const poisonThread = Bun.randomUUIDv7();
  const healthyThread = Bun.randomUUIDv7();
  let upgraded = false;
  let drains = 0;
  let poisonReceived = 0;
  let healthyReceived = 0;
  const cursors = new Map<string, bigint>();

  const server = createWorkerLink({
    authenticate: async () => workerId,
    welcome: async () => ({
      heartbeatIntervalSeconds: 15,
      isolatedEventIngest: upgraded,
      persisted: [...cursors].map(([threadId, lastSeq]) => ({ threadId, lastSeq })),
    }),
    onConnected: async (connection) => {
      for await (const message of connection.messages) {
        if (message.payload.case !== "threadEvent") continue;
        const event = message.payload.value;

        if (event.threadId === poisonThread) {
          poisonReceived++;

          if (!upgraded) {
            drains++;
            connection.send({
              case: "drain",
              value: { reason: "redelivering events that failed to store", reconnectAfterMs: 10_000 },
            });
            connection.close();

            return;
          }
        } else healthyReceived++;
        cursors.set(event.threadId, event.journalSeq);
        connection.send({ case: "eventAck", value: { threadId: event.threadId, ackSeq: event.journalSeq } });
      }
    },
  });

  const grpc = await startGrpcServer({ routes: server.routes });
  let runtime = ManagedRuntime.make(Journal.layer(path));
  let host = new WorkerHost({ runtime, dataDir: join(directory, "data"), clientVersion: "test" });
  let link: GatewayLink | undefined;
  let serving: Promise<{ readonly drainDelayMs?: number }> | undefined;
  const logs: string[] = [];

  async function connect() {
    link = await openGatewayLink({
      baseUrl: grpc.url,
      credential: "test-worker-credential",
      heldThreads: await runtime.runPromise(Journal.use((journal) => journal.heldThreads())),
      hello: { workerId, ...(await runtime.runPromise(journalHello())) },
    });
    serving = serveLink(link, host, runtime, (message) => logs.push(message));
    await runtime.runPromise(resendPending(link));
  }

  try {
    await runtime.runPromise(
      Journal.use((journal) =>
        journal.append(poisonThread, { body: { case: "notice", value: { message: "Unacknowledged output" } } }),
      ),
    );
    await connect();
    expect(await serving).toEqual({ drainDelayMs: 10_000 });
    expect(await runtime.runPromise(Journal.use((journal) => journal.heldThreads()))).toEqual([poisonThread]);
    expect(logs.some((message) => message.startsWith("worker events deferred:"))).toBe(true);
    await host.shutdown();
    await runtime.dispose();
    runtime = ManagedRuntime.make(Journal.layer(path));
    host = new WorkerHost({ runtime, dataDir: join(directory, "data"), clientVersion: "test" });
    await runtime.runPromise(
      Journal.use((journal) =>
        journal.append(healthyThread, { body: { case: "notice", value: { message: "Healthy output" } } }),
      ),
    );
    await connect();
    expect(
      await eventually(
        async () => healthyReceived,
        (count) => count === 1,
      ),
    ).toBe(1);

    const later = await runtime.runPromise(
      Journal.use((journal) =>
        journal.append(poisonThread, { body: { case: "notice", value: { message: "Later retained output" } } }),
      ),
    );

    link!.send({ case: "threadEvent", value: later });
    await Bun.sleep(1_200);
    expect(poisonReceived).toBe(1);
    expect(drains).toBe(1);
    expect((await runtime.runPromise(journalHello())).threads.map((row) => row.threadId)).toEqual([poisonThread]);
    link!.close();
    await serving;
    upgraded = true;
    await connect();
    expect(
      (
        await eventually(
          () => runtime.runPromise(journalHello()),
          (hello) => hello.threads.length === 0,
        )
      ).threads,
    ).toEqual([]);
    expect(poisonReceived).toBe(3);
    expect(drains).toBe(1);
    expect(await runtime.runPromise(Journal.use((journal) => journal.heldThreads()))).toEqual([]);
  } finally {
    link?.close();
    await serving;
    await host.shutdown();
    await runtime.dispose();
    await server.shutdown();
    await grpc.close();
  }
}, 30_000);
