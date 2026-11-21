import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import {
  AgentTool,
  Provider,
  ProviderProfileKind,
  update,
  WorkerState,
  type ConfigApplied,
  type Hello,
} from "@canopy/contracts";
import { createWorkerLink } from "@canopy/gateway/worker-link";
import { startGrpcServer } from "@canopy/transport";
import { tempDir } from "@canopy/testing";
import { installKind, readUpdateRecord, type ReleaseManifest } from "@canopy/updater";
import { UPDATE_PROTOCOL, WORKER_LINK_PROTOCOL } from "@canopy/domain/release/protocol";
import { managedPrefix } from "../../apps/worker/src/agent-tools/paths.ts";
import { agentToolSpec } from "../../apps/worker/src/agent-tools/specs.ts";
import { executable } from "../../apps/worker/src/agent-tools/fixtures.test-support.ts";
import { binaryName, compile, TARGETS } from "../../scripts/build-binaries.ts";

const target = TARGETS.find((name) => name === `${process.platform}-${process.arch}`);

test.skipIf(!target || installKind() === "docker")(
  "binary worker hands over before processing archived threads and then configures with a pending AVD reservation",
  async () => {
    if (!target) throw new Error("A standalone build for the host is required");
    const dir = tempDir("canopy-worker-update-cleanup-");
    const workerId = Bun.randomUUIDv7();
    const credential = "update-cleanup-fixture";
    const previousVersion = "2.0.0-nightly.1";
    const version = "2.0.0-nightly.2";
    const config = join(dir, "worker.json");
    const ownershipPath = join(dir, "device-pool.json");
    const codex = join(dir, "codex");
    const codexHome = join(dir, "device-codex");
    await copyFile(join(import.meta.dir, "fixtures/directory-codex.ts"), codex);
    await chmod(codex, 0o700);
    await mkdir(codexHome);
    await writeFile(join(codexHome, "auth.json"), '{"OPENAI_API_KEY":"fixture"}', { mode: 0o600 });
    const device = { id: "Pixel_9", name: "Pixel_9", platform: "android", kind: "emulator", booted: false };
    const ownership = [{ key: device.id, session: "managed", stop: true, device }];
    await writeFile(ownershipPath, JSON.stringify(ownership), { mode: 0o600 });

    const calls = join(dir, "device-calls.jsonl");
    const spec = agentToolSpec(AgentTool.DEVICE);
    executable(
      join(managedPrefix(dir, spec), "bin", spec.executable),
      `
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const ok = data => console.log(JSON.stringify({ success: true, data }));
if (args.includes("--version")) console.log(${JSON.stringify(spec.version)});
else if (args.at(-2) === "daemon" && args.at(-1) === "status") ok({ state: "running" });
else if (args.at(-1) === "close") ok({ closed: "session", session: args[args.indexOf("--session") + 1] });
else if (args.at(-1) === "devices") ok({ devices: [${JSON.stringify({ ...device, id: "emulator-5554", booted: true })}] });
else if (args.at(-2) === "session" && args.at(-1) === "list") ok({ sessions: [] });
else process.exitCode = 1;
`,
    );

    const entry = join(import.meta.dir, "../../apps/worker/src/main.ts");
    const installed = await compile(entry, join(dir, "worker"), target, previousVersion);
    const candidate = Bun.file(await compile(entry, join(dir, "candidate"), target, version));
    const hash = createHash("sha256");

    for await (const bytes of candidate.stream()) hash.update(bytes);

    const manifest: ReleaseManifest = {
      schema: 1,
      version,
      channel: "nightly",
      commit: "abcdef0",
      published_at: "2026-11-18T00:00:00Z",
      protocol: { worker_link: WORKER_LINK_PROTOCOL, update: UPDATE_PROTOCOL },
      assets: [
        {
          app: "worker",
          os: target.startsWith("darwin") ? "darwin" : "linux",
          arch: target.endsWith("arm64") ? "arm64" : "x64",
          name: binaryName("worker", target),
          url: "https://release.fixture/worker",
          size: candidate.size,
          sha256: hash.digest("hex"),
        },
      ],
    };

    const command = create(update.UpdateCommandSchema, {
      id: Bun.randomUUIDv7(),
      version,
      manifestJson: JSON.stringify(manifest),
      preferGatewayMirror: true,
    });

    const previousConfigured = Promise.withResolvers<void>();
    const afterHandover = Promise.withResolvers<Hello>();
    const configured = Promise.withResolvers<ConfigApplied>();
    const result = Promise.withResolvers<{ report: update.ReportRequest; connections: number }>();
    const closedThreadId = Bun.randomUUIDv7();
    let firstCandidate: Hello | undefined;
    let candidateConnections = 0;

    const link = createWorkerLink({
      authenticate: async (value) => (value === credential ? workerId : undefined),
      welcome: async (_workerId, hello) => {
        if (hello.host?.workerVersion === version) firstCandidate ??= hello;

        return {
          heartbeatIntervalSeconds: 15,
          // Work queued on the probe link must be left for the replacement process.
          ...(hello === firstCandidate && { threadLifecycle: { replace: true, closedThreadIds: [closedThreadId] } }),
        };
      },
      config: async () => ({
        version: 10n,
        claude: { enabled: false },
        grok: { enabled: false },
        codex: { enabled: true, executablePath: codex, linkDeviceLogin: true },
        profiles: [{ id: "native", kind: ProviderProfileKind.NATIVE, providers: [Provider.CODEX] }],
      }),
      onConnected: (connection) => {
        if (connection.hello.host?.workerVersion === version && ++candidateConnections === 2)
          afterHandover.resolve(connection.hello);
      },
      onMessage: (connection, message) => {
        if (message.payload.case === "configApplied") {
          if (connection.hello.host?.workerVersion === previousVersion) previousConfigured.resolve();
          else configured.resolve(message.payload.value);
        }

        return false;
      },
    });

    const server = await startGrpcServer({
      routes: (router) => {
        link.routes(router);
        router.service(update.UpdateService, {
          async *watch(request) {
            if (request.version === previousVersion) {
              await previousConfigured.promise;
              yield create(update.UpdateEventSchema, { command });
            }
          },
          async *fetchArtifact() {
            for await (const data of candidate.stream()) yield create(update.ArtifactChunkSchema, { data });
          },
          async report(request) {
            if (["failed", "succeeded"].includes(request.state))
              result.resolve({ report: request, connections: candidateConnections });

            return {};
          },
        });
      },
    });

    const deadline = new AbortController();
    await writeFile(
      config,
      JSON.stringify({ gateway_url: server.url, worker_id: workerId, credential, data_dir: dir }),
      { mode: 0o600 },
    );

    const worker = Bun.spawn([installed, "--config", config], {
      env: {
        ...process.env,
        CANOPY_SUPERVISED: "",
        CANOPY_INSTALL_KIND: "",
        CANOPY_WORKER_STATUS_FILE: "",
        CANOPY_LOG_DIR: join(dir, "logs"),
        CANOPY_NATIVE_DIR: join(dir, "native"),
        CANOPY_WORKTREES_ROOT: join(dir, "worktrees"),
        CODEX_HOME: codexHome,
        CLAUDE_CONFIG_DIR: join(dir, "device-claude"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const output = new Response(worker.stdout).text();
    const errors = new Response(worker.stderr).text();

    try {
      const completed = async () => {
        const { report, connections } = await result.promise;
        expect(report).toMatchObject({ commandId: command.id, state: "succeeded", version });
        expect(connections).toBe(2);
        expect((await afterHandover.promise).state).toBe(WorkerState.ACTIVE);
        expect(await configured.promise).toMatchObject({ version: 10n, applied: true });

        while (await readUpdateRecord(installed)) await setTimeout(20, undefined, { signal: deadline.signal });
      };

      await Promise.race([
        completed(),
        worker.exited.then((code) => {
          throw new Error(`Worker exited during update (${code})`);
        }),
        setTimeout(20_000, undefined, { signal: deadline.signal }).then(() => {
          throw new Error("Worker update did not reconnect and report a result");
        }),
      ]);
      expect(JSON.parse(await readFile(ownershipPath, "utf8"))).toEqual(ownership);
      const invocations = await readFile(calls, "utf8");
      expect(invocations).toContain('"--session","managed","close"');
      expect(invocations).not.toContain(closedThreadId);
      expect(invocations).not.toContain('"shutdown"');
    } finally {
      deadline.abort();

      if (worker.exitCode === null) worker.kill("SIGTERM");
      await worker.exited;
      await link.shutdown();
      await server.close(50);
    }

    const logs = (await output) + (await errors);
    expect(logs).toContain("Cannot prove ownership of the Android AVD runtime");
    expect(logs.split("codex runtime started")).toHaveLength(3);
  },
  60_000,
);
