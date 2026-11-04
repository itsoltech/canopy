import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { update } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { UpdatePersistence } from "../../apps/gateway/src/updates/persistence.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("durable update metadata and administrator authorization", () => {
  let gateway: TestGateway;
  let store: UpdatePersistence;
  beforeAll(async () => {
    gateway = await startTestGateway();
    store = new UpdatePersistence(gateway.runtime, gateway.userId);
  }, 60_000);
  afterAll(async () => {
    await gateway?.close();
  });
  test("channel and command survive store recreation; stale reports cannot overwrite a newer command", async () => {
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE users SET role = 'user' WHERE id = ${gateway.userId}::uuid`;
      }),
    );
    expect(await store.admin()).toBe(false);
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE users SET role = 'admin' WHERE id = ${gateway.userId}::uuid`;
      }),
    );
    expect(await store.admin()).toBe(true);
    await store.setChannel("v2.4");
    await store.hello(
      gateway.workerId,
      create(update.CheckRequestSchema, {
        version: "1.0.0",
        installKind: "binary",
        os: "linux",
        arch: "x64",
        minWorkerLinkProtocol: 1,
        workerLinkProtocol: 1,
      }),
    );

    const command = create(update.UpdateCommandSchema, {
      id: "durable-command",
      version: "2.4.1",
      manifestJson: "{}",
      preferGatewayMirror: true,
    });

    await store.saveCommand(gateway.workerId, command);
    const reopened = new UpdatePersistence(gateway.runtime, gateway.userId);
    expect(await reopened.channel()).toBe("v2.4");
    expect((await reopened.workers()).find((w) => w.id === gateway.workerId)?.command).toEqual(command);
    await reopened.report(
      gateway.workerId,
      create(update.ReportRequestSchema, { commandId: "stale", state: "failed", reason: "obsolete error" }),
    );
    expect((await reopened.workers()).find((w) => w.id === gateway.workerId)?.status.state).toBe("queued");
    await reopened.report(
      gateway.workerId,
      create(update.ReportRequestSchema, {
        commandId: command.id,
        version: command.version,
        state: "failed",
        reason: "SHA mismatch",
      }),
    );
    await reopened.hello(
      gateway.workerId,
      create(update.CheckRequestSchema, {
        version: "1.0.0",
        installKind: "binary",
        os: "linux",
        arch: "x64",
        minWorkerLinkProtocol: 1,
        workerLinkProtocol: 1,
      }),
    );
    expect((await reopened.workers()).find((w) => w.id === gateway.workerId)?.status).toMatchObject({
      state: "failed",
      reason: "SHA mismatch",
      targetVersion: command.version,
      installKind: "binary",
    });
  });
  test("a healthy reconnect completes restarting only on the commanded version", async () => {
    const command = create(update.UpdateCommandSchema, { id: "reconnect-command", version: "2.4.2" });
    await store.saveCommand(gateway.workerId, command);
    await store.report(
      gateway.workerId,
      create(update.ReportRequestSchema, {
        commandId: command.id,
        version: command.version,
        state: "restarting",
        reason: "Restarting worker",
      }),
    );
    // UpdateService can reconnect before WorkerLink is healthy: that alone must not prove success.
    await store.hello(
      gateway.workerId,
      create(update.CheckRequestSchema, { version: command.version, installKind: "binary" }),
    );
    expect((await store.workers()).find((w) => w.id === gateway.workerId)?.status.state).toBe("restarting");
    await gateway.connect(gateway.workerId, gateway.workerCredential, undefined, {
      hello: { host: { workerVersion: "2.4.1" } },
    });
    await eventually(
      () => store.workers(),
      (rows) => rows.some((w) => w.id === gateway.workerId && w.version === "2.4.1"),
    );
    expect((await store.workers()).find((w) => w.id === gateway.workerId)?.status.state).toBe("restarting");
    await gateway.connect(gateway.workerId, gateway.workerCredential, undefined, {
      hello: { host: { workerVersion: command.version } },
    });
    const reopened = new UpdatePersistence(gateway.runtime, gateway.userId);
    await eventually(
      () => reopened.workers(),
      (rows) => rows.some((w) => w.id === gateway.workerId && w.status.state === "succeeded"),
    );
    expect((await reopened.workers()).find((w) => w.id === gateway.workerId)?.status).toMatchObject({
      state: "succeeded",
      reason: "",
      targetVersion: command.version,
    });
    await store.report(
      gateway.workerId,
      create(update.ReportRequestSchema, {
        commandId: command.id,
        version: command.version,
        state: "failed",
        reason: "Rollback",
      }),
    );

    const epoch = () =>
      gateway.runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;

          const rows = yield* sql<{
            epoch: number;
          }>`SELECT epoch::int AS epoch FROM worker_connections WHERE worker_id = ${gateway.workerId}::uuid`;

          return rows[0]?.epoch ?? 0;
        }),
      );

    const before = await epoch();
    await gateway.connect(gateway.workerId, gateway.workerCredential, undefined, {
      hello: { host: { workerVersion: command.version } },
    });
    await eventually(epoch, (value) => value > before);
    expect((await reopened.workers()).find((w) => w.id === gateway.workerId)?.status.reason).toBe("Rollback");
  });
});
