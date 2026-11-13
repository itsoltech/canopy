import { afterEach, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CliInstallMethod, CliToolsReportSchema, InstallCliSchema, Provider, ui, update } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { createGrpcClientTransport } from "@canopy/transport";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { ReleaseManifest } from "@canopy/updater";
import { UpdateRunStore } from "../../apps/gateway/src/updates/run-store.ts";
import { UpdateCenter } from "../../apps/gateway/src/updates/center.ts";
import { updatesSnapshot } from "../../apps/gateway/src/updates/center-composition.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

async function fixture(kind: "binary" | "docker" = "binary", version = "2.0.0") {
  const directory = tempDir("canopy-update-center-");
  const binary = join(directory, "gateway");
  await writeFile(binary, "old gateway", { mode: 0o700 });
  const bytes = "new gateway and worker fixture";
  const hash = createHash("sha256").update(bytes).digest("hex");

  const manifest: ReleaseManifest = {
    schema: 1,
    version: "2.0.0",
    channel: "stable",
    commit: "abcdef0",
    published_at: "2026-11-04T00:00:00Z",
    protocol: { worker_link: 1, update: 1 },
    assets: ["gateway", "worker"].flatMap((app) => [
      {
        app: app === "gateway" ? "gateway" : "worker",
        os: "linux",
        arch: "x64",
        name: `canopy-${app}-linux-x64`,
        url: "https://releases.fixture/binary",
        sha256: hash,
        size: bytes.length,
      },
    ]),
  };

  const release = {
    tag_name: "v2.0.0",
    draft: false,
    prerelease: false,
    assets: [{ name: "manifest.json", browser_download_url: "https://releases.fixture/manifest" }],
  };

  const registry = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("2.0.0") });
  cleanups.push(() => {
    registry.stop(true);
  });
  let restarted = false;

  const gateway = await startTestGateway({
    updates: {
      kind,
      version,
      binaryPath: binary,
      cacheDir: join(directory, "cache"),
      restart: async () => {
        restarted = true;
      },
      source: {
        baseUrl: "https://releases.fixture",
        fetch: async (input) => {
          const path = new URL(String(input)).pathname;

          if (path === "/binary") return new Response(bytes);

          if (path.startsWith("/manifest"))
            return Response.json({ ...manifest, version: path.slice("/manifest/".length) || manifest.version });

          if (path.includes("/tags/")) {
            const requestedVersion = path.split("/tags/v")[1] || manifest.version;

            return Response.json({
              ...release,
              tag_name: `v${requestedVersion}`,
              assets: [
                {
                  name: "manifest.json",
                  browser_download_url: `https://releases.fixture/manifest/${requestedVersion}`,
                },
              ],
            });
          }

          return Response.json([release]);
        },
      },
    },
    cliLatest: {
      sources: { claude: `${registry.url}`, codex: `${registry.url}`, grok: `${registry.url}` },
      allowHttpForTests: true,
    },
    worker: { hello: { capabilities: ["cli_install"] } },
  });

  cleanups.push(async () => {
    gateway.core.updateCenter.stop();
    gateway.core.updates.close();
    await gateway.close();
  });
  await gateway.core.updates.start();
  await gateway.core.updates.check();
  await gateway.core.cli.latest.refresh();
  await cliReport(gateway, "1.0.0");
  const client = createClient(update.UpdateService, createGrpcClientTransport({ baseUrl: gateway.grpcUrl }));
  const headers = { authorization: `Bearer ${gateway.workerCredential}` };

  const hello = {
    workerId: gateway.workerId,
    version: "1.0.0",
    installKind: "binary",
    os: "linux",
    arch: "x64",
    minWorkerLinkProtocol: 1,
    workerLinkProtocol: 1,
  };

  await client.check(hello, { headers });
  gateway.worker.handlers.set("installCli", async (value, reply) => {
    expect(value.$typeName).toBe(InstallCliSchema.typeName);
    await cliReport(gateway, "1.0.0", "running");
    reply(true);
  });

  return { gateway, client, headers, hello, restarted: () => restarted };
}

