import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { update } from "@open-agents/contracts";
import { dockerAvailable } from "@open-agents/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { UpdatePersistence } from "../../apps/gateway/src/updates/persistence.ts";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("durable update metadata and administrator authorization", () => {
  let gateway: TestGateway;
  let store: UpdatePersistence;
  beforeAll(async () => {
    gateway = await startTestGateway();
    store = new UpdatePersistence(gateway.runtime, gateway.userId);
  }, 60_000);
  afterAll(async () => { await gateway?.close(); });
  test("channel and command survive store recreation; stale reports cannot overwrite a newer command", async () => {
    await gateway.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE users SET role = 'user' WHERE id = ${gateway.userId}::uuid`;
    }));
    expect(await store.admin()).toBe(false);
    await gateway.runtime.runPromise(Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE users SET role = 'admin' WHERE id = ${gateway.userId}::uuid`;
    }));
    expect(await store.admin()).toBe(true);
    await store.setChannel("v2.4");
    await store.hello(gateway.workerId, create(update.CheckRequestSchema, { version: "1.0.0", installKind: "binary", os: "linux", arch: "x64", minWorkerLinkProtocol: 1, workerLinkProtocol: 1 }));
    const command = create(update.UpdateCommandSchema, { id: "durable-command", version: "2.4.1", manifestJson: "{}", preferGatewayMirror: true });
    await store.saveCommand(gateway.workerId, command);
    const reopened = new UpdatePersistence(gateway.runtime, gateway.userId);
    expect(await reopened.channel()).toBe("v2.4");
    expect((await reopened.workers()).find((w) => w.id === gateway.workerId)?.command).toEqual(command);
    await reopened.report(gateway.workerId, create(update.ReportRequestSchema, { commandId: "stale", state: "failed", reason: "obsolete error" }));
    expect((await reopened.workers()).find((w) => w.id === gateway.workerId)?.status.state).toBe("queued");
    await reopened.report(gateway.workerId, create(update.ReportRequestSchema, { commandId: command.id, version: command.version, state: "failed", reason: "SHA mismatch" }));
    await reopened.hello(gateway.workerId, create(update.CheckRequestSchema, { version: "1.0.0", installKind: "binary", os: "linux", arch: "x64", minWorkerLinkProtocol: 1, workerLinkProtocol: 1 }));
    expect((await reopened.workers()).find((w) => w.id === gateway.workerId)?.status).toMatchObject({ state: "failed", reason: "SHA mismatch", targetVersion: command.version, installKind: "binary" });
  });
});
