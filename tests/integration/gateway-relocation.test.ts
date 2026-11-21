import "reflect-metadata";
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { GatewayStore, InstanceStore } from "@canopy/gateway/store";
import { tempDir } from "@canopy/testing";
import { openGatewayLink } from "@canopy/worker/gateway-link";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { PgClient } from "@effect/sql-pg";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import {
  abortFence,
  clearImportedFence,
  commitSourceFence,
  readFence,
  requestDrain,
} from "../../apps/gateway/src/migration/relocation-fence.ts";
import { RelocationRuntime } from "../../apps/gateway/src/migration/relocation-fence-runtime.ts";
import { gatewayRuntime } from "../../apps/gateway/src/runtime.ts";
import { eventually, ScriptedWorker, SERVICE_TOKEN } from "./support/gateway.ts";

const ownerEmail = "relocation@example.test";
const key = randomBytes(32).toString("base64");

async function databaseUrl(pg: TestPostgres) {
  const config = await Effect.runPromise(
    PgClient.PgClient.use((sql) => Effect.succeed(sql.config)).pipe(Effect.provide(pg.layer)),
  );

  return `postgres://postgres:test@127.0.0.1:${config.port}/${config.database}`;
}

async function gatewayEnv(pg: TestPostgres, directory: string) {
  return {
    PATH: Bun.env["PATH"],
    HOME: directory,
    CANOPY_RELEASE_BASE_URL: "https://releases.example.test",
    CANOPY_DATABASE_URL: await databaseUrl(pg),
    CANOPY_DEV_USER_EMAIL: ownerEmail,
    CANOPY_UI_SERVICE_TOKEN: SERVICE_TOKEN,
    CANOPY_SECRETS_KEY: key,
    CANOPY_MIGRATE: "0",
    CANOPY_WEB: "off",
    CANOPY_HOST: "127.0.0.1",
    CANOPY_PORT: "0",
    CANOPY_LOG_DIR: join(directory, "logs"),
    CANOPY_UPDATE_CACHE_DIR: join(directory, "updates"),
  };
}

function gatewayClient(url: string) {
  return createClient(
    ui.GatewayService,
    createGrpcTransport({
      baseUrl: url,
      interceptors: [
        (next) => (request) => (request.header.set("authorization", `Bearer ${SERVICE_TOKEN}`), next(request)),
      ],
    }),
  );
}

function startGateway(env: NodeJS.ProcessEnv, preload?: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dir, "support/gateway-relocation-loopback.ts"),
      ...(preload ? ["--preload", preload] : []),
      "apps/gateway/src/main.ts",
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );

  let stdout = "";

  const output = (async () => {
    const decoder = new TextDecoder();

    for await (const part of child.stdout) stdout += decoder.decode(part, { stream: true });
  })();

  const stderr = new Response(child.stderr).text();

  return {
    process: child,
    output,
    stderr,
    stdout: () => stdout,
    url: () => /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(stdout)?.[1],
  };
}

async function listening(source: ReturnType<typeof startGateway>) {
  const { url } = await eventually(
    async () => ({ url: source.url(), exited: source.process.exitCode !== null }),
    (status) => status.url !== undefined || status.exited,
    20_000,
  );

  if (!url) {
    if (source.process.exitCode === null) source.process.kill();
    await source.output;
    throw new Error(`Test gateway did not open its listener. ${source.stdout()} ${await source.stderr}`);
  }

  return url;
}