function cliReport(gateway: TestGateway, version: string, state = "") {
  return gateway.core.cli.report(
    gateway.workerId,
    create(CliToolsReportSchema, {
      os: "linux",
      arch: "x64",
      tools: [
        {
          provider: Provider.CLAUDE,
          method: CliInstallMethod.NATIVE,
          version,
          installable: true,
          ...(state && { install: { installId: "fixture", state, targetVersion: "2.0.0" } }),
        },
      ],
    }),
  );
}

async function workerCommand(f: Awaited<ReturnType<typeof fixture>>) {
  const abort = new AbortController();
  cleanups.push(() => abort.abort());
  const iterator = f.client.watch(f.hello, { headers: f.headers, signal: abort.signal })[Symbol.asyncIterator]();
  let event = await iterator.next();

  while (!event.value?.command) event = await iterator.next();

  return event.value.command;
}

function externalCliReport(gateway: TestGateway) {
  return gateway.core.cli.report(
    gateway.workerId,
    create(CliToolsReportSchema, {
      os: "linux",
      arch: "x64",
      tools: [
        { provider: Provider.CLAUDE, method: CliInstallMethod.MISE, version: "1.0.0", installable: true },
        {
          provider: Provider.CODEX,
          method: CliInstallMethod.HOMEBREW,
          version: "1.0.0",
          installable: true,
          manualCommand: "brew upgrade codex",
        },
        { provider: Provider.GROK, method: CliInstallMethod.YARN, version: "1.0.0", installable: true },
      ],
    }),
  );
}

