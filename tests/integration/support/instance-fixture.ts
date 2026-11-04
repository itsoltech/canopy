import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Provider, ProviderProfileKind } from "@canopy/contracts";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { journalHello, openGatewayLink } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { WorkerHost, serveLink } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { Effect } from "effect";
import { startTestGateway, eventually, watchUntil } from "./gateway.ts";
import { probeRecords } from "../fixtures/instance-probe.ts";

const tempDir = tempDirs();

export async function startInstanceFixture() {
  const dir = tempDir("canopy-instance-switch-");
  const dataDir = join(dir, "data");
  const trace = join(dir, "probe.jsonl");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  const gw = await startTestGateway();
  const added = await gw.addWorker("Instance fixture");
  const executable = (harness: string) => resolve(import.meta.dir, `../fixtures/instance-${harness}.ts`);
  await gw.runtime.runPromise(
    GatewayStore.use((s) =>
      s.setWorkerConfig(
        added.workerId,
        {
          claude: { enabled: true, executablePath: executable("claude") },
          codex: { enabled: true, executablePath: executable("codex") },
          grok: { enabled: true, executablePath: executable("grok") },
        },
        gw.userId,
      ),
    ),
  );
  const logs: string[] = [];
  const runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));

  const host = new WorkerHost({
    runtime,
    dataDir,
    clientVersion: "test",
    log: (message) => logs.push(message),
    deviceHomes: {
      claude: join(dir, "device-claude"),
      codex: join(dir, "device-codex"),
      grok: join(dir, "device-grok"),
    },
    probe: {
      which: (name) => executable(name),
      version: () => "1.0.70",
      realDirectory: (path) => path,
      login: () => "fixture login",
    },
  });

  const link = await openGatewayLink({
    baseUrl: gw.grpcUrl,
    credential: added.credential,
    hello: { workerId: added.workerId, ...(await runtime.runPromise(journalHello())) },
  });

  let stopped = false;

  const serving = serveLink(link, host, runtime).catch((error) => {
    if (!stopped) throw error;
  });

  await eventually(async () => host.config, Boolean);
  const project = (await gw.api.createProject({ name: "Instance changes" })).project!;

  const workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId: added.workerId, rootPath: repo }))
    .workspace!;

  const proxyServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ data: [{ id: "fixture-model" }] }),
  });

  const proxy = (
    await gw.api.saveProxy({
      name: "Fixture proxy",
      kind: "cliproxyapi",
      baseUrl: proxyServer.url.href,
      secret: "fixture-proxy-key",
    })
  ).proxy!;

  const query = <A extends object>(statement: string, params: readonly string[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<A>(statement, params);
      }),
    );

  const save = async (
    harness: Provider,
    probe: string,
    kind = ProviderProfileKind.NATIVE,
    id = "native",
    create = false,
  ) => {
    const response = await gw.api.saveProviderInstance({
      harness,
      id,
      create,
      label: id === "native" ? "" : id,
      kind,
      proxyId: kind === ProviderProfileKind.CLIPROXYAPI ? proxy.id : "",
      env: [
        { name: "PROFILE_PROBE", value: probe },
        { name: "INSTANCE_TRACE", value: trace },
        { name: "INSTANCE_SECRET", value: `fixture-secret-${probe}`, secret: true },
      ],
      runtime: { ownLogin: harness === Provider.CODEX && id === "native" },
      workerIds: [added.workerId],
    });

    const version = (await gw.api.getOverview({})).workers.find((w) => w.id === added.workerId)!.configVersion;
    await eventually(
      async () => host.config?.version,
      (v) => v === version,
    );
    await eventually(
      async () => (await gw.api.getOverview({})).workers.find((w) => w.id === added.workerId)?.appliedVersion,
      (v) => v === version,
    );

    return response.instance!;
  };

  const thread = async (provider: Provider, id = "native") => {
    const created = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider,
        providerProfileId: id,
        title: "Fixture thread",
      })
    ).thread!;

    await eventually(
      () => gw.api.getThread({ threadId: created.id }),
      (r) => r.thread?.status === "idle",
    );

    const session = (
      await query<{ provider_thread_id: string }>("SELECT provider_thread_id FROM threads WHERE id=$1", [created.id])
    )[0]!.provider_thread_id;

    return { ...created, providerThreadId: session };
  };

  const send = async (threadId: string, text: string) =>
    (await gw.api.sendMessage({ threadId, text, clientRequestId: crypto.randomUUID() })).turn!;

  const finished = async (threadId: string, turnId: string) => {
    const updates = await watchUntil(gw.api, threadId, (us) =>
      us.some((u) =>
        u.change.case === "turn"
          ? u.change.value.id === turnId && ["completed", "failed", "interrupted"].includes(u.change.value.status)
          : u.change.case === "snapshot" &&
            u.change.value.turns.some(
              (t) => t.id === turnId && ["completed", "failed", "interrupted"].includes(t.status),
            ),
      ),
    );

    const turns = updates.flatMap((u) => {
      if (u.change.case === "snapshot") return u.change.value.turns;

      if (u.change.case === "turn") return [u.change.value];

      return [];
    });

    return turns.findLast((t) => t.id === turnId)!;
  };

  return {
    gw,
    host,
    dir,
    dataDir,
    trace,
    logs,
    workerId: added.workerId,
    proxy,
    query,
    save,
    thread,
    send,
    finished,
    records: () => probeRecords(trace),
    release: (label: string) => Bun.write(join(dir, `release-${label}`), "release"),
    close: async () => {
      stopped = true;
      await host.close();
      link.close();
      await serving;
      await runtime.dispose();
      proxyServer.stop(true);
      await gw.close();
    },
  };
}

export type InstanceFixture = Awaited<ReturnType<typeof startInstanceFixture>>;
