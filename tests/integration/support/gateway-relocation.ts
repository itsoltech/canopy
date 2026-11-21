import { randomBytes } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { createClient } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { dockerAvailable, startPostgres, type TestPostgres } from "@canopy/db/testing";
import { createGrpcClientTransport } from "@canopy/transport";
import { PgClient } from "@effect/sql-pg";
import { Effect, ManagedRuntime } from "effect";
import { healthcheck } from "../../../apps/gateway/src/healthcheck.ts";
import { bun, gatewayCommand, relocationEntry } from "./gateway-relocation-entry.ts";
import { loopbackPort, relocationSsh } from "./gateway-relocation-ssh.ts";

const tools = ["flock", "ssh", "ssh-keygen", "sshd", "psql", "pg_dump", "pg_restore", "false"];

const postgresMajor = (tool: string) => {
  const result = Bun.spawnSync([tool, "--version"], { stderr: "ignore" });

  return Number(/\(PostgreSQL\) (\d+)/.exec(result.stdout.toString())?.[1]);
};

export const relocationAvailable =
  process.env["CANOPY_LIVE"] === "1" &&
  process.platform === "linux" &&
  dockerAvailable &&
  tools.every((tool) => Bun.which(tool)) &&
  ["psql", "pg_dump", "pg_restore"].every((tool) => postgresMajor(tool) >= 17);

export function privateFile(path: string, value: string) {
  return writeFile(path, value, { mode: 0o600 });
}

async function databaseUrl(db: TestPostgres) {
  const runtime = ManagedRuntime.make(db.layer);

  try {
    const { database, port } = await runtime.runPromise(
      PgClient.PgClient.use((client) => Effect.succeed(client.config)),
    );

    return `postgres://postgres:test@127.0.0.1:${port}/${database}`;
  } finally {
    await runtime.dispose();
  }
}

function command(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  const child = Bun.spawn(args, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(timeoutMs && { timeout: timeoutMs, killSignal: "SIGKILL" }),
  });

  const result = Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]).then(
    ([code, stdout, stderr]) => ({ code, stdout, stderr }),
  );

  return { child, result };
}

type HostOptions = { migrated?: boolean; secretsKey?: string; major?: 17 | 18; ownerEmail?: string };

type HostConfig = {
  stateDirectory: string;
  environmentFile: string;
  secretFile: string;
  service: Record<"start" | "stop" | "ready" | "stopped", string[]>;
};

async function provisionHost(
  directory: string,
  path: string,
  socket: string,
  name: string,
  options: HostOptions,
  db: TestPostgres,
) {
  const stateDirectory = join(directory, "state");
  const environmentFile = join(directory, "base.env");
  const secretFile = join(stateDirectory, "gateway-secrets.env");
  const configPath = join(directory, "target.json");
  const gatewayPort = loopbackPort();
  const networkPort = loopbackPort();
  const serviceToken = randomBytes(32).toString("hex");

  const env = {
    PATH: path,
    HOME: directory,
    TMPDIR: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_STATE_HOME: join(directory, "logs"),
    XDG_DATA_HOME: join(directory, "data"),
    CANOPY_INSTALL_KIND: "source",
    CANOPY_DATABASE_URL: await databaseUrl(db),
    CANOPY_DEV_USER_EMAIL: options.ownerEmail ?? "relocation@example.test",
    CANOPY_HOST: "127.0.0.1",
    CANOPY_PORT: String(gatewayPort),
    CANOPY_NETWORK_PORT: String(networkPort),
    CANOPY_UI_SERVICE_TOKEN: serviceToken,
    CANOPY_WEB: "off",
    CANOPY_MIGRATE: "0",
    CANOPY_MIGRATION_TARGET_CONFIG: configPath,
    ...(options.secretsKey && { CANOPY_SECRETS_KEY: options.secretsKey }),
  };

  const hook = (action: string) => [...bun, relocationEntry, "service", socket, `${name}/${action}`];

  const config: HostConfig = {
    stateDirectory,
    environmentFile,
    secretFile,
    service: { start: hook("start"), stop: hook("stop"), ready: hook("ready"), stopped: hook("stopped") },
  };

  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  await privateFile(
    environmentFile,
    Object.entries(env)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}\n`)
      .join(""),
  );
  await privateFile(configPath, JSON.stringify(config));

  return gatewayService(directory, configPath, env, config, db, serviceToken);
}

function gatewayService(
  directory: string,
  configPath: string,
  env: NodeJS.ProcessEnv,
  config: HostConfig,
  db: TestPostgres,
  serviceToken: string,
) {
  const grpcUrl = `http://127.0.0.1:${env["CANOPY_PORT"]}`;
  const networkUrl = `https://127.0.0.1:${env["CANOPY_NETWORK_PORT"]}`;

  const api = createClient(
    ui.GatewayService,
    createGrpcClientTransport({
      baseUrl: grpcUrl,
      defaultTimeoutMs: 3_000,
      interceptors: [
        (next) => (request) => {
          request.header.set("authorization", `Bearer ${serviceToken}`);

          return next(request);
        },
      ],
    }),
  );

  let gateway: ReturnType<typeof command> | undefined;
  let starts = 0;
  const commands = new Set<ReturnType<typeof command>>();
  const stopped = () => !gateway || gateway.child.exitCode !== null || gateway.child.signalCode !== null;
  const ready = async () => !stopped() && (await healthcheck(env)) === 0;

  async function start() {
    if (!stopped()) return;
    const key = env["CANOPY_SECRETS_KEY"] ? {} : parseEnv(await readFile(config.secretFile, "utf8"));

    if (!stopped()) return;
    starts++;
    const process = command(gatewayCommand, { ...env, ...key }, 0);
    gateway = process;
    const deadline = performance.now() + 15_000;

    while (!(await ready())) {
      if (stopped()) {
        const { code, stderr, stdout } = await process.result;
        throw new Error(`Gateway exited during startup (${code})\n${stderr}\n${stdout}`);
      }

      if (performance.now() >= deadline) throw new Error("Gateway did not become ready");
      await Bun.sleep(50);
    }
  }

  async function stop() {
    const process = gateway;

    if (!process) return;

    if (!stopped()) {
      process.child.kill("SIGTERM");
      const forced = setTimeout(() => process.child.kill("SIGKILL"), 8_000);

      try {
        await process.result;
      } finally {
        clearTimeout(forced);
      }
    } else await process.result;
  }

  return {
    directory,
    env,
    config,
    configPath,
    db,
    api,
    grpcUrl,
    networkUrl,
    start,
    stop,
    stopped,
    ready,
    get starts() {
      return starts;
    },
    async command(args: string[], overrides?: NodeJS.ProcessEnv) {
      const task = command([...gatewayCommand, ...args], { ...env, ...overrides }, 85_000);
      commands.add(task);

      try {
        return await task.result;
      } finally {
        commands.delete(task);
      }
    },
    async settleCommands() {
      await Promise.all([...commands].map((task) => task.result));
    },
  };
}