describe.skipIf(!dockerAvailable)("ordered update all through authenticated gateway and worker gRPC", () => {
  test("a worker finishes and passes protocol negotiation before its CLI starts; recreation resumes the same durable run", async () => {
    const f = await fixture();
    const started = await f.gateway.api.manageUpdates({ action: "update_all" });
    const settingsVersion = (await f.gateway.api.getSettings({})).user!.version;
    expect(started.run?.steps.map((s) => s.kind)).toEqual(["worker", "cli"]);
    const command = await workerCommand(f);
    expect(command.version).toBe("2.0.0");
    await f.gateway.core.updateCenter.tick();
    expect(f.gateway.worker.commands.some((c) => c.case === "installCli")).toBe(false);
    const store = new UpdateRunStore(f.gateway.runtime, f.gateway.userId);

    const resumed = new UpdateCenter({
      read: () => store.read(),
      write: (run) => store.write(run),
      snapshot: () => updatesSnapshot(f.gateway.core),
      manage: (r) => f.gateway.core.updates.manage(r),
      install: (r) => f.gateway.core.installCli(r),
      desktop: async () => {
        throw new Error("No desktop selected");
      },
      computer: async () => {
        throw new Error("No computer selected");
      },
    });

    expect((await resumed.status())?.id).toBe(started.run?.id);
    await f.client.report(
      { workerId: f.gateway.workerId, commandId: command.id, state: "succeeded", version: "2.0.0" },
      { headers: f.headers },
    );
    await f.client.check({ ...f.hello, version: "2.0.0" }, { headers: f.headers });
    await resumed.tick();
    await resumed.tick();
    expect(f.gateway.worker.commands.filter((c) => c.case === "installCli")).toHaveLength(1);
    expect((await resumed.status())?.steps.map((s) => s.state)).toEqual(["succeeded", "running"]);
    await resumed.tick();
    expect((await resumed.status())?.state).toBe("running");
    await cliReport(f.gateway, "2.0.0", "succeeded");
    await resumed.tick();
    await resumed.tick();
    await f.gateway.api.updateUserSettings({ expectedVersion: settingsVersion, timezone: "Europe/Warsaw" });
    expect((await f.gateway.api.getUpdates({})).run?.state).toBe("succeeded");
  });

  test("update progress is pushed to overview subscribers, and an idle stream gets no notices", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const updates: ui.OverviewUpdate[] = [];

    const reading = (async () => {
      for await (const update of f.gateway.api.watchOverview({}, { signal: abort.signal })) updates.push(update);
    })().catch(() => {});

    try {
      const feeds = await eventually(async () => updates.find((u) => u.change.case === "feeds"), Boolean, 5000);
      expect(feeds?.change.case === "feeds" && feeds.change.value.pushed).toContain("updates");
      await Bun.sleep(1000);
      expect(updates.filter((u) => u.change.case === "updatesChanged")).toEqual([]);

      await f.gateway.api.manageUpdates({ action: "update_all" });
      await workerCommand(f);
      expect(await eventually(async () => updates.some((u) => u.change.case === "updatesChanged"), Boolean, 3000)).toBe(
        true,
      );
    } finally {
      abort.abort();
      await reading;
    }
  });

  test("worker failure blocks only its dependent CLI, with a retryable reason", async () => {
    const f = await fixture();
    await f.gateway.api.manageUpdates({ action: "update_all" });
    const command = await workerCommand(f);
    await f.client.report(
      {
        workerId: f.gateway.workerId,
        commandId: command.id,
        state: "failed",
        version: "2.0.0",
        reason: "SHA-256 mismatch; previous binary retained",
      },
      { headers: f.headers },
    );

    const run = await eventually(
      async () => {
        await f.gateway.core.updateCenter.tick();

        return (await f.gateway.api.getUpdates({})).run;
      },
      (run) => run?.state !== "running",
      5000,
    );

    expect(run?.state).toBe("failed");
    expect(run?.steps[0]?.reason).toContain("SHA-256 mismatch");
    expect(run?.steps[1]?.state).toBe("blocked");
    expect(f.gateway.worker.commands.some((c) => c.case === "installCli")).toBe(false);
  });

  test("remote apps run after binary workers and CLIs, and an app without a newer version is omitted", async () => {
    const f = await fixture();
    const store = new UpdateRunStore(f.gateway.runtime, f.gateway.userId);
    const remoteId = crypto.randomUUID();
    let phase = "idle";
    const desktops: string[] = [];

    const center = new UpdateCenter({
      read: () => store.read(),
      write: (run) => store.write(run),
      snapshot: async () => {
        const snapshot = await updatesSnapshot(f.gateway.core);
        // Remote app transport is exercised separately over pinned TLS in desktop-updates.test.ts.
        snapshot.workers.push(
          create(ui.WorkerUpdateSchema, {
            workerId: remoteId,
            name: "Remote app",
            installKind: "desktop",
            desktop: {
              version: phase === "succeeded" ? "2.0.0" : "1.0.0",
              availableVersion: "2.0.0",
              connected: true,
              phase,
            },
          }),
          create(ui.WorkerUpdateSchema, {
            workerId: crypto.randomUUID(),
            name: "Current app",
            installKind: "desktop",
            desktop: { version: "2.0.0", availableVersion: "2.0.0", connected: true },
          }),
        );

        return snapshot;
      },
      manage: (request) => f.gateway.core.updates.manage(request),
      install: (request) => f.gateway.core.installCli(request),
      desktop: async (request) => {
        desktops.push(request.workerId);
        phase = "downloading";
      },
      computer: async () => {
        throw new Error("No computer selected");
      },
    });

    await center.begin();
    expect((await center.status())?.steps.map((s) => s.kind)).toEqual(["worker", "cli", "desktop"]);
    const command = await workerCommand(f);
    await f.client.report(
      { workerId: f.gateway.workerId, commandId: command.id, state: "succeeded", version: "2.0.0" },
      { headers: f.headers },
    );
    await f.client.check({ ...f.hello, version: "2.0.0" }, { headers: f.headers });
    await center.tick();
    await center.tick();
    expect(desktops).toEqual([]);
    await cliReport(f.gateway, "2.0.0", "succeeded");
    await center.tick();
    await center.tick();
    expect(desktops).toEqual([remoteId]);
    await center.tick();
    expect((await center.status())?.state).toBe("running");
    phase = "succeeded";
    await center.tick();
    await center.tick();
    expect((await center.status())?.state).toBe("succeeded");
  });

  test("matching application versions cannot bypass the protocol compatibility gate", async () => {
    const f = await fixture();
    await f.gateway.api.manageUpdates({ action: "update_all" });
    await workerCommand(f);
    await f.client.check(
      { ...f.hello, version: "2.0.0", minWorkerLinkProtocol: 9, workerLinkProtocol: 9 },
      { headers: f.headers },
    );

    const step = await eventually(
      async () => {
        await f.gateway.core.updateCenter.tick();

        return (await f.gateway.api.getUpdates({})).run?.steps[0];
      },
      (step) => step?.state === "failed",
      5000,
    );

    expect(step?.reason).toContain("incompatible");
    expect(f.gateway.worker.commands.some((c) => c.case === "installCli")).toBe(false);
  });

  test("an external gateway and manager-installed CLIs are skipped while a binary worker updates successfully", async () => {
    const f = await fixture("docker", "1.5.0");
    await externalCliReport(f.gateway);
    const result = await f.gateway.api.manageUpdates({ action: "update_all" });
    expect(result.gatewayUpdateAvailable).toBe(true);
    expect(result.run?.steps.filter((step) => step.state !== "skipped").map((s) => [s.kind, s.version])).toEqual([
      ["worker", "1.5.0"],
    ]);
    expect(result.run?.steps.filter((step) => step.state === "skipped")).toHaveLength(4);
    const command = await workerCommand(f);
    expect(command.version).toBe("1.5.0");
    await f.client.report(
      { workerId: f.gateway.workerId, commandId: command.id, state: "succeeded", version: "1.5.0" },
      { headers: f.headers },
    );
    await f.client.check({ ...f.hello, version: "1.5.0" }, { headers: f.headers });
    await f.gateway.core.updateCenter.tick();
    await f.gateway.core.updateCenter.tick();
    expect((await f.gateway.api.getUpdates({})).run?.state).toBe("succeeded");
    expect(f.gateway.worker.commands.some((c) => c.case === "installCli")).toBe(false);
    expect(f.restarted()).toBe(false);
  });

  test("only external items refuse an empty run without persisting a failure", async () => {
    const f = await fixture("docker", "1.0.0");
    await externalCliReport(f.gateway);
    await f.client.check({ ...f.hello, installKind: "docker" }, { headers: f.headers });
    expect(await failure(f.gateway.api.manageUpdates({ action: "update_all" }))).toContain(
      "No updates Canopy can install",
    );
    expect((await f.gateway.api.getUpdates({})).run).toBeUndefined();
    expect(await new UpdateRunStore(f.gateway.runtime, f.gateway.userId).read()).toBeUndefined();
    expect(f.gateway.worker.commands.some((c) => c.case === "installCli")).toBe(false);
    expect(f.restarted()).toBe(false);
  });

  test("a snapshot hides an obsolete external-gateway failure but preserves actual worker failures", async () => {
    const f = await fixture("docker", "1.0.0");
    await externalCliReport(f.gateway);
    await f.client.check({ ...f.hello, installKind: "docker" }, { headers: f.headers });
    const store = new UpdateRunStore(f.gateway.runtime, f.gateway.userId);

    const run = create(ui.UpdateRunSchema, {
      id: crypto.randomUUID(),
      state: "blocked",
      reason: "Gateway: Managed externally",
      steps: [
        {
          kind: "gateway",
          state: "blocked",
          reason: "[failed_precondition] Managed externally — Managed externally. Pull the new image tag.",
        },
      ],
    });

    await store.write(run);
    expect((await f.gateway.api.getUpdates({})).run).toBeUndefined();
    run.steps.push(create(ui.UpdateStepSchema, { kind: "worker", state: "failed", reason: "SHA-256 mismatch" }));
    await store.write(run);
    expect((await f.gateway.api.getUpdates({})).run?.id).toBe(run.id);
  });

  test("a self-updatable gateway stages and restarts first; the chain waits for its new running version", async () => {
    const f = await fixture("binary", "1.0.0");
    const started = await f.gateway.api.manageUpdates({ action: "update_all" });
    expect(started.run?.steps[0]?.kind).toBe("gateway");
    expect(await eventually(async () => f.restarted(), Boolean)).toBe(true);
    await f.gateway.core.updateCenter.tick();
    const run = await new UpdateRunStore(f.gateway.runtime, f.gateway.userId).read();
    expect(run?.steps.map((s) => s.state)).toEqual(["running", "queued", "queued"]);
    expect(f.gateway.worker.commands.some((c) => c.case === "installCli")).toBe(false);
  });

  test("a failed gateway blocks its workers and CLIs while an independent app still updates", async () => {
    const f = await fixture("binary", "1.0.0");
    const store = new UpdateRunStore(f.gateway.runtime, f.gateway.userId);
    const commands: string[] = [];

    const center = new UpdateCenter({
      read: () => store.read(),
      write: (run) => store.write(run),
      snapshot: async () => {
        const snapshot = await updatesSnapshot(f.gateway.core);
        snapshot.workers.push(
          create(ui.WorkerUpdateSchema, {
            workerId: "independent-app",
            name: "Independent app",
            installKind: "desktop",
            desktop: {
              connected: true,
              version: commands.includes("desktop") ? "2.0.0" : "1.0.0",
              availableVersion: "2.0.0",
            },
          }),
        );

        return snapshot;
      },
      manage: async (request) => {
        commands.push(request.action);
        throw new Error("Gateway download failed. Check the connection and retry.");
      },
      install: async () => {
        throw new Error("A dependent CLI must not start");
      },
      desktop: async () => {
        commands.push("desktop");
      },
      computer: async () => {
        throw new Error("No linked app in this fixture");
      },
    });

    await center.begin();

    const run = await eventually(
      async () => {
        await center.tick();

        return center.status();
      },
      (run) => run?.state !== "running",
      5000,
    );

    expect(commands).toEqual(["gateway", "desktop"]);
    expect(run?.steps.map((step) => step.state)).toEqual(["failed", "blocked", "blocked", "succeeded"]);
    expect(run?.steps[1]?.reason).toContain("Gateway");
  });

  test("plans and durable state are owner-scoped; a role change prevents binary updates", async () => {
    const f = await fixture();

    const foreign = await f.gateway.runtime.runPromise(
      GatewayStore.use((s) => s.ensureUser("foreign-update@example.test", "Other owner")),
    );

    const worker = await f.gateway.runtime.runPromise(
      GatewayStore.use((s) => s.addWorker({ name: "foreign", ownerUserId: foreign })),
    );

    await f.gateway.api.manageUpdates({ action: "update_all" });
    const run = (await f.gateway.api.getUpdates({})).run;
    expect(run?.steps.some((s) => s.workerId === worker.workerId)).toBe(false);
    expect(await new UpdateRunStore(f.gateway.runtime, foreign).read()).toBeUndefined();
    expect(await failure(f.gateway.api.installCli({ workerId: worker.workerId, provider: Provider.CLAUDE }))).toContain(
      "not found",
    );
    await f.gateway.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE users SET role = 'user' WHERE id = ${f.gateway.userId}::uuid`;
      }),
    );
    expect(
      await failure(
        f.gateway.core.updates.manage(
          create(ui.ManageUpdatesRequestSchema, { action: "worker", workerId: f.gateway.workerId }),
        ),
      ),
    ).toContain("administrator");
  });
});
