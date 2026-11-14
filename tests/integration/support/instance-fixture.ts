import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Provider, ProviderProfileKind } from "@canopy/contracts";
import { GatewayStore } from "@canopy/gateway/store";
import { tempDirs } from "@canopy/testing";
import { STEER_ATTACHMENTS_CAPABILITY } from "@canopy/domain/release/protocol";
import { journalHello, openGatewayLink, resendPending } from "@canopy/worker/gateway-link";
import { Journal } from "@canopy/worker/journal";
import { WorkerHost, serveLink, type WorkerHostOptions } from "@canopy/worker/runtime";
import { ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { Effect } from "effect";
import { startTestGateway, eventually, watchUntil } from "./gateway.ts";
import { inputRecords, probeRecords } from "../fixtures/instance-probe.ts";

const tempDir = tempDirs();

/** Provider settings of whoever runs the tests (a developer shell, an agent session). */
const CALLER_PROVIDER_ENV = /^(ANTHROPIC_|CLAUDE|CODEX_|OPENAI_|XAI_|GROK_|CLIPROXY_API_KEY$)/;

/**
 * The in-process worker hands its own environment to native harnesses. Remove the caller's provider variables for the
 * fixture's lifetime, so native turns see only what the instance configures; the returned function restores them.
 */
function isolateProviderEnv(): () => void {
  const inherited = Object.entries(process.env).filter(([name]) => CALLER_PROVIDER_ENV.test(name));

  for (const [name] of inherited) delete process.env[name];

  return () => {
    for (const [name, value] of inherited) process.env[name] = value;
  };
}

export async function startInstanceFixture(
  bots = false,
  gatewayOptions: Parameters<typeof startTestGateway>[0] = {},
  workerOptions: Pick<WorkerHostOptions, "shellTimeoutMs" | "botDownloads"> = {},
  shellCapability = true,
  steerAttachments = true,
) {
  const restoreEnv = isolateProviderEnv();
  const dir = tempDir("canopy-instance-switch-");
  const dataDir = join(dir, "data");
  const trace = join(dir, "probe.jsonl");
  const repo = join(dir, "repo");
  mkdirSync(repo);
  let gw = await startTestGateway(gatewayOptions);

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
  let runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));

  const createHost = () =>
    new WorkerHost({
      ...workerOptions,
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
        version: (path) => (existsSync(path) ? "1.0.70" : undefined),
        realDirectory: (path) => path,
        login: () => "fixture login",
      },
    });

  let host = createHost();

  const capabilities = [
    "thread_lifecycle_v1",
    "bot_harness_v1",
    "bot_web_v1",
    "bot_workspace_v1",
    "bot_outgoing_files_v1",
    "bot_images_v1",
    "bot_files_v1",
    "attachments",
    ...(shellCapability ? ["shell_input_v1"] : []),
    ...(steerAttachments ? [STEER_ATTACHMENTS_CAPABILITY] : []),
  ];

  let link = await openGatewayLink({
    baseUrl: gw.grpcUrl,
    credential: added.credential,
    hello: {
      workerId: added.workerId,
      capabilities,
      attachmentsRoot: host.attachmentsRoot,
      environmentKind: "desktop",
      ...(await runtime.runPromise(journalHello())),
    },
  });

  let stopped = false;

  let serving = serveLink(link, host, runtime, (message) => logs.push(message)).catch((error) => {
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
    extraEnv: readonly { name: string; value: string }[] = [],
  ) => {
    const response = await gw.api.saveProviderInstance({
      harness,
      id,
      create,
      label: id === "native" ? "" : id,
      kind,
      proxyId: kind === ProviderProfileKind.CLIPROXYAPI ? proxy.id : "",
      env: [
        ...extraEnv,
        { name: "PROFILE_PROBE", value: probe },
        { name: "INSTANCE_TRACE", value: trace },
        ...(bots ? [{ name: "BOT_TRACE", value: join(dir, "bots.jsonl") }] : []),
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
    get gw() {
      return gw;
    },
    get host() {
      return host;
    },
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
    restartWorker: async () => {
      link.close();
      await serving;
      await host.close();
      await runtime.dispose();
      runtime = ManagedRuntime.make(Journal.layer(join(dir, "journal.db")));
      host = createHost();
      await host.recover();
      link = await openGatewayLink({
        baseUrl: gw.grpcUrl,
        credential: added.credential,
        hello: {
          workerId: added.workerId,
          capabilities,
          attachmentsRoot: host.attachmentsRoot,
          environmentKind: "desktop",
          ...(await runtime.runPromise(journalHello())),
        },
      });
      serving = serveLink(link, host, runtime, (message) => logs.push(message)).catch(() => {});
      await runtime.runPromise(resendPending(link, (event) => host.sendPreviews(link, event)));
      await eventually(async () => host.config, Boolean);
    },
    disconnect: async () => {
      link.close();
      await serving;
    },
    restartGateway: async () => {
      link.close();
      await serving;

      const storage = {
        pg: gw.pg,
        secretsKey: gw.secretsKey,
        workerId: gw.workerId,
        workerCredential: gw.workerCredential,
      };

      await gw.close(true);
      gw = await startTestGateway({ ...gatewayOptions, storage });
    },
    reconnect: async (baseUrl = gw.grpcUrl) => {
      const next = await openGatewayLink({
        baseUrl,
        credential: added.credential,
        hello: {
          workerId: added.workerId,
          capabilities,
          attachmentsRoot: host.attachmentsRoot,
          environmentKind: "desktop",
          runningTurns: host.runningTurns(),
          ...(await runtime.runPromise(journalHello())),
        },
      });

      const done = serveLink(next, host, runtime, (message) => logs.push(message)).catch(() => {});
      link = next;
      serving = done;
      await runtime.runPromise(resendPending(next, (event) => host.sendPreviews(next, event)));

      return async () => {
        next.close();
        await done;
      };
    },
    records: () => probeRecords(trace),
    inputs: () => inputRecords(trace),
    release: (label: string) => Bun.write(join(dir, `release-${label}`), "release"),
    close: async () => {
      stopped = true;
      await host.close();
      link.close();
      await serving;
      await runtime.dispose();
      proxyServer.stop(true);
      await gw.close();
      restoreEnv();
    },
  };
}

export type InstanceFixture = Awaited<ReturnType<typeof startInstanceFixture>>;