export type RelocationHost = Awaited<ReturnType<typeof provisionHost>>;

/** Real gateway services with their own database, ports, keys, config and state directory per host. */
export async function createRelocationSandbox(directory: string) {
  const path = join(directory, "bin");
  await mkdir(path, { mode: 0o700 });

  for (const tool of ["ssh", "psql", "pg_dump", "pg_restore", "flock", "false"]) {
    const location = Bun.which(tool);

    if (!location) throw new Error(`Relocation fixtures require ${tool}`);
    await symlink(location, join(path, tool === "false" ? "tailscale" : tool));
  }

  const hosts = new Map<string, RelocationHost>();
  const databases: TestPostgres[] = [];
  const sshServers: Awaited<ReturnType<typeof relocationSsh>>[] = [];
  const socket = join(directory, "supervisor.sock");

  const supervisor = Bun.serve({
    unix: socket,
    async fetch(request) {
      const [, name, action] = new URL(request.url).pathname.split("/");
      const host = hosts.get(name ?? "");

      if (request.method !== "POST" || !host) return new Response(null, { status: 404 });

      if (action === "start") await host.start();
      else if (action === "stop") await host.stop();
      else if (action === "ready") return new Response(null, { status: (await host.ready()) ? 204 : 409 });
      else if (action === "stopped") return new Response(null, { status: host.stopped() ? 204 : 409 });
      else return new Response(null, { status: 404 });

      return new Response(null, { status: 204 });
    },
  });

  return {
    async host(name: string, options: HostOptions = {}) {
      if (!/^[a-z][a-z0-9-]*$/.test(name) || hosts.has(name)) throw new Error("Use a unique fixture host name");

      const db = await startPostgres({
        migrated: options.migrated ?? false,
        ...(options.major && { major: options.major }),
      });

      databases.push(db);
      const host = await provisionHost(join(directory, name), path, socket, name, options, db);
      hosts.set(name, host);

      return host;
    },
    async ssh(target: RelocationHost) {
      const server = await relocationSsh(join(target.directory, "ssh"), target.config.environmentFile);
      sshServers.push(server);

      return server;
    },
    async close() {
      // An in-flight source command may still start the target through SSH.
      const results = await Promise.allSettled([...hosts.values()].map((host) => host.settleCommands()));
      results.push(...(await Promise.allSettled(sshServers.map((server) => server.close()))));
      results.push(...(await Promise.allSettled([...hosts.values()].map((host) => host.stop()))));
      await supervisor.stop(true);
      results.push(...(await Promise.allSettled(databases.map((database) => database.stop()))));
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));

      if (failures.length) throw new AggregateError(failures, "Relocation fixture cleanup failed");
    },
  };
}
