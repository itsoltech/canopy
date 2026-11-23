import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { GatewayStore } from "@canopy/gateway/store";
import { Journal } from "@canopy/worker/journal";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { WorkerHost, serveLink } from "@canopy/worker/runtime";
import { eventually, type TestGateway } from "./gateway.ts";
import { codexFixtureHomes } from "./codex-device.ts";

/**
 * A real worker for workspace copies that can restart its process (same data directory) and reconnect to a
 * restarted gateway with the same credential.
 */
export async function copyWorker(gateway: TestGateway, dir: string, name: string) {
  const deviceHomes = codexFixtureHomes(dir);
  const executable = join(dir, "codex");
  copyFileSync(new URL("../fixtures/directory-codex.ts", import.meta.url), executable);
  chmodSync(executable, 0o755);
  const worker = await gateway.addWorker(name);
  await gateway.runtime.runPromise(
    GatewayStore.use((store) =>
      store.setWorkerConfig(
        worker.workerId,
        { codex: { enabled: true, executablePath: executable }, claude: { enabled: false } },
        gateway.userId,
      ),
    ),
  );
  const data = join(dir, ".worker");
  mkdirSync(data, { recursive: true });
  const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));

  const start = () => new WorkerHost({ runtime, dataDir: data, clientVersion: "test", deviceHomes });

  let host = start();
  let link: GatewayLink | undefined;
  let serving: Promise<void> = Promise.resolve();
  let current = gateway;

  const connect = async (to: TestGateway) => {
    current = to;
    link = await openGatewayLink({
      baseUrl: to.grpcUrl,
      credential: worker.credential,
      hello: {
        workerId: worker.workerId,
        host: { os: process.platform },
        homeDirectory: dir,
        capabilities: [
          "workspace_origin",
          "project_sources",
          "workspace_copy_v1",
          "workspace_copy_scope_v2",
          "workspace_copy_batch_v3",
        ],
        ...(await runtime.runPromise(journalHello())),
      },
    });
    serving = serveLink(link, host, runtime).then(
      () => {},
      () => {},
    );
    await eventually(
      () => to.api.getOverview({}),
      (o) => o.workers.some((w) => w.id === worker.workerId && w.online && w.appliedVersion > 0n),
    );
  };

  const disconnect = async () => {
    link?.close();
    await serving;
  };

  await connect(gateway);

  return {
    workerId: worker.workerId,
    dir,
    /** A new worker process on the same data directory. */
    restart: async () => {
      await disconnect();
      await host.close();
      host = start();
      await connect(current);
    },
    /** The same process connects to another (restarted) gateway. */
    reconnect: async (to: TestGateway) => {
      await disconnect();
      await connect(to);
    },
    disconnect,
    close: async () => {
      await disconnect();
      await host.close();
      await runtime.dispose();
    },
  };
}
