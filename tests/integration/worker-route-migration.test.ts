import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { NetworkRoutesSchema, WorkerLinkService, ui, update } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { tempDir } from "@canopy/testing";
import { createGrpcClientTransport } from "@canopy/transport";
import { Result } from "effect";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { enrollWorker } from "../../apps/worker/src/enroll.ts";
import { loadLocalConfig, type LocalConfig } from "../../apps/worker/src/config/local.ts";
import { openGatewayLink } from "../../apps/worker/src/gateway-link/index.ts";
import { WorkerNetworkRoute } from "../../apps/worker/src/network-route.ts";
import { SERVICE_TOKEN, eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("worker server-port compatibility and secure route migration", () => {
  const directory = tempDir("canopy-worker-route-migration-");
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;

  beforeAll(async () => {
    gw = await startTestGateway();
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
  }, 60_000);

  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
  });

  async function enabled(value: boolean) {
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: value }));
  }

  async function enrolled(name: string) {
    const configPath = join(directory, `${name}.json`);
    const invitation = await gw.api.createWorkerEnrollment({ name });

    const local = await enrollWorker({
      gateway: gw.grpcUrl,
      token: invitation.token,
      configPath,
      dataDir: join(directory, name),
    });

    return { configPath, local };
  }

  function startWorker(configPath: string) {
    const child = Bun.spawn([process.execPath, "apps/worker/src/main.ts", "--config", configPath], {
      env: {
        ...process.env,
        CANOPY_INSTALL_KIND: "source",
        CANOPY_LOCAL_WORKER: "0",
        PATH: "",
        CODEX_HOME: join(directory, "codex"),
        CLAUDE_CONFIG_DIR: join(directory, "claude"),
      },
      stdout: "ignore",
      stderr: "pipe",
    });

    const errors = new Response(child.stderr).text();

    return {
      child,
      stop: async () => {
        if (child.exitCode === null) child.kill("SIGTERM");
        const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);

        try {
          expect(await child.exited).toBe(0);
        } finally {
          clearTimeout(deadline);
        }

        const output = await errors;
        expect(output).not.toContain("Unhandled");
      },
    };
  }

  async function status(workerId: string, route: string, detail?: string) {
    const snapshot = await eventually(
      () => gw.api.getOverview({}),
      (value) =>
        value.workers.some(
          (worker) =>
            worker.id === workerId &&
            worker.online &&
            worker.networkRouteStatus?.route === route &&
            (detail === undefined || worker.networkRouteStatus.detail.includes(detail)),
        ),
      15_000,
    );

    const worker = snapshot.workers.find((value) => value.id === workerId)!;
    expect(worker.online).toBe(true);
    expect(worker.networkRouteStatus?.route).toBe(route);

    if (detail !== undefined) expect(worker.networkRouteStatus?.detail).toContain(detail);
  }

  test("an old worker without the capability stays connected with network access off and on", async () => {
    await enabled(false);
    const { local, configPath } = await enrolled("old-worker");
    expect(local.gateway_fingerprint).toBeUndefined();
    const original = readFileSync(configPath, "utf8");

    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: local.credential,
      hello: { workerId: local.worker_id, capabilities: [] },
    });

    const received: string[] = [];

    const pump = (async () => {
      for await (const message of link.messages) received.push(message.payload.case ?? "");
    })();

    try {
      await enabled(true);
      link.send({ case: "heartbeat", value: {} });
      const server = gw.core.link.connections.get(local.worker_id)!;
      expect(server.hello.capabilities).not.toContain("network_route_migration");
      expect(server.isOpen).toBe(true);
      expect((await gw.api.getOverview({})).workers.find((w) => w.id === local.worker_id)?.online).toBe(true);
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(received).not.toContain("networkRoutes");
      // Frozen service remains independently reachable even when WorkerLink negotiation would fail.
      const updates = createClient(update.UpdateService, createGrpcClientTransport({ baseUrl: gw.grpcUrl }));
      expect((await updates.check({})).updateProtocol).toBe(1);
      const abort = new AbortController();

      try {
        const first = await updates
          .watch(
            { workerId: local.worker_id, workerLinkProtocol: 0, minWorkerLinkProtocol: 0, installKind: "source" },
            { headers: { authorization: `Bearer ${local.credential}` }, signal: abort.signal },
          )
          [Symbol.asyncIterator]()
          .next();

        expect(first.value?.gateway?.compatibility).toBe("update_required");
      } finally {
        abort.abort();
      }
    } finally {
      link.close();
      await pump;
    }
  }, 20_000);

  test("a running old enrollment migrates after enabling access and survives restart, then falls back when disabled", async () => {
    await enabled(false);
    const { local, configPath } = await enrolled("automatic-migration");
    const original = readFileSync(configPath, "utf8");
    let worker = startWorker(configPath);

    try {
      await status(local.worker_id, "server");
      expect(existsSync(`${configPath}.bak`)).toBe(false);
      await enabled(true);
      await status(local.worker_id, "pinned");
      const decoded = await loadLocalConfig(configPath, process.platform);
      expect(Result.isSuccess(decoded)).toBe(true);

      if (Result.isFailure(decoded)) throw new Error(decoded.failure);
      const migrated = decoded.success;
      expect(migrated.gateway_fingerprint).toBe(network.fingerprint);
      expect(migrated.gateway_certificate).toContain("BEGIN CERTIFICATE");
      expect(migrated.gateway_url).toBe(network.origins()[0]!);
      expect(migrated.gateway_fallback?.gateway_url).toBe(gw.grpcUrl);
      expect(migrated.worker_id).toBe(local.worker_id);
      expect(migrated.credential).toBe(local.credential);
      expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(original);
      expect(statSync(configPath).mode & 0o777).toBe(0o600);
      expect(statSync(`${configPath}.bak`).mode & 0o777).toBe(0o600);

      const pinnedUpdates = createClient(
        update.UpdateService,
        createGrpcClientTransport({
          baseUrl: migrated.gateway_url,
          ca: migrated.gateway_certificate!,
          fingerprint: migrated.gateway_fingerprint!,
        }),
      );

      expect((await pinnedUpdates.check({})).updateProtocol).toBe(1);
      await worker.stop();
      worker = startWorker(configPath);
      await status(local.worker_id, "pinned");
      expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(original);
      await enabled(false);
      await status(local.worker_id, "server");
      // Restart while secure access is off: the persisted fallback still recovers the worker.
      await worker.stop();
      worker = startWorker(configPath);
      await status(local.worker_id, "server");
      expect(readFileSync(configPath, "utf8")).toContain(network.fingerprint);
    } finally {
      await worker.stop();
    }
  }, 60_000);

  test("failed pin and unreachable routes keep the authenticated old link and report a visible reason", async () => {
    await enabled(true);
    const { local, configPath } = await enrolled("failed-route");
    const original = readFileSync(configPath, "utf8");

    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: local.credential,
      hello: { workerId: local.worker_id, capabilities: ["network_route_migration"] },
    });

    const controller = new AbortController();

    const route = new WorkerNetworkRoute({
      local,
      configPath,
      signal: controller.signal,
      changed: () => {
        throw new Error("must not switch a failed route");
      },
    });

    try {
      await route.offer(create(NetworkRoutesSchema, { origins: network.origins(), fingerprint: "0".repeat(64) }), link);
      await status(local.worker_id, "server", "fingerprint mismatch");
      expect(gw.core.link.connections.get(local.worker_id)?.isOpen).toBe(true);
      await route.offer(
        create(NetworkRoutesSchema, { origins: ["https://127.0.0.1:1"], fingerprint: network.fingerprint }),
        link,
      );
      await status(local.worker_id, "server", "unreachable");
      expect(readFileSync(configPath, "utf8")).toBe(original);
      expect(existsSync(`${configPath}.bak`)).toBe(false);
      // A probe is authenticated and owner/worker scoped; it never replaces the original stream.
      const client = createClient(WorkerLinkService, createGrpcClientTransport({ baseUrl: gw.grpcUrl }));
      expect(await failure(client.probeNetworkRoute({ workerId: local.worker_id }))).toContain("credential");
      expect(
        await failure(
          client.probeNetworkRoute(
            { workerId: gw.workerId },
            { headers: { authorization: `Bearer ${local.credential}` } },
          ),
        ),
      ).toContain("does not match");
      await client.probeNetworkRoute(
        { workerId: local.worker_id },
        { headers: { authorization: `Bearer ${local.credential}` } },
      );
      expect(gw.core.link.connections.get(local.worker_id)?.isOpen).toBe(true);
    } finally {
      controller.abort();
      link.close();
      await link.closed;
    }
  }, 20_000);

  test("a changed config preserves the old link and local desktop workers ignore route offers", async () => {
    await enabled(true);
    const { local, configPath } = await enrolled("config-conflict");

    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: local.credential,
      hello: { workerId: local.worker_id },
    });

    const changed: LocalConfig = { ...local, ping_interval_seconds: 60 };
    writeFileSync(configPath, JSON.stringify(changed));
    const routes = create(NetworkRoutesSchema, { origins: network.origins(), fingerprint: network.fingerprint });
    const options = { local, configPath, signal: new AbortController().signal, changed: () => {} };

    try {
      const route = new WorkerNetworkRoute(options);
      await route.offer(routes, link);
      await status(local.worker_id, "server", "could not save");
      expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual(changed);
      expect(gw.core.link.connections.get(local.worker_id)?.isOpen).toBe(true);
      const desktop = new WorkerNetworkRoute({ ...options, localWorker: true });
      await desktop.offer(routes, link);
      expect(desktop.status().route).toBe("local");
      expect(desktop.endpoint).toBe(local);
    } finally {
      link.close();
      await link.closed;
    }
  });
  test("migration resumes after a saved backup and selects a working alternative address", async () => {
    await enabled(true);
    const { local, configPath } = await enrolled("interrupted-migration");
    const original = readFileSync(configPath, "utf8");
    writeFileSync(`${configPath}.bak`, original, { mode: 0o600 });

    const link = await openGatewayLink({
      baseUrl: gw.grpcUrl,
      credential: local.credential,
      hello: { workerId: local.worker_id },
    });

    const route = new WorkerNetworkRoute({
      local,
      configPath,
      signal: new AbortController().signal,
      changed: () => {},
    });

    try {
      await route.offer(
        create(NetworkRoutesSchema, {
          origins: ["https://127.0.0.1:1", ...network.origins()],
          fingerprint: network.fingerprint,
        }),
        link,
      );
      expect(route.status().route).toBe("pinned");
      expect(route.endpoint.gateway_url).toBe(network.origins()[0]!);
      expect(readFileSync(`${configPath}.bak`, "utf8")).toBe(original);
      const loaded = await loadLocalConfig(configPath, process.platform);
      expect(Result.isSuccess(loaded)).toBe(true);

      if (Result.isFailure(loaded)) throw new Error(loaded.failure);

      const restarted = new WorkerNetworkRoute({
        local: loaded.success,
        configPath,
        signal: new AbortController().signal,
        changed: () => {},
      });

      expect(restarted.endpoint.gateway_fingerprint).toBe(network.fingerprint);
      expect(restarted.failed()).toBe(true);
      expect(restarted.endpoint.gateway_url).toBe(gw.grpcUrl);
    } finally {
      link.close();
      await link.closed;
    }
  });
});
