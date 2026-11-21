import "reflect-metadata";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { create, type Message } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import { computerLink as link, ui } from "@canopy/contracts";
import { dockerAvailable, startPostgres } from "@canopy/db/testing";
import { REMOTE_THREADS } from "@canopy/domain/computers";
import { AsyncChannel } from "@canopy/transport";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import { GatewayCore } from "../../apps/gateway/src/core/core.ts";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { computersReconnect } from "../../apps/gateway/src/computers/runtime-connection.ts";
import { computersState } from "../../apps/gateway/src/computers/runtime-context.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkClient } from "../../apps/gateway/src/computers/transport.ts";
import { RelocationRuntime } from "../../apps/gateway/src/migration/relocation-fence-runtime.ts";
import { ensureDevUser, gatewayRuntime } from "../../apps/gateway/src/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

async function result(messages: AsyncIterable<Message>) {
  const results: Message[] = [];

  for await (const value of messages) results.push(value);

  return results;
}

test.skipIf(!dockerAvailable)(
  "relocation denies new linked work and lets a paired computer reconnect to finish active work",
  async () => {
    const pg = await startPostgres({ migrated: true });

    const config = await Effect.runPromise(
      PgClient.PgClient.use((sql) => Effect.succeed(sql.config)).pipe(Effect.provide(pg.layer)),
    );

    const key = randomBytes(32);

    const env = {
      CANOPY_DATABASE_URL: `postgres://postgres:test@127.0.0.1:${config.port}/${config.database}`,
      CANOPY_SECRETS_KEY: key.toString("base64"),
    };

    const runtime = gatewayRuntime(env);
    const relocation = await RelocationRuntime.open(env);
    const userId = await ensureDevUser(runtime, "relocation@example.test");
    const core = new GatewayCore({ role: "desktop", relocation, runtime, userId, instanceId: "linked-relocation" });
    const store = new ComputerStore(runtime, userId, key);
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let projects = 0;
    let interrupts = 0;

    const home = linkedComputers({
      store,
      core,
      host: "127.0.0.1",
      heartbeatMs: 1_000,
      capabilities: [REMOTE_THREADS],
      async *serve(method) {
        if (method.name === "AddProject") {
          projects++;
          entered.resolve();
          await finish.promise;
          yield create(ui.AddProjectResponseSchema);
        }

        if (method.name === "InterruptThread") {
          interrupts++;
          yield create(ui.InterruptThreadResponseSchema);
        }
      },
    });

    let peer: TestGateway | undefined;
    let peerLinks: ReturnType<typeof linkedComputers> | undefined;
    let pending: Promise<Message[]> | undefined;

    try {
      await home.start();
      peer = await startTestGateway({ role: "desktop" });

      const links = linkedComputers({
        store: new ComputerStore(peer.runtime, peer.userId, peer.secretsKey),
        host: "127.0.0.1",
        heartbeatMs: 1_000,
        capabilities: [REMOTE_THREADS],
      });

      peerLinks = links;
      await links.start();
      const address = home.addresses[0]!;
      const node = home.hello().nodeId;
      const invite = await home.createPairing(false);
      await links.pair(address, invite.code, false);
      expect(await eventually(async () => links.canCall(node), Boolean)).toBe(true);

      const call = (method: Parameters<typeof links.remote>[1], input: Message) =>
        result(links.remote(node, method, input, AbortSignal.timeout(5_000)));

      const addProject = () => call(ui.GatewayService.method.addProject, create(ui.AddProjectRequestSchema));
      pending = addProject();
      await Promise.race([entered.promise, pending]);
      expect(relocation.requestsIdle).toBe(false);
      await store.query("INSERT INTO gateway_relocation_fence (operation_id, state) VALUES ($1, 'draining')", [
        crypto.randomUUID(),
      ]);
      await relocation.refresh();
      expect(relocation.draining).toBe(true);
      const maintenance = { code: Code.Unavailable, rawMessage: "Gateway maintenance is in progress" };
      await expect(addProject()).rejects.toMatchObject(maintenance);
      expect(projects).toBe(1);
      expect(relocation.requestsIdle).toBe(false);
      finish.resolve();
      expect(await pending).toHaveLength(1);
      expect(relocation.requestsIdle).toBe(true);

      const previous = new Set(links[computersState].active.get(node));
      computersReconnect(links);

      const reconnected = await eventually(
        async () => [...(links[computersState].active.get(node) ?? [])],
        (active) => active.some((connection) => connection.ready && !previous.has(connection)),
      );

      expect(reconnected.some((connection) => connection.ready && !previous.has(connection))).toBe(true);
      expect(
        await call(ui.GatewayService.method.interruptThread, create(ui.InterruptThreadRequestSchema)),
      ).toHaveLength(1);
      expect(interrupts).toBe(1);
      expect(projects).toBe(1);

      const unpaired = await generateIdentity();
      const client = linkClient(address, home.identity.certificate, unpaired);
      const frames = new AsyncChannel<link.LinkFrame>();
      frames.push(create(link.LinkFrameSchema, { body: { case: "hello", value: { nodeId: unpaired.nodeId } } }));

      try {
        await expect(result(client.connect(frames, { timeoutMs: 5_000 }))).rejects.toMatchObject({
          code: Code.Unauthenticated,
        });
      } finally {
        frames.close();
        client.close();
      }

      await store.query("DELETE FROM gateway_relocation_fence");
      await relocation.refresh();
      expect(await addProject()).toHaveLength(1);
      expect(projects).toBe(2);
    } finally {
      finish.resolve();
      await Promise.allSettled([pending]);
      await peerLinks?.close();
      await peer?.close();
      await home.close();
      await relocation.close();
      await runtime.dispose();
      await pg.stop();
    }
  },
  60_000,
);
