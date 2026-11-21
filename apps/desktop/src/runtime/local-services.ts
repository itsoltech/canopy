import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { freePort, type RuntimePaths, type Secrets } from "./config.ts";
import { startDatabase } from "./database.ts";
import { localGatewayClient, localGatewayEnvironment, localGatewayTarget } from "./gateway-env.ts";
import { gatewayLiveness } from "./liveness.ts";
import {
  PostgresInstaller,
  postgresTestOptions,
  type DatabaseProgress,
  type PostgresTestOptions,
} from "./postgres-install.ts";
import { until, type Supervisor } from "./process.ts";

/** Start the supervised database and pinned gateway before handing the worker its local enrollment. */
interface LocalServices {
  directory: string;
  paths: RuntimePaths;
  env: NodeJS.ProcessEnv;
  secrets: Secrets;
  supervisor: Supervisor;
  webOrigin: string;
  signal: AbortSignal;
  progress: (database: DatabaseProgress | undefined) => void;
  log: (line: string) => void;
  testing: PostgresTestOptions | undefined;
}

export async function startLocalDatabase(options: LocalServices, bootstrap: boolean) {
  const { directory, paths, secrets, env, supervisor, signal, progress } = options;
  const postgres = join(directory, "postgres");

  const installer = new PostgresInstaller(
    paths.postgres,
    postgres,
    progress,
    options.testing ?? postgresTestOptions(),
    options.log,
  );

  const binaries = await installer.ensure(signal);
  progress({ phase: "ready", message: "Starting the local database…" });

  const database = await startDatabase({
    directory: postgres,
    binaries,
    password: secrets.databasePassword,
    ...(bootstrap && {
      bootstrap: { runtimePassword: secrets.runtimeDatabasePassword, gateway: paths.gateway, bun: paths.bun },
    }),
    supervisor,
    env,
  });

  progress(undefined);

  if (bootstrap) installer.cleanup();

  return { ...database, binaries, major: installer.pin.major };
}

export async function startLocalServices(options: LocalServices) {
  const { directory, paths, secrets, env, supervisor, signal } = options;
  const database = await startLocalDatabase(options, true);
  const port = await freePort();
  const { target, certFile, keyFile } = await localGatewayTarget(directory, port, secrets.serviceToken);
  signal.throwIfAborted();
  supervisor.start({
    name: "gateway",
    command: paths.bun,
    args: [paths.gateway],
    cwd: dirname(paths.gateway),
    env: localGatewayEnvironment(env, secrets, {
      databaseUrl: database.runtimeUrl,
      port,
      webOrigin: options.webOrigin,
      certFile,
      keyFile,
    }),
    restart: "continuous",
  });
  const probe = gatewayLiveness(target);
  await until(
    async () => {
      await probe();

      return true;
    },
    60_000,
    () => !signal.aborted,
  );
  const workerDirectory = join(directory, "local-worker");
  let token: string | undefined;

  if (!existsSync(join(workerDirectory, "worker.json")))
    token = (await localGatewayClient(target).createWorkerEnrollment({ name: `Canopy · ${hostname()}` })).token;

  return { target, workerDirectory, token, database };
}
