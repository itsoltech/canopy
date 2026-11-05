import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import { ItemDeltaField, WorkerState, update } from "@canopy/contracts";
import { createWorkerLink, type WorkerConnection } from "@canopy/gateway/worker-link";
import { AsyncChannel, startGrpcServer } from "@canopy/transport";
import { tempDir } from "@canopy/testing";
import { Journal } from "@canopy/worker/journal";
import { ManagedRuntime } from "effect";
import { startGateway } from "./helpers.ts";

const dir = tempDir("canopy-worker-shutdown-");
const reconnectDir = tempDir("canopy-worker-reconnect-stop-");

test("idle worker exits promptly on SIGTERM after the gateway acknowledges its journal", async () => {
  const workerId = Bun.randomUUIDv7();
  const credential = "test-shutdown-credential";
  const executable = join(dir, "codex");
  copyFileSync(resolve("tests/integration/fixtures/directory-codex.ts"), executable);
  chmodSync(executable, 0o700);
  const connected = Promise.withResolvers<WorkerConnection>();
  const watching = Promise.withResolvers<void>();

  const link = createWorkerLink({
    authenticate: async (value) => (value === credential ? workerId : undefined),
    welcome: async () => ({ heartbeatIntervalSeconds: 15 }),
    onConnected: connected.resolve,
    config: async () => ({
      version: 1n,
      claude: { enabled: false },
      grok: { enabled: false },
      codex: { enabled: true, executablePath: executable, linkDeviceLogin: false },
    }),
  });

  const server = await startGrpcServer({
    routes: (router) => {
      link.routes(router);
      router.service(update.UpdateService, {
        watch: async function* (_request, ctx) {
          const events = new AsyncChannel<update.UpdateEvent>();
          ctx.signal.addEventListener("abort", () => events.close(), { once: true });
          yield create(update.UpdateEventSchema, {});
          watching.resolve();
          yield* events;
        },
      });
    },
  });

  const path = join(dir, "journal.db");
  const seed = ManagedRuntime.make(Journal.layer(path));
  await seed.runPromise(
    Journal.use((j) =>
      j.append("shutdown-thread", {
        body: { case: "itemDelta", value: { itemId: "message", field: ItemDeltaField.TEXT, chunk: "durable" } },
      }),
    ),
  );
  await seed.dispose();
  const config = join(dir, "worker.json");
  writeFileSync(config, JSON.stringify({ gateway_url: server.url, worker_id: workerId, credential, data_dir: dir }), {
    mode: 0o600,
  });

  const child = Bun.spawn([process.execPath, "apps/worker/src/main.ts", "--config", config], {
    // The binary watchdog now adds IPC; closing it must not hold a gracefully stopped worker alive.
    ipc: () => {},
    env: {
      ...process.env,
      CODEX_HOME: join(dir, "device-codex"),
      CLAUDE_CONFIG_DIR: join(dir, "device-claude"),
      CANOPY_WORKTREES_ROOT: join(dir, "worktrees"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = new Response(child.stdout).text();
  const errors = new Response(child.stderr).text();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 12_000);

  try {
    const connection = await connected.promise;
    const received = Promise.withResolvers<void>();
    const configured = Promise.withResolvers<void>();
    let seq = 0n;

    const pump = (async () => {
      for await (const message of connection.messages) {
        if (message.payload.case === "configApplied") configured.resolve();

        if (message.payload.case === "threadEvent") {
          expect(message.payload.value.body.case).toBe("itemDelta");
          seq = message.payload.value.journalSeq;
          received.resolve();
        }

        // Hold the ack until shutdown: the flush must keep serving incoming acknowledgements.
        if (message.payload.case === "heartbeat" && message.payload.value.state === WorkerState.DRAINING) {
          connection.send({ case: "eventAck", value: { threadId: "shutdown-thread", ackSeq: seq } });
        }
      }
    })();

    await received.promise;
    await watching.promise;
    await configured.promise;
    const started = performance.now();
    child.kill("SIGTERM");
    const code = await child.exited;
    const elapsed = performance.now() - started;
    console.info(`worker SIGTERM exit: ${Math.round(elapsed)}ms; code ${code}\n${await output}${await errors}`);
    expect(code).toBe(0);
    expect(elapsed).toBeLessThan(2_000);
    await pump;
    const journal = ManagedRuntime.make(Journal.layer(path));

    try {
      expect(await journal.runPromise(Journal.use((j) => j.cursors()))).toEqual([]);
    } finally {
      await journal.dispose();
    }
  } finally {
    clearTimeout(deadline);

    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await link.shutdown();
    await server.close();
  }
}, 20_000);

test("SIGTERM interrupts a gateway-requested reconnect delay", async () => {
  const data = reconnectDir;
  const workerId = Bun.randomUUIDv7();
  const credential = "test-reconnect-credential";

  const gateway = await startGateway({
    link: { authenticate: async (value) => (value === credential ? workerId : undefined) },
  });

  const config = join(data, "worker.json");
  writeFileSync(
    config,
    JSON.stringify({ gateway_url: gateway.server.url, worker_id: workerId, credential, data_dir: data }),
    { mode: 0o600 },
  );

  const child = Bun.spawn([process.execPath, "apps/worker/src/main.ts", "--config", config], {
    env: { ...process.env, CANOPY_WORKTREES_ROOT: join(data, "worktrees") },
    stdout: "pipe",
    stderr: "pipe",
  });

  const errors = new Response(child.stderr).text();
  const deadline = setTimeout(() => child.kill("SIGKILL"), 12_000);

  try {
    const connection = await gateway.nextConnection();
    connection.send({ case: "drain", value: { reason: "shutdown test", reconnectAfterMs: 8_000 } });
    connection.close();
    const reader = child.stdout.getReader();
    let output = "";

    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) throw new Error(`worker exited before drain: ${await errors}`);
      output += new TextDecoder().decode(chunk.value);

      if (output.includes("gateway draining")) break;
    }

    reader.releaseLock();
    await Bun.sleep(50);
    const started = performance.now();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    const elapsed = performance.now() - started;
    console.info(`worker SIGTERM during reconnect delay: ${Math.round(elapsed)}ms`);
    expect(elapsed).toBeLessThan(2_000);
  } finally {
    clearTimeout(deadline);

    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await gateway.link.shutdown();
    await gateway.server.close();
  }
}, 20_000);
