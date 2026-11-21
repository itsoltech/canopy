import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ItemDeltaField, type ThreadEvent } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { startGrpcServer } from "@canopy/transport";
import { Effect, Result } from "effect";
import { createWorkerLink, type WorkerLink } from "../../gateway/src/worker-link/service.ts";
import { parseLocalConfig, type LocalConfig } from "../../worker/src/config/local.ts";
import { Journal } from "../../worker/src/journal/journal.ts";
import { remoteWorkerDirectory } from "../src/remote-client.ts";
import { localGatewayTarget } from "../src/runtime/gateway-env.ts";
import { Logs } from "../src/runtime/log.ts";
import { handoffDesktopWorker } from "../src/runtime/migration-worker.ts";
import { Supervisor, until } from "../src/runtime/process.ts";
import { startDesktopWorker } from "../src/runtime/worker-runtime.ts";

const temp = tempDirs();

async function fixture() {
  const directory = temp("canopy-desktop-worker-handoff-");
  const local = join(directory, "local-worker");
  const data = join(local, "data");
  const sourcePath = join(local, "worker.json");
  const marker = join(local, "migration-handoff.json");
  const workspace = join(data, "worktrees", "original");
  const cli = join(data, "codex-home", "sessions");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(workspace, "file.txt"), "workspace");
  writeFileSync(join(cli, "existing.jsonl"), "session");

  const config: LocalConfig = {
    worker_id: crypto.randomUUID(),
    credential: `test-worker-${crypto.randomUUID()}`,
    data_dir: data,
    gateway_url: "http://127.0.0.1:1",
    gateway_fallback: { gateway_url: "http://127.0.0.1:2" },
    trusted_http_origin: "http://127.0.0.1:2",
    ca_file: "old-ca.pem",
    ping_interval_seconds: 17,
    full_access: false,
  };

  const source = JSON.stringify(config);
  writeFileSync(sourcePath, source, { mode: 0o600 });

  const { journalId, event } = await Effect.runPromise(
    Journal.use((journal) =>
      Effect.gen(function* () {
        const event = yield* journal.append("test-thread", {
          turnId: "test-turn",
          body: { case: "itemDelta", value: { itemId: "test-item", field: ItemDeltaField.TEXT, chunk: "durable" } },
        });

        return { journalId: journal.journalId, event };
      }),
    ).pipe(Effect.provide(Journal.layer(join(data, "journal.db")))),
  );

  return { directory, config, source, sourcePath, marker, journalId, event, workspace, cli };
}

async function listen(link: WorkerLink) {
  const { target, keyFile } = await localGatewayTarget(temp("canopy-desktop-handoff-tls-"), 0, "unused-test-token");

  const server = await startGrpcServer({
    tls: { cert: target.certificate, key: readFileSync(keyFile) },
    routes: link.routes,
  });

  return { ...server, fingerprint: target.fingerprint };
}

