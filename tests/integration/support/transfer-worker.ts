import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { THREAD_TRANSFER_CAPABILITY, THREAD_WORKTREE_SWITCH_CAPABILITY } from "@canopy/domain/release/protocol";
import { GatewayStore } from "@canopy/gateway/store";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { eventually, type TestGateway } from "./gateway.ts";

/**
 * A real worker (Git, worktrees, thread transfers) with the Codex wire fixture, linked to a test gateway: the two
 * ends of moving a thread with its session and files (docs/thread-transfers.md).
 */

const codex = fileURLToPath(new URL("../fixtures/instance-codex.ts", import.meta.url));

const CAPABILITIES = [
  "worktrees",
  "worktree_lifecycle",
  "workspace_origin",
  "git_worktree_discovery",
  "git_heads",
  "git_status_v1",
  THREAD_WORKTREE_SWITCH_CAPABILITY,
  THREAD_TRANSFER_CAPABILITY,
];

export async function startWorker(gw: TestGateway, dir: string, name: string) {
  const data = join(dir, "data");
  const home = join(dir, "codex-home");
  mkdirSync(data, { recursive: true });
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "fixture" } }));
  const added = await gw.addWorker(name);
  await gw.runtime.runPromise(
    GatewayStore.use((s) =>
      s.setWorkerConfig(
        added.workerId,
        { codex: { enabled: true, executablePath: codex }, claude: { enabled: false } },
        gw.userId,
      ),
    ),
  );
  const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));

  const host = new WorkerHost({
    runtime,
    dataDir: data,
    clientVersion: "test",
    deviceHomes: { codex: home, claude: join(dir, "claude") },
  });

  const link: GatewayLink = await openGatewayLink({
    baseUrl: gw.grpcUrl,
    credential: added.credential,
    hello: {
      workerId: added.workerId,
      host: { os: process.platform },
      homeDirectory: homedir(),
      capabilities: CAPABILITIES,
      worktreesRoot: host.worktreesRoot,
      attachmentsRoot: host.attachmentsRoot,
      ...(await runtime.runPromise(journalHello())),
    },
  });

  const serving = serveLink(link, host, runtime).catch(() => undefined);
  await eventually(
    () => gw.api.getOverview({}),
    (o) => o.workers.some((w) => w.id === added.workerId && w.appliedVersion > 0n && w.online),
  );

  return {
    workerId: added.workerId,
    data,
    home,
    close: async () => {
      link.close();
      await host.close();
      await serving;
      await runtime.dispose();
    },
  };
}
