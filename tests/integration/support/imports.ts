import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GatewayStore } from "@canopy/gateway/store";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { installFixtureHome, type FixtureCli } from "../../../apps/worker/src/import/fixtures/install.ts";
import { eventually, startTestGateway, type TestGateway } from "./gateway.ts";

/**
 * CLI import end to end (docs/import.md): PostgreSQL, the gateway and a real WorkerHost whose device CLI homes are
 * the generated fixtures in a temporary HOME. No model provider is contacted.
 */
export async function importFixture(
  dir: string,
  options: { clis?: readonly FixtureCli[]; gateway?: TestGateway } = {},
) {
  const home = join(dir, "home");
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  installFixtureHome(home, options.clis);
  const gw = options.gateway ?? (await startTestGateway());
  const worker = await gw.addWorker("Import laptop");
  const workerId = worker.workerId;
  await gw.runtime.runPromise(
    GatewayStore.use((s) =>
      s.setWorkerConfig(
        workerId,
        { codex: { enabled: false }, claude: { enabled: false }, grok: { enabled: false } },
        gw.userId,
      ),
    ),
  );
  const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));

  const host = new WorkerHost({
    runtime,
    dataDir: data,
    clientVersion: "test",
    deviceHomes: { claude: join(home, ".claude"), codex: join(home, ".codex"), grok: join(home, ".grok") },
  });

  let link: GatewayLink | undefined;

  const connect = async () => {
    link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: worker.credential,
      hello: {
        workerId,
        host: { os: process.platform },
        homeDirectory: homedir(),
        capabilities: ["cli_import_v1"],
        ...(await runtime.runPromise(journalHello())),
      },
    });
    void serveLink(link, host, runtime);
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.some((w) => w.id === workerId && w.online && w.appliedVersion > 0n),
    );
  };

  await connect();

  return {
    gw,
    home,
    data,
    host,
    workerId,
    connect,
    sql: <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, use)),
    disconnect: () => link?.close(),
    async close() {
      link?.close();
      await host.close();
      await runtime.dispose();

      if (!options.gateway) await gw.close();
    },
  };
}