test.skipIf(!dockerAvailable)(
  "relocation drains the live gateway with its worker link open",
  async () => {
    const pg = await startPostgres({ migrated: true });
    const directory = tempDir("canopy-gateway-relocation-");

    const env = await gatewayEnv(pg, directory);

    const source = startGateway(env);
    let link: Awaited<ReturnType<typeof openGatewayLink>> | undefined;

    try {
      const url = await listening(source);
      const api = gatewayClient(url);

      const credentials = await run(
        env,
        GatewayStore.use((store) =>
          Effect.gen(function* () {
            const ownerUserId = yield* store.ensureUser(ownerEmail, "Relocation");

            const added = yield* store.addWorker({ name: "Scripted relocation worker", ownerUserId });
            yield* store.setWorkerConfig(added.workerId, { codex: { enabled: true } }, ownerUserId);
            yield* InstanceStore.use((instances) => instances.sync(ownerUserId, [added.workerId]));

            return added;
          }),
        ),
      );

      link = await openGatewayLink({
        baseUrl: url,
        credential: credentials.credential,
        hello: { workerId: credentials.workerId, journalId: "move-gateway-journal", scratchRoot: "/worker/scratch" },
      });
      const worker = new ScriptedWorker(link);
      worker.holdTurns = true;

      const modelReady = await eventually(
        () => api.listModels({}),
        (result) =>
          result.workers.some((record) => record.workerId === credentials.workerId && record.configVersion > 0n),
      );

      expect(modelReady.workers.some((record) => record.configVersion > 0n)).toBe(true);
      const project = await api.createProject({ name: "Move gateway" });

      const workspace = await api.createWorkspace({
        projectId: project.project!.id,
        workerId: credentials.workerId,
        rootPath: "/repo/move",
      });

      const { thread } = await api.createThread({
        projectId: project.project!.id,
        workspaceId: workspace.workspace!.id,
        clientRequestId: crypto.randomUUID(),
        provider: Provider.CODEX,
      });

      const threadId = thread!.id;

      const send = (text: string, delivery = ui.MessageDelivery.UNSPECIFIED) =>
        api.sendMessage({ threadId, text, delivery, clientRequestId: crypto.randomUUID() });

      const running = (await send("Active")).turn!;

      const turns = () =>
        run(
          env,
          GatewayStore.use((store) => store.turnsOf(threadId)),
        );

      expect(
        await eventually(turns, (rows) => rows.some((turn) => turn.id === running.id && turn.status === "running")),
      ).toContainEqual(expect.objectContaining({ id: running.id, status: "running" }));
      const queued = (await send("Queued for the new gateway", ui.MessageDelivery.QUEUE)).turn!;

      const operationId = crypto.randomUUID();

      const overviewStatus = () =>
        api.getOverview({}).then(
          () => undefined,
          (error: Error) => ConnectError.from(error).code,
        );

      const waitForMaintenance = () => eventually(overviewStatus, (code) => code === Code.Unavailable);

      // Losing the guard session must leave the gateway and the current WorkerLink alive.
      const terminated = await run(
        env,
        SqlClient.SqlClient.use(
          (sql) => sql<{ terminated: boolean }>`SELECT pg_terminate_backend(pid) AS terminated
            FROM pg_stat_activity WHERE datname = current_database()
              AND application_name = 'canopy-gateway-relocation-guard'`,
        ),
      );

      expect(terminated).toEqual([{ terminated: true }]);
      expect(await waitForMaintenance()).toBe(Code.Unavailable);
      expect(await eventually(overviewStatus, (code) => code === undefined)).toBeUndefined();
      expect(source.process.exitCode).toBeNull();

      await requestDrain(env, operationId);
      expect(await waitForMaintenance()).toBe(Code.Unavailable);
      expect(await readFence(env)).toEqual({ operationId, state: "draining" });
      await abortFence(env, operationId);
      expect(await eventually(overviewStatus, (code) => code === undefined)).toBeUndefined();
      expect(await readFence(env)).toBeUndefined();

      await requestDrain(env, operationId);
      expect(await waitForMaintenance()).toBe(Code.Unavailable);
      expect(
        await send("Arrived during maintenance").then(
          () => null,
          (error: Error) => ConnectError.from(error).code,
        ),
      ).toBe(Code.Unavailable);
      expect(source.process.exitCode).toBeNull();

      worker.finish(threadId, running.id, "Finished on source");
      expect(
        await eventually(
          async () => source.process.exitCode,
          (code) => code !== null,
        ),
      ).toBe(0);
      expect(await readFence(env)).toEqual({ operationId, state: "drained" });
      expect(worker.started.has(queued.id)).toBe(false);
      expect((await turns()).map(({ id, status }) => [id, status])).toEqual([
        [running.id, "completed"],
        [queued.id, "queued"],
      ]);

      expect(await clearImportedFence(env, operationId).catch((error: Error) => error.message)).toContain(
        "cannot be cleared",
      );
      await commitSourceFence(env, operationId);
      expect(await abortFence(env, operationId).catch((error: Error) => error.message)).toContain("cannot be cleared");
      const restart = startGateway({ ...env, CANOPY_MIGRATE: "1" });
      expect(await restart.process.exited).toBe(1);
      expect(await restart.stderr).toContain("Gateway startup blocked by a relocation fence");
      await restart.output;
      expect(restart.url()).toBeUndefined();
    } finally {
      link?.close();

      if (source.process.exitCode === null) source.process.kill();
      await Promise.all([source.process.exited, source.output, source.stderr, link?.closed]);
      await pg.stop();
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable)(
  "the relocation fence closes admission before gateway startup finishes",
  async () => {
    const pg = await startPostgres({ migrated: true });
    const directory = tempDir("canopy-relocation-startup-");
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();

    const barrier = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        reached.resolve();
        await release.promise;

        return new Response(null, { status: 204 });
      },
    });

    let source: ReturnType<typeof startGateway> | undefined;

    try {
      const env = await gatewayEnv(pg, directory);
      const preload = join(directory, "pause-updates-startup.mjs");
      await Bun.write(
        preload,
        `import ${JSON.stringify(import.meta.resolve("reflect-metadata"))};
import { GatewayUpdates } from ${JSON.stringify(import.meta.resolve("../../apps/gateway/src/updates/runtime.ts"))};
const start = GatewayUpdates.prototype.start;
GatewayUpdates.prototype.start = async function () {
  const barrier = await fetch(${JSON.stringify(barrier.url.href)}, { signal: AbortSignal.timeout(30_000) });
  await barrier.body?.cancel();
  await start.call(this);
};`,
      );
      source = startGateway(env, preload);
      const api = gatewayClient(await listening(source));
      await Promise.race([
        reached.promise,
        source.process.exited.then(() => {
          throw new Error("Gateway exited before reaching the updater startup barrier");
        }),
      ]);
      await api.getOverview({});

      const operationId = crypto.randomUUID();
      await requestDrain(env, operationId);
      expect(
        await eventually(
          () =>
            api.getOverview({}).then(
              () => false,
              (error: Error) => ConnectError.from(error).rawMessage === "Gateway maintenance is in progress",
            ),
          Boolean,
        ),
      ).toBe(true);
      expect(source.process.exitCode).toBeNull();
      expect(await readFence(env)).toEqual({ operationId, state: "draining" });

      release.resolve();
      expect(await source.process.exited).toBe(0);
      expect(await readFence(env)).toEqual({ operationId, state: "drained" });
    } finally {
      release.resolve();

      if (source?.process.exitCode === null) source.process.kill();
      await Promise.all([source?.process.exited, source?.output, source?.stderr, barrier.stop(true)]);
      await pg.stop();
    }
  },
  60_000,
);

