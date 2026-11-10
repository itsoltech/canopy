import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { GatewayStore } from "@canopy/gateway/store";
import { Journal } from "@canopy/worker/journal";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { WorkerHost, serveLink } from "@canopy/worker/runtime";
import { eventually, type startTestGateway } from "./gateway.ts";

/** A second real worker of an existing gateway; all filesystem and harness data stay in the fixture. */
export async function workspaceWorker(
  gateway: Awaited<ReturnType<typeof startTestGateway>>,
  dir: string,
  name = "Second worker",
  copy = true,
) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture" } }));
  const executable = join(dir, "codex");
  copyFileSync(new URL("../fixtures/directory-codex.ts", import.meta.url), executable);
  chmodSync(executable, 0o755);
  const worker = await gateway.addWorker(name);
  await gateway.runtime.runPromise(
    GatewayStore.use((store) =>
      store.setWorkerConfig(
        worker.workerId,
        {
          codex: { enabled: true, executablePath: executable },
          claude: { enabled: false },
        },
        gateway.userId,
      ),
    ),
  );
  const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));

  const host = new WorkerHost({
    runtime,
    dataDir: dir,
    clientVersion: "test",
    deviceHomes: { codex: dir, claude: dir },
  });

  const link = await openGatewayLink({
    baseUrl: gateway.grpcUrl,
    credential: worker.credential,
    hello: {
      workerId: worker.workerId,
      host: { os: process.platform },
      homeDirectory: dir,
      capabilities: [
        "workspace_origin",
        "workspace_clone_source",
        "project_sources",
        "worktrees",
        ...(copy ? ["workspace_copy_v1"] : []),
      ],
      ...(await runtime.runPromise(journalHello())),
    },
  });

  const serving = serveLink(link, host, runtime).catch(() => {});
  await eventually(
    () => gateway.api.getOverview({}),
    (o) => o.workers.some((w) => w.id === worker.workerId && w.online && w.appliedVersion > 0n),
  );

  return {
    workerId: worker.workerId,
    host,
    dir,
    link,
    close: async () => {
      link.close();
      await host.close();
      await serving;
      await runtime.dispose();
    },
  };
}
