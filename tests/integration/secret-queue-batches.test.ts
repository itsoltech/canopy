import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, ThreadSecretReceiptSchema } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayStore, encryptSecret } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("durable secret queue batches", () => {
  let gateway: TestGateway;
  let threadId = "";
  const turnId = Bun.randomUUIDv7();

  const query = <A extends object>(text: string, ...params: never[]) =>
    gateway.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(text, params)));

  const poll = (reset = false) =>
    gateway.runtime.runPromise(GatewayStore.use((s) => s.secretDeliveries(gateway.workerId, reset)));

  beforeAll(async () => {
    // This worker does not advertise thread_secrets: receipts are controlled by the test.
    gateway = await startTestGateway();
    gateway.core.secrets.stop();
    const projectId = (await gateway.api.createProject({ name: "Secret queue" })).project!.id;

    const workspaceId = (
      await gateway.api.createWorkspace({ projectId, workerId: gateway.workerId, rootPath: "/repo" })
    ).workspace!.id;

    threadId = (await gateway.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!.id;
    await gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO turns(id,thread_id,ordinal,status,trigger,input,first_seq,last_seq,author_user_id)
          VALUES(${turnId}::uuid,${threadId}::uuid,1,'completed','user','{}',1,1,${gateway.userId}::uuid)`;
        yield* sql`INSERT INTO thread_secrets(id,thread_id,turn_id,call_id,label,description,status,
          ciphertext,key_id,expires_at,revision,applied_revision,file_path)
          SELECT md5('batch-secret-'||n)::uuid,${threadId}::uuid,${turnId}::uuid,
            md5('batch-call-'||n)::uuid,'Synthetic','Synthetic','saved',
            ${encryptSecret(gateway.secretsKey, "synthetic")},'env-v1',now()+interval '1 day',1,1,'/old/file'
          FROM generate_series(1,600)n`;
      }),
    );
  }, 60_000);

  afterAll(async () => {
    await gateway?.close();
  });

  test("reconnect resumes its sweep after restart and missing receipts cannot starve later grants", async () => {
    const first = await poll(true);
    expect(first).toHaveLength(64);
    expect(await query("SELECT count(*)::int AS n FROM thread_secrets WHERE applied_revision=0")).toEqual([{ n: 256 }]);
    const ids = await query<{ id: string }>("SELECT id FROM thread_secrets ORDER BY id");
    const last = ids.at(-1)!.id;
    const state = () => gateway.runtime.runPromise(GatewayStore.use((s) => s.secretResult(threadId, last)));
    expect(await state()).toMatchObject({ status: "pending", delivery: "waiting_for_worker" });

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await gateway.close(true);
    gateway = await startTestGateway({ storage });
    gateway.core.secrets.stop();
    expect(await state()).toMatchObject({ status: "pending" });
    const delivered = new Set(first.map((s) => s.requestId));

    for (let i = 0; i < 12 && delivered.size < 600; i++) {
      const batch = await poll();
      expect(batch.length).toBeLessThanOrEqual(64);

      for (const secret of batch) delivered.add(secret.requestId);
    }

    expect(delivered.size).toBe(600);
    expect(await query("SELECT worker_id FROM worker_secret_replays")).toEqual([]);
    expect(await state()).toMatchObject({ status: "pending" });
    await gateway.runtime.runPromise(
      GatewayStore.use((s) =>
        s.secretReceipt(
          gateway.workerId,
          create(ThreadSecretReceiptSchema, {
            requestId: last,
            threadId,
            revision: 1,
            applied: true,
            file: "/new/file",
          }),
        ),
      ),
    );
    expect(await state()).toMatchObject({ status: "saved", file: "/new/file" });
    expect(
      await gateway.runtime.runPromise(GatewayStore.use((s) => s.secretResult(threadId, first[0]!.requestId))),
    ).toMatchObject({ status: "pending" });
  });

  test("expiry drains bounded owner-scoped batches and keeps request metadata", async () => {
    await gateway.runtime.runPromise(
      SqlClient.SqlClient.use((sql) => sql`UPDATE thread_secrets SET expires_at=now()-interval '1 minute'`),
    );
    const expire = (owner: string) => gateway.runtime.runPromise(GatewayStore.use((s) => s.expireSecrets(owner)));
    expect(await expire(Bun.randomUUIDv7())).toEqual([]);
    const sizes = [];

    for (let i = 0; i < 4; i++) sizes.push((await expire(gateway.userId)).length);

    expect(sizes).toEqual([256, 256, 88, 0]);
    expect(
      await query("SELECT count(*)::int AS n FROM thread_secrets WHERE status='expired' AND ciphertext IS NULL"),
    ).toEqual([{ n: 600 }]);
    expect(await query("SELECT count(*)::int AS n FROM thread_secrets WHERE label='Synthetic' AND revision=2")).toEqual(
      [{ n: 600 }],
    );
  });

  test("concurrent polling advances one durable cursor and another worker gets no deliveries", async () => {
    const [first, second] = await Promise.all([poll(), poll()]);
    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(new Set([...first, ...second].map((delivery) => delivery.requestId)).size).toBe(128);
    expect(await gateway.runtime.runPromise(GatewayStore.use((s) => s.secretDeliveries(Bun.randomUUIDv7())))).toEqual(
      [],
    );
    expect(await query("SELECT worker_id FROM worker_secret_delivery_cursors")).toEqual([
      { worker_id: gateway.workerId },
    ]);
  });
});
