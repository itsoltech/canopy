import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { Provider, ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { THREAD_FILE_REVEAL_CAPABILITY } from "@canopy/domain/release/protocol";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, serviceTokenAuth, uiHandlers, uiRoutes } from "@canopy/gateway/api";
import { GatewayStore } from "@canopy/gateway/store";
import { startGrpcServer } from "@canopy/transport";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, SERVICE_TOKEN, startTestGateway, type TestGateway } from "./support/gateway.ts";

const capabilities = ["thread_files_v1", "desktop_bundled", THREAD_FILE_REVEAL_CAPABILITY];

async function makeThread(gw: TestGateway) {
  const projectId = (await gw.api.createProject({ name: "File reveal" })).project!.id;

  const workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo" })).workspace!
    .id;

  return (await gw.api.createThread({ projectId, workspaceId, provider: Provider.CODEX })).thread!;
}

describe.skipIf(!dockerAvailable)("local desktop file reveal authorization over gRPC", () => {
  let home: TestGateway;
  let caller: TestGateway;
  let a: LinkedComputers;
  let b: LinkedComputers;
  let thread: ui.Thread;
  let authenticated: Awaited<ReturnType<typeof startGrpcServer>>;

  const request = () => ({ threadId: thread.id, path: "report.txt" });
  const sent = () => home.worker.commands.filter((command) => command.case === "revealFile");

  const client = (token: string) =>
    createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: authenticated.url,
        interceptors: [
          (next) => (r) => {
            r.header.set("authorization", `Bearer ${token}`);
            r.header.set("x-canopy-desktop-session", "forged");

            return next(r);
          },
        ],
      }),
    );

  beforeAll(async () => {
    home = await startTestGateway({ role: "desktop", worker: { hello: { capabilities } } });
    caller = await startTestGateway({ role: "desktop" });
    thread = await makeThread(home);
    authenticated = await startGrpcServer({
      routes: uiRoutes(home.core),
      interceptors: [serviceTokenAuth(SERVICE_TOKEN, home.core.mobile)],
    });

    const computers = (gw: TestGateway) =>
      linkedComputers({
        store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 100,
        serve: remoteServe(uiHandlers(gw.core), gw.core),
      });

    a = computers(caller);
    b = computers(home);
    caller.core.computers = a;
    caller.core.network = a.options.network;
    home.core.computers = b;
    home.core.network = b.options.network;
    await a.start();
    await b.start();
    const invitation = await caller.api.createComputerPairing({});
    await home.api.linkComputer({ address: a.addresses[0]!, code: invitation.code });
    await eventually(async () => a.reachable().includes(b.hello().nodeId), Boolean);
  }, 60_000);

  afterAll(async () => {
    await authenticated?.close();
    await Promise.allSettled([a?.close(), b?.close()]);
    await caller?.close();
    await home?.close();
  });

  test("only the local service sends a scoped transient command, independent of default-app opening", async () => {
    const before = sent().length;
    await home.api.revealThreadFile(request());
    expect(sent()).toHaveLength(before + 1);
    expect(sent().at(-1)?.value).toMatchObject({
      threadId: thread.id,
      path: "report.txt",
      roots: ["/repo"],
      workspace: "/repo",
    });
    expect(home.worker.commands.some((command) => command.case === "openFile")).toBe(false);
    const workers = (await home.api.getOverview({})).workers;
    expect(workers.find((worker) => worker.id === home.workerId)).toMatchObject({
      fileReveal: true,
      desktopBundled: true,
    });

    const durable = await home.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => sql`SELECT id FROM worker_commands WHERE kind='revealFile'`),
    );

    expect(durable).toHaveLength(0);
  });

  test("paired phones and remote desktops cannot forge the local BFF identity", async () => {
    const before = sent().length;

    for (const kind of ["mobile", "desktop"]) {
      const token = `canopy_${kind === "mobile" ? "device" : "desktop"}_${"A".repeat(43)}`;
      const digest = createHash("sha256").update(token).digest("hex");
      await home.runtime.runPromise(
        Effect.flatMap(
          SqlClient.SqlClient,
          (sql) => sql`INSERT INTO mobile_devices
          (id, owner_user_id, name, platform, token_hash, pairing_version, client_kind)
          VALUES (${Bun.randomUUIDv7()}::uuid, ${home.userId}::uuid, 'Reveal client',
            ${kind === "mobile" ? "ios" : "linux"}, ${digest}, 2, ${kind})`,
        ),
      );
      await expect(client(token).revealThreadFile(request())).rejects.toMatchObject({ code: Code.PermissionDenied });
    }

    await expect(client("invalid").revealThreadFile(request())).rejects.toMatchObject({ code: Code.Unauthenticated });
    expect(sent()).toHaveLength(before);
  });

  test("same-turn item hints reach the worker without widening its roots", async () => {
    const turnId = Bun.randomUUIDv7();
    const itemId = Bun.randomUUIDv7();
    await home.runtime.runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO turns (id, thread_id, ordinal, status, trigger, input, first_seq, last_seq)
          SELECT ${turnId}::uuid, ${thread.id}::uuid, COALESCE(MAX(ordinal), 0) + 1,
            'completed', 'provider', '{}'::jsonb, 100, 100 FROM turns WHERE thread_id=${thread.id}::uuid`;
          yield* sql`INSERT INTO thread_items (thread_id, item_id, turn_id, type, status, content, first_seq, last_seq)
          VALUES (${thread.id}::uuid, ${itemId}, ${turnId}::uuid, 'agentMessage', 'completed',
            '{"text":"nested/report.txt"}'::jsonb, 100, 100)`;
        }),
      ),
    );
    await home.api.revealThreadFile({ ...request(), itemId });
    expect(sent().at(-1)?.value).toMatchObject({
      preferredPaths: ["nested/report.txt"],
      roots: ["/repo"],
      workspace: "/repo",
    });
  });

  test("a linked thread is never forwarded and a peer cannot call the local method directly", async () => {
    const before = sent().length;
    await expect(
      caller.api.revealThreadFile({
        ...request(),
        threadId: qualifyId(thread.id, b.hello().nodeId),
      }),
    ).rejects.toBeInstanceOf(ConnectError);

    const direct = async () => {
      for await (const _ of a.remote(
        b.hello().nodeId,
        ui.GatewayService.method.revealThreadFile,
        create(ui.ThreadFileRequestSchema, request()),
        AbortSignal.timeout(5_000),
      )) {
        /* drain */
      }
    };

    await expect(direct()).rejects.toMatchObject({ code: Code.Unimplemented });
    expect(sent()).toHaveLength(before);
  });

  test("old workers and external workers receive no reveal command", async () => {
    const connection = home.core.link.connections.get(home.workerId)!;
    const original = connection.hello.capabilities;
    const before = sent().length;

    try {
      for (const missing of ["desktop_bundled", THREAD_FILE_REVEAL_CAPABILITY]) {
        connection.hello.capabilities = original.filter((capability) => capability !== missing);
        await expect(home.api.revealThreadFile(request())).rejects.toMatchObject({ code: Code.InvalidArgument });
      }
    } finally {
      connection.hello.capabilities = original;
    }

    expect(sent()).toHaveLength(before);
  });

  test("path traversal and another owner's thread are rejected before worker dispatch", async () => {
    const before = sent().length;

    for (const path of [
      "../private.txt",
      "folder/../private.txt",
      "folder\\..\\private.txt",
      "",
      "x\0",
      "x".repeat(4097),
    ])
      await expect(home.api.revealThreadFile({ ...request(), path })).rejects.toMatchObject({
        code: Code.InvalidArgument,
      });

    const owner = await home.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("reveal-owner@example.test", "Other owner")),
    );

    const id = Bun.randomUUIDv7();
    await home.runtime.runPromise(
      Effect.flatMap(
        SqlClient.SqlClient,
        (sql) => sql`INSERT INTO threads (id, project_id, owner_user_id, kind, root_thread_id, depth,
        runtime, provider, worker_id, workspace_id, cwd, title, status)
        SELECT ${id}::uuid, project_id, ${owner}::uuid, 'main', ${id}::uuid, 0,
          runtime, provider, worker_id, workspace_id, cwd, 'Foreign file', 'idle'
        FROM threads WHERE id=${thread.id}::uuid`,
      ),
    );
    await expect(home.api.revealThreadFile({ ...request(), threadId: id })).rejects.toMatchObject({
      code: Code.InvalidArgument,
    });
    expect(sent()).toHaveLength(before);
  });

  test("a server gateway rejects reveals even with the service token and a worker claiming desktop capabilities", async () => {
    const server = await startTestGateway({ worker: { hello: { capabilities } } });

    try {
      const target = await makeThread(server);
      const external = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: server.grpcUrl }));
      await expect(
        external.revealThreadFile(
          { threadId: target.id, path: "report.txt" },
          {
            headers: { authorization: `Bearer ${SERVICE_TOKEN}` },
            signal: AbortSignal.timeout(3_000),
          },
        ),
      ).rejects.toMatchObject({
        code: Code.PermissionDenied,
      });
      expect(server.worker.commands.some((command) => command.case === "revealFile")).toBe(false);
    } finally {
      await server.close();
    }
  }, 30_000);
});