test("the restarted Remote worker replays the original journal after an interrupted handoff", async () => {
  const { directory, config, source, sourcePath, marker, journalId, event, workspace, cli } = await fixture();
  let received: ThreadEvent | undefined;

  const link = createWorkerLink({
    authenticate: async (credential) => (credential === config.credential ? config.worker_id : undefined),
    welcome: async () => ({ heartbeatIntervalSeconds: 1 }),
    onMessage: (connection, message) => {
      if (message.payload.case !== "threadEvent") return false;
      received = message.payload.value;
      connection.send({ case: "eventAck", value: { threadId: received.threadId, ackSeq: received.journalSeq } });

      return true;
    },
  });

  const target = await listen(link);
  const logs = new Logs(join(directory, "logs"));
  const services = new Supervisor(logs);

  const options = {
    directory,
    // The stable vault/profile key can differ from the live endpoint selected by the probe.
    workerGatewayUrl: "https://bootstrap.invalid:9443",
    routes: { fingerprint: target.fingerprint, addresses: [target.url] },
    assertStopped: async () => {
      if (services.pids.length) throw new Error("Worker is still running");
    },
  };

  let prepared: Awaited<ReturnType<typeof handoffDesktopWorker>>;

  try {
    const workerDirectory = remoteWorkerDirectory(directory, { mode: "remote", gatewayUrl: options.workerGatewayUrl });
    mkdirSync(workerDirectory, { recursive: true });
    const vault = join(workerDirectory, "desktop-client.enc");
    writeFileSync(vault, "existing vault ciphertext");
    prepared = await handoffDesktopWorker(options);
    expect(prepared).toEqual({
      workerId: config.worker_id,
      workerDirectory,
      workerGatewayUrl: options.workerGatewayUrl,
      gatewayUrl: target.url,
    });
    expect(link.connections.size).toBe(0);

    const configPath = join(prepared.workerDirectory, "worker.json");
    const original = readFileSync(configPath, "utf8");
    const migrated = Result.getOrThrow(parseLocalConfig(original));
    expect(migrated.credential === config.credential).toBe(true);
    expect(migrated).toMatchObject({
      data_dir: config.data_dir,
      gateway_url: target.url,
      gateway_fingerprint: target.fingerprint,
      ping_interval_seconds: 17,
      full_access: false,
    });
    expect(migrated.ca_file).toBeUndefined();
    expect(migrated.gateway_fallback).toBeUndefined();
    expect(migrated.trusted_http_origin).toBeUndefined();

    // Recreate the state after the binding was synced but before worker.json was published.
    expect(existsSync(marker)).toBe(true);
    rmSync(configPath);
    await expect(handoffDesktopWorker({ ...options, workerGatewayUrl: target.url })).rejects.toThrow(
      "different handoff",
    );
    expect(await handoffDesktopWorker(options)).toEqual(prepared);
    expect(readFileSync(configPath, "utf8") === original).toBe(true);

    if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600);

    const worker = await startDesktopWorker({
      directory: workerDirectory,
      gatewayUrl: target.url,
      local: undefined,
      logs,
      services,
      bun: process.execPath,
      entry: join(import.meta.dir, "../src/sidecars/worker.ts"),
      env: {
        PATH: process.env["PATH"],
        SYSTEMROOT: process.env["SYSTEMROOT"],
        OS: process.env["OS"],
        HOME: directory,
        USERPROFILE: directory,
        CANOPY_INSTALL_KIND: "desktop",
        CANOPY_BENCH_WORKER_DIAGNOSTICS: "0",
        CANOPY_WORKTREES_ROOT: join(directory, "worktrees"),
      },
    });

    expect(worker?.workerId).toBe(config.worker_id);
    await until(async () => received?.eventId === event.eventId, 15_000);
    expect(received).toEqual(event);
    expect(link.connections.get(config.worker_id)?.hello.journalId).toBe(journalId);
    expect(readFileSync(sourcePath, "utf8") === source).toBe(true);
    expect(readFileSync(join(workspace, "file.txt"), "utf8")).toBe("workspace");
    expect(readFileSync(join(cli, "existing.jsonl"), "utf8")).toBe("session");
    expect(readFileSync(vault, "utf8")).toBe("existing vault ciphertext");
    expect(existsSync(join(workerDirectory, "data"))).toBe(false);
  } finally {
    await services.stop();
    await link.shutdown();
    await target.close(0);
  }

  expect(await handoffDesktopWorker(options)).toEqual(prepared);
}, 45_000);

test("handoff leaves both profiles untouched when the pin, worker record, or lifecycle fence fails", async () => {
  const { directory, config, source, sourcePath, marker } = await fixture();
  let restoredId = config.worker_id;
  let probes = 0;

  const link = createWorkerLink({
    authenticate: async (credential) => {
      probes++;

      return credential === config.credential ? restoredId : undefined;
    },
    welcome: async () => ({}),
  });

  const target = await listen(link);

  const options = {
    directory,
    workerGatewayUrl: target.url,
    routes: { fingerprint: target.fingerprint, addresses: [target.url] },
    assertStopped: () => {},
  };

  const remoteDirectory = remoteWorkerDirectory(directory, { mode: "remote", gatewayUrl: target.url });

  try {
    const stoppedError = await handoffDesktopWorker({
      ...options,
      assertStopped: async () => {
        if (probes > 0) throw new Error("Lifecycle fence lost");
      },
    }).catch((cause: Error) => cause.message);

    expect(stoppedError).toBe("Lifecycle fence lost");
    const wrongPin = { ...options, routes: { ...options.routes, fingerprint: "0".repeat(64) } };
    await expect(handoffDesktopWorker(wrongPin)).rejects.toThrow("No pinned target route");
    expect(probes).toBe(1);
    restoredId = crypto.randomUUID();
    await expect(handoffDesktopWorker(options)).rejects.toThrow("No pinned target route");
    expect(probes).toBe(2);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(remoteDirectory)).toBe(false);

    mkdirSync(remoteDirectory, { recursive: true });
    const occupied = join(remoteDirectory, "worker.json");
    const otherWorker = JSON.stringify({ ...config, worker_id: crypto.randomUUID() });
    writeFileSync(occupied, otherWorker, { mode: 0o600 });
    await expect(handoffDesktopWorker(options)).rejects.toThrow("different worker configuration");
    expect(readFileSync(occupied, "utf8") === otherWorker).toBe(true);
    expect(readFileSync(sourcePath, "utf8") === source).toBe(true);
    expect(existsSync(marker)).toBe(false);
  } finally {
    await link.shutdown();
    await target.close(0);
  }
});
