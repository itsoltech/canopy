import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join } from "node:path";
import { GatewayStore } from "@canopy/gateway/store";
import { journalHello, openGatewayLink, type GatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { serveLink, WorkerHost } from "@canopy/worker/runtime";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import {
  installFixtureHome,
  installLibraryFixture,
  type FixtureCli,
} from "../../../apps/worker/src/import/fixtures/install.ts";
import { eventually, startTestGateway, watchUntil, type TestGateway } from "./gateway.ts";

/**
 * CLI import end to end (docs/import.md): PostgreSQL, the gateway and a real WorkerHost whose device CLI homes are
 * the generated fixtures in a temporary HOME. No model provider is contacted.
 */
export async function importFixture(
  dir: string,
  options: {
    clis?: readonly FixtureCli[];
    gateway?: TestGateway;
    /** Run threads with the fake Claude Code executable (fixtures/instance-claude.ts); its probes go to `trace`. */
    claude?: boolean;
    /** Run threads with the fake Codex app-server (fixtures/instance-codex.ts). */
    codex?: boolean;
    /** Run threads with the fake Grok ACP agent (fixtures/instance-grok.ts). */
    grok?: boolean;
    /** Settings and library files of the CLIs (fixtures/library). */
    library?: boolean;
  } = {},
) {
  const home = join(dir, "home");
  const data = join(dir, "data");
  mkdirSync(data, { recursive: true });
  installFixtureHome(home, options.clis);

  if (options.library) installLibraryFixture(home);
  const gw = options.gateway ?? (await startTestGateway());
  const trace = join(dir, "probe.jsonl");
  // In place: the fixture imports its neighbours.
  const claude = fileURLToPath(new URL("../fixtures/instance-claude.ts", import.meta.url));
  const codex = fileURLToPath(new URL("../fixtures/instance-codex.ts", import.meta.url));
  const grok = fileURLToPath(new URL("../fixtures/instance-grok.ts", import.meta.url));

  if (options.claude || options.codex || options.grok) process.env["INSTANCE_TRACE"] = trace;

  if (options.grok) writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify({ token: "fixture" }));

  // The device login the Codex instance links (a fixture token, like the worktree fixture's).
  if (options.codex)
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "fixture" } }));

  // Claude Code's login in the fixture's own home (shape only, a fixture token): the instance never depends on a
  // login or an API key of the machine the tests run on.
  if (options.claude)
    writeFileSync(
      join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "fixture", refreshToken: "fixture", expiresAt: 4102444800000 } }),
    );

  const worker = await gw.addWorker("Import laptop");
  const workerId = worker.workerId;
  await gw.runtime.runPromise(
    GatewayStore.use((s) =>
      s.setWorkerConfig(
        workerId,
        {
          codex: options.codex ? { enabled: true, executablePath: codex } : { enabled: false },
          claude: options.claude ? { enabled: true, executablePath: claude } : { enabled: false },
          grok: options.grok ? { enabled: true, executablePath: grok } : { enabled: false },
        },
        gw.userId,
      ),
    ),
  );
  const runtime = ManagedRuntime.make(Journal.layer(join(data, "journal.db")));

  const host = new WorkerHost({
    runtime,
    dataDir: data,
    clientVersion: "test",
    deviceHomes: {
      claude: join(home, ".claude"),
      codex: join(home, ".codex"),
      grok: join(home, ".grok"),
      // The fixture's own ~/.agents (never the machine's): its skills are listed for import.
      ...(options.library && { agents: join(home, ".agents", "skills") }),
    },
    // The fake Grok CLI has no login of its own to probe (like the instance fixture's probe).
    ...(options.grok && {
      probe: {
        which: (name: string) => Bun.which(name),
        version: () => "1.0.70",
        realDirectory: (path: string) => path,
        login: () => "fixture login",
      },
    }),
  });

  let link: GatewayLink | undefined;
  let closed = false;

  const connect = async () => {
    if (link && !closed) return;
    closed = false;
    link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: worker.credential,
      hello: {
        workerId,
        host: { os: process.platform },
        homeDirectory: homedir(),
        capabilities: ["cli_import_v1", "cli_import_library_v1"],
        scratchRoot: join(data, "scratch"),
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

  /** The thread as the UI first gets it (WatchThread snapshot): thread, turns and items. */
  const snapshot = async (threadId: string) => {
    const updates = await watchUntil(gw.api, threadId, (u) => u.some((x) => x.change.case === "snapshot"));
    const change = updates.find((u) => u.change.case === "snapshot")?.change;

    if (change?.case !== "snapshot") throw new Error(`no snapshot of ${threadId}`);

    return change.value;
  };

  return {
    snapshot,
    trace,
    gw,
    home,
    data,
    host,
    workerId,
    connect,
    sql: <A, E>(use: (sql: SqlClient.SqlClient) => Effect.Effect<A, E>) =>
      gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, use)),
    disconnect: () => {
      closed = true;
      link?.close();
    },
    /**
     * After each test (afterEach): the worker is online again and pages have their usual size, whatever the test did
     * or where it failed, so no test starts with another one's state.
     */
    /** The worker goes away right before the runner asks for its `page`-th page (counted from now). */
    offlineAtPage(page: number) {
      let pages = 0;

      gw.core.imports.runner.beforePage = () => {
        if (++pages === page) {
          closed = true;
          link?.close();
        }
      };
    },
    async restore() {
      gw.core.imports.runner.pageBytes = 4 * 1024 ** 2;
      gw.core.imports.runner.beforePage = () => {};

      await connect();
    },
    async close() {
      link?.close();
      await host.close();
      await runtime.dispose();

      if (!options.gateway) await gw.close();
    },
  };
}
