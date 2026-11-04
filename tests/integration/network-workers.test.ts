import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { ui, update } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { createGrpcClientTransport } from "@canopy/transport";
import { GatewayCore } from "@canopy/gateway/core";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { enrollWorker } from "../../apps/worker/src/enroll.ts";
import { openGatewayLink } from "../../apps/worker/src/gateway-link/index.ts";
import { SERVICE_TOKEN, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("workers and persisted limits through Network access", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  let directory = "";
  beforeAll(async () => {
    gw = await startTestGateway();
    directory = mkdtempSync(join(tmpdir(), "canopy-network-worker-"));
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
  }, 60_000);
  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();

    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test("enrollment pins TLS, persists trust and authenticates WorkerLink and UpdateService", async () => {
    const setup = await gw.api.getWorkerSetup({});
    expect(setup.gatewayUrl).toBe(network.origins()[0]!);
    expect(setup.gatewayFingerprint).toBe(network.fingerprint);
    const invitation = await gw.api.createWorkerEnrollment({ name: "Pinned remote worker" });
    const configPath = join(directory, "worker.json");

    const local = await enrollWorker({
      gateway: setup.gatewayUrl,
      fingerprint: setup.gatewayFingerprint,
      token: invitation.token,
      configPath,
    });

    expect(local.gateway_fingerprint).toBe(network.fingerprint);
    const ca = local.gateway_certificate!;
    const fingerprint = local.gateway_fingerprint!;

    const link = await openGatewayLink({
      baseUrl: setup.gatewayUrl,
      ca,
      fingerprint,
      credential: local.credential,
      hello: { workerId: local.worker_id, host: { hostname: "remote", os: "linux", arch: "x64" } },
    });

    expect(link.welcome.heartbeatIntervalSeconds).toBeGreaterThan(0);
    const transport = createGrpcClientTransport({ baseUrl: setup.gatewayUrl, ca, fingerprint });
    const api = createClient(ui.GatewayService, transport);
    expect(await failure(api.getOverview({}, { headers: { authorization: `Bearer ${local.credential}` } }))).toContain(
      "Invalid or revoked device token",
    );
    const updates = createClient(update.UpdateService, transport);
    expect((await updates.check({})).updateProtocol).toBeGreaterThan(0);
    await gw.api.revokeWorker({ workerId: local.worker_id });
    await link.closed;
    expect(
      await failure(
        openGatewayLink({
          baseUrl: setup.gatewayUrl,
          ca,
          fingerprint,
          credential: local.credential,
          hello: { workerId: local.worker_id },
        }),
      ),
    ).toContain("credential");
  });

  test("a wrong pin cannot spend an enrollment token or leave a config", async () => {
    const invitation = await gw.api.createWorkerEnrollment({ name: "Wrong route" });
    const configPath = join(directory, "wrong.json");
    expect(
      await failure(
        enrollWorker({
          gateway: network.origins()[0]!,
          fingerprint: "0".repeat(64),
          token: invitation.token,
          configPath,
        }),
      ),
    ).toContain("fingerprint");
    expect(existsSync(configPath)).toBe(false);
    const pending = (await gw.api.getWorkerSetup({})).enrollments.find((e) => e.id === invitation.enrollment!.id);
    expect(pending?.usedAt).toBeUndefined();
  });

  test("attachment settings survive a new core and enforce uploads with optimistic concurrency", async () => {
    const current = await gw.api.getSettings({});
    const limits = { maxFileBytes: 1024n, maxMessageBytes: 2048n, maxFiles: 2 };
    const request = { expectedVersion: current.user!.version, attachmentLimits: limits };
    await gw.api.updateUserSettings(request);
    expect((await gw.api.getSettings({})).attachmentLimits).toMatchObject(limits);
    expect(await failure(gw.api.updateUserSettings(request))).toContain("changed");
    const restarted = new GatewayCore({ runtime: gw.runtime, userId: gw.userId, instanceId: "restart-limits" });

    try {
      expect((await restarted.settings()).attachmentLimits).toMatchObject(limits);
      expect(await failure(restarted.uploadAttachment("too-large.txt", new Uint8Array(1025).fill(65)))).toContain(
        "up to",
      );
      expect((await restarted.uploadAttachment("small.txt", new Uint8Array(100).fill(65))).sizeBytes).toBe(100n);
    } finally {
      restarted.secrets.stop();
    }

    expect(
      await failure(
        gw.api.updateUserSettings({
          expectedVersion: (await gw.api.getSettings({})).user!.version,
          attachmentLimits: { ...limits, maxMessageBytes: 1n },
        }),
      ),
    ).toContain("Choose");
  });
});
