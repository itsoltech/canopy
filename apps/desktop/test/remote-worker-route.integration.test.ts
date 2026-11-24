import { expect, test } from "bun:test";
import { once } from "node:events";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Code, ConnectError } from "@connectrpc/connect";
import { update } from "@canopy/contracts";
import { tempDirs } from "@canopy/testing";
import { startGrpcServer } from "@canopy/transport";
import { generateIdentity } from "../../gateway/src/computers/identity.ts";
import { createWorkerLink } from "../../gateway/src/worker-link/service.ts";
import { remoteWorkerDirectory } from "../src/remote-client.ts";
import { until } from "../src/runtime/process.ts";
import { DesktopRuntime } from "../src/runtime/runtime.ts";

const temp = tempDirs();

async function workerListener(
  identity: Awaited<ReturnType<typeof generateIdentity>>,
  workerId: string,
  credential: string,
) {
  let authentications = 0;
  let updateWatches = 0;

  const workerLink = createWorkerLink({
    async authenticate(token) {
      authentications++;

      return token === credential ? workerId : undefined;
    },
    welcome: async () => ({ heartbeatIntervalSeconds: 1 }),
  });

  const server = await startGrpcServer({
    tls: { cert: identity.certificate, key: identity.privateKey },
    routes(router) {
      workerLink.routes(router);
      router.service(update.UpdateService, {
        async *watch(request, context) {
          if (request.workerId !== workerId || context.requestHeader.get("authorization") !== `Bearer ${credential}`)
            throw new ConnectError("Invalid worker credential", Code.Unauthenticated);
          updateWatches++;
          yield {};

          if (!context.signal.aborted) await once(context.signal, "abort");
        },
      });
    },
  });

  return {
    ...server,
    authenticated: () => authentications,
    updateWatches: () => updateWatches,
    online: () => workerLink.connections.has(workerId),
  };
}

test("a paired desktop worker keeps its healthy route and reconnects over a verified alternate after loss", async () => {
  const directory = temp("canopy-desktop-worker-route-");
  const identity = await generateIdentity();
  const workerId = crypto.randomUUID();
  const credential = crypto.randomUUID();
  const primary = await workerListener(identity, workerId, credential);
  const alternate = await workerListener(identity, workerId, credential);
  const untrusted = await workerListener(await generateIdentity(), workerId, credential);
  const config = { mode: "remote" as const, gatewayUrl: alternate.url };

  const client = {
    token: `canopy_desktop_${"a".repeat(43)}`,
    deviceId: "route-fixture",
    fingerprint: identity.fingerprint,
    addresses: [untrusted.url, alternate.url, primary.url],
  };

  const profile = remoteWorkerDirectory(directory, config);
  const configPath = join(profile, "worker.json");

  const workerConfig = JSON.stringify({
    gateway_url: primary.url,
    gateway_certificate: identity.certificate,
    gateway_fingerprint: identity.fingerprint,
    worker_id: workerId,
    credential,
    data_dir: join(profile, "data"),
  });

  const web = join(directory, "web.js");
  mkdirSync(profile, { recursive: true });
  writeFileSync(configPath, workerConfig, { mode: 0o600 });
  writeFileSync(web, "export const handler = (_request, response) => response.end();");

  const launch = () =>
    new DesktopRuntime(
      directory,
      {
        bun: process.execPath,
        web,
        worker: join(import.meta.dir, "../src/sidecars/worker.ts"),
        gateway: "",
        postgres: "",
      },
      {
        databasePassword: "fixture",
        runtimeDatabasePassword: "fixture",
        secretsKey: "fixture",
        serviceToken: "fixture",
      },
    );

  let desktop = launch();
  let primaryClosed = false;

  try {
    await desktop.initialize(false);
    await desktop.configure(config, client);
    await until(async () => primary.online() && primary.updateWatches() > 0);
    expect(alternate.authenticated()).toBe(0);
    expect(alternate.updateWatches()).toBe(0);

    await primary.close(0);
    primaryClosed = true;
    await until(async () => alternate.online() && alternate.updateWatches() > 0);
    expect(alternate.authenticated()).toBeGreaterThanOrEqual(2); // ProbeNetworkRoute and WorkerLink.
    expect(untrusted.authenticated()).toBe(0);
    expect(untrusted.updateWatches()).toBe(0);
    expect(readFileSync(configPath, "utf8") === workerConfig).toBe(true);

    await desktop.stop();
    await until(async () => !alternate.online());
    const watches = alternate.updateWatches();
    desktop = launch();
    await desktop.initialize(false);
    await desktop.restore(client);
    await until(async () => alternate.online() && alternate.updateWatches() > watches);
    expect(untrusted.authenticated()).toBe(0);
    expect(readFileSync(configPath, "utf8") === workerConfig).toBe(true);
  } finally {
    await desktop.stop();
    await Promise.all([primaryClosed ? undefined : primary.close(0), alternate.close(0), untrusted.close(0)]);
  }
}, 90_000);