test.skipIf(!dockerAvailable)(
  "aborting a relocation reports whether the gateway already claimed shutdown",
  async () => {
    const pg = await startPostgres({ migrated: true });

    try {
      const env = { CANOPY_DATABASE_URL: await databaseUrl(pg) };
      const guard = await RelocationRuntime.open(env);

      try {
        const beforeClaim = crypto.randomUUID();
        await requestDrain(env, beforeClaim);
        expect(await guard.refresh()).toBe(true);
        expect(await abortFence(env, beforeClaim)).toEqual({ shuttingDown: false });
        expect(await guard.claimShutdown()).toBe(false);

        const afterClaim = crypto.randomUUID();
        await requestDrain(env, afterClaim);
        expect(await guard.refresh()).toBe(true);
        expect(await guard.claimShutdown()).toBe(true);
        expect(await abortFence(env, afterClaim)).toEqual({ shuttingDown: true });
        expect(await abortFence(env, afterClaim)).toEqual({ shuttingDown: true });
        expect(await readFence(env)).toBeUndefined();
      } finally {
        await guard.close();
      }
    } finally {
      await pg.stop();
    }
  },
  60_000,
);

async function run<A, E>(
  env: NodeJS.ProcessEnv,
  effect: Effect.Effect<A, E, GatewayStore | InstanceStore | SqlClient.SqlClient>,
) {
  const runtime = gatewayRuntime(env, { databaseDiagnostics: false });

  try {
    return await runtime.runPromise(effect);
  } finally {
    await runtime.dispose();
  }
}
