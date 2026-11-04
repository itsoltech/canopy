import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  ItemDeltaField,
  ItemStatus,
  Provider,
  ThreadSecretDeliverySchema,
  ui,
  type AgentToolResult,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { startGrpcServer } from "@canopy/transport";
import { openGatewayLink } from "@canopy/worker/gateway-link";
import { isBigInt, tempDirs } from "@canopy/testing";
import { Journal } from "@canopy/worker/journal";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import {
  eventually,
  failure,
  startTestGateway,
  watchUntil,
  ScriptedWorker,
  type TestGateway,
} from "./support/gateway.ts";

const tempDir = tempDirs();

const args = {
  label: "HubSpot access token",
  description: "Read the development account without sending the token to chat.",
  placeholder: "pat-…",
  name: "HUBSPOT_TOKEN",
};

const result = (r: AgentToolResult) => JSON.parse(r.content) as { status: string; request_id: string; file?: string };

describe.skipIf(!dockerAvailable)("thread secrets (gateway ↔ scripted worker, real private files)", () => {
  let gw: TestGateway;
  let worker: ScriptedWorker;
  let dataDir = "";
  let projectId = "";
  let workspaceId = "";

  const query = <A extends object>(text: string, ...params: unknown[]) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(text, params as never[]);
      }),
    );

  const start = async () => {
    worker.holdTurns = true;

    const thread = (
      await gw.api.createThread({
        projectId,
        workspaceId,
        provider: Provider.CODEX,
        title: "Secrets",
        initialMessage: "work",
      })
    ).thread!;

    const turns = await eventually(
      () => query<{ id: string; status: string }>("SELECT id, status FROM turns WHERE thread_id = $1::uuid", thread.id),
      (r) => r[0]?.status === "running",
    );

    return { threadId: thread.id, turnId: turns[0]!.id };
  };

  const ask = async (source: { threadId: string; turnId: string }, label = args.label) => {
    const callId = Bun.randomUUIDv7();
    const waiting = worker.callTool({ ...source, callId, tool: "request_secret", args: { ...args, label } });
    await eventually(
      () => query("SELECT id FROM thread_secrets WHERE id = $1::uuid", callId),
      (r) => r.length === 1,
    );

    return { callId, waiting };
  };

  const assertAbsent = async (secret: string) => {
    for (const table of [
      "turns",
      "turn_steers",
      "thread_items",
      "thread_events",
      "agent_bus_calls",
      "worker_commands",
      "interaction_requests",
      "audit_log",
    ]) {
      const found = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} r WHERE row_to_json(r)::text LIKE $1`,
        `%${secret}%`,
      );

      expect(found[0]?.n, table).toBe(0);
    }
  };

  beforeAll(async () => {
    dataDir = tempDir("canopy-thread-secrets-worker-");
    gw = await startTestGateway({ worker: { secretsDataDir: dataDir } });
    worker = gw.worker;
    projectId = (await gw.api.createProject({ name: "Secrets" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!.id;
  }, 60_000);
  afterAll(async () => {
    await gw?.close();
  });

  test("save is encrypted, materialized 0600 outside repo, reference only; echoes are masked before durable events; revoke removes it", async () => {
    const source = await start();
    const { callId, waiting } = await ask(source);
    const value = `pat-private-${crypto.randomUUID()}`;
    const snapshots = await watchUntil(gw.api, source.threadId, (u) => u.length > 0);
    expect(snapshots[0]?.change.case === "snapshot" && snapshots[0].change.value.secrets[0]?.status).toBe("pending");
    const saved = await gw.api.answerThreadSecret({ requestId: callId, value });
    expect(JSON.stringify(saved, (_, v) => (isBigInt(v) ? String(v) : v))).not.toContain(value);
    const tool = await waiting;
    expect(tool.isError).toBe(false);
    expect(tool.content).not.toContain(value);
    const file = result(tool).file!;
    expect(result(tool).status).toBe("saved");
    expect(file.startsWith(join(dataDir, "thread-secrets", source.threadId))).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "thread-secrets", source.threadId)).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, "utf8")).toBe(value);

    const rows = await query<{ ciphertext: Uint8Array; key_id: string }>(
      "SELECT ciphertext, key_id FROM thread_secrets WHERE id = $1::uuid",
      callId,
    );

    expect(rows[0]?.key_id).toBe("env-v1");
    expect(Buffer.from(rows[0]!.ciphertext).includes(Buffer.from(value))).toBe(false);

    const journal = ManagedRuntime.make(Journal.layer(join(dataDir, "echo-journal.db")));

    try {
      const delta = await journal.runPromise(
        Journal.use((j) =>
          j.append(source.threadId, {
            turnId: source.turnId,
            rawJson: JSON.stringify({ output: value.slice(0, 8) }),
            body: {
              case: "itemDelta",
              value: { itemId: "echo", field: ItemDeltaField.OUTPUT, chunk: value.slice(0, 8) },
            },
          }),
        ),
      );

      expect(delta.rawJson).toBe("");
      expect(delta.body.case === "itemDelta" && delta.body.value.chunk).toBe("");
      await journal.runPromise(
        Journal.use((j) =>
          j.append(source.threadId, {
            turnId: source.turnId,
            body: { case: "itemDelta", value: { itemId: "echo", field: ItemDeltaField.OUTPUT, chunk: value.slice(8) } },
          }),
        ),
      );

      const complete = await journal.runPromise(
        Journal.use((j) =>
          j.append(source.threadId, {
            turnId: source.turnId,
            rawJson: JSON.stringify({ output: value }),
            body: {
              case: "itemCompleted",
              value: {
                item: {
                  itemId: "echo",
                  status: ItemStatus.COMPLETED,
                  content: { case: "commandExecution", value: { command: "accidental echo", output: "", exitCode: 0 } },
                },
              },
            },
          }),
        ),
      );

      expect(JSON.stringify(complete, (_, v) => (isBigInt(v) ? String(v) : v))).not.toContain(value);
      expect(
        complete.body.case === "itemCompleted" &&
          complete.body.value.item?.content.case === "commandExecution" &&
          complete.body.value.item.content.value.output,
      ).toBe("[REDACTED]");
      worker.emit(source.threadId, source.turnId, complete.body);
      await eventually(
        () =>
          query<{ n: number }>(
            "SELECT count(*)::int AS n FROM thread_items WHERE thread_id = $1::uuid AND item_id = 'echo'",
            source.threadId,
          ),
        (r) => r[0]?.n === 1,
      );
      expect(readFileSync(join(dataDir, "echo-journal.db")).includes(Buffer.from(value))).toBe(false);
    } finally {
      await journal.dispose();
    }

    await assertAbsent(value);
    await gw.api.revokeThreadSecret({ requestId: callId });
    await eventually(
      () => Promise.resolve(existsSync(file)),
      (present) => !present,
    );
    expect(await query("SELECT ciphertext, status FROM thread_secrets WHERE id = $1::uuid", callId)).toEqual([
      { ciphertext: null, status: "revoked" },
    ]);

    const stale = worker.secrets!.apply(
      create(ThreadSecretDeliverySchema, {
        requestId: callId,
        threadId: source.threadId,
        revision: 1,
        value,
        expiresAt: saved.secret!.expiresAt,
      }),
    );

    expect(stale.applied).toBe(false);
    expect(existsSync(file)).toBe(false);
    worker.finish(source.threadId, source.turnId);
  });

  test("decline has no file; another thread cannot renew or inherit the grant", async () => {
    const source = await start();
    const { callId, waiting } = await ask(source);
    await gw.api.answerThreadSecret({ requestId: callId, decline: true });
    expect(result(await waiting)).toMatchObject({ status: "declined", request_id: callId });
    const other = await start();
    const denied = await worker.callTool({ ...other, tool: "request_secret", args: { ...args, request_id: callId } });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("not found in this thread");
    expect(
      await failure(gw.api.answerThreadSecret({ requestId: Bun.randomUUIDv7(), value: "private-bad-request" })),
    ).not.toContain("private-bad-request");
    worker.finish(source.threadId, source.turnId);
    worker.finish(other.threadId, other.turnId);
  });

  test("expiry deletes gateway ciphertext and worker file even while the worker is disconnected", async () => {
    const source = await start();
    const { callId, waiting } = await ask(source);
    const value = `expires-${crypto.randomUUID()}`;
    await gw.api.answerThreadSecret({ requestId: callId, value });
    const file = result(await waiting).file!;
    // Advance the durable deadline and re-deliver it; this tests the independent worker timer too.
    await query(
      "UPDATE thread_secrets SET expires_at = now() + interval '500 milliseconds', applied_revision = 0 WHERE id = $1::uuid",
      callId,
    );
    // A new revision represents a changed grant; production TTL is fixed when saved.
    await query("UPDATE thread_secrets SET revision = revision + 1 WHERE id = $1::uuid", callId);
    await gw.core.secrets.sync(gw.workerId);
    await eventually(
      () => query<{ n: number }>("SELECT applied_revision AS n FROM thread_secrets WHERE id = $1::uuid", callId),
      (r) => r[0]?.n === 2,
    );
    worker.link.close();
    await eventually(
      () => Promise.resolve(existsSync(file)),
      (present) => !present,
    );
    await gw.core.secrets.tick();
    expect(await query("SELECT ciphertext, status FROM thread_secrets WHERE id = $1::uuid", callId)).toEqual([
      { ciphertext: null, status: "expired" },
    ]);
    worker = await gw.connect(gw.workerId, gw.workerCredential, undefined, { secretsDataDir: dataDir });
    await gw.core.secrets.sync(gw.workerId, true);
    expect(existsSync(file)).toBe(false);
    await assertAbsent(value);
    worker.finish(source.threadId, source.turnId);
  });

  test("restart clears disk then re-materializes only live grants; pending requests can be renewed by a new call", async () => {
    const source = await start();
    const live = await ask(source, "Live across restart");
    const value = `restart-${crypto.randomUUID()}`;
    await gw.api.answerThreadSecret({ requestId: live.callId, value });
    const file = result(await live.waiting).file!;
    const pending = await ask(source, "Pending across restart");
    worker.link.close();
    worker.secrets!.close();
    expect(existsSync(file)).toBe(false);
    worker = await gw.connect(gw.workerId, gw.workerCredential, undefined, { secretsDataDir: dataDir });
    await eventually(() => Promise.resolve(existsSync(file)), Boolean);
    expect(readFileSync(file, "utf8")).toBe(value);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const renewed = worker.callTool({
      ...source,
      tool: "request_secret",
      args: { ...args, request_id: pending.callId },
    });

    await gw.api.answerThreadSecret({ requestId: pending.callId, decline: true });
    expect(result(await renewed).status).toBe("declined");
    // The old gateway waiter is detached with its old link, but its durable request was the same.
    void pending.waiting;
    await eventually(
      () => query("SELECT id FROM agent_bus_calls WHERE id = $1::uuid", pending.callId),
      (r) => r.length === 1,
    );
    expect((await query("SELECT id FROM thread_secrets WHERE id = $1::uuid", pending.callId)).length).toBe(1);
    await gw.api.revokeThreadSecret({ requestId: live.callId });
    await eventually(
      () => Promise.resolve(existsSync(file)),
      (present) => !present,
    );
    await assertAbsent(value);
    worker.finish(source.threadId, source.turnId);
  });

  test("a new gateway instance recovers pending requests and saved grants from the database", async () => {
    const source = await start();
    const live = await ask(source, "Gateway restart grant");
    const value = `gateway-restart-${crypto.randomUUID()}`;
    await gw.api.answerThreadSecret({ requestId: live.callId, value });
    const file = result(await live.waiting).file!;
    const pending = await ask(source, "Gateway restart pending");
    worker.link.close();
    worker.secrets!.close();
    await eventually(
      async () => gw.core.online.has(gw.workerId),
      (online) => !online,
    );
    gw.core.stopSweep();
    const fresh = new GatewayCore({ runtime: gw.runtime, instanceId: "restart-secrets", userId: gw.userId });
    const server = await startGrpcServer({ routes: (router) => fresh.link.routes(router) });
    let restored: ScriptedWorker | undefined;

    try {
      restored = new ScriptedWorker(
        await openGatewayLink({
          baseUrl: server.url,
          credential: gw.workerCredential,
          hello: {
            workerId: gw.workerId,
            journalId: `journal-${gw.workerId.slice(-6)}`,
            capabilities: ["thread_secrets"],
          },
        }),
        { secretsDataDir: dataDir },
      );
      await eventually(() => Promise.resolve(existsSync(file)), Boolean);
      expect(readFileSync(file, "utf8")).toBe(value);

      const waiting = restored.callTool({
        ...source,
        tool: "request_secret",
        args: { ...args, request_id: pending.callId },
      });

      await fresh.secrets.answer(
        create(ui.AnswerThreadSecretRequestSchema, { requestId: pending.callId, decline: true }),
      );
      expect(result(await waiting).status).toBe("declined");
      await fresh.secrets.revoke(live.callId);
      await eventually(
        () => Promise.resolve(existsSync(file)),
        (present) => !present,
      );
      expect(existsSync(file)).toBe(false);
      await assertAbsent(value);
    } finally {
      restored?.link.close();
      restored?.secrets?.close();
      fresh.stopSweep();
      await fresh.bots.stop();
      await fresh.link.shutdown();
      await server.close();
    }
  });
});
