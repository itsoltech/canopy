import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport, createGrpcTransport } from "@connectrpc/connect-node";
import { Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient, type SqlConnection } from "effect/sql";
import { readPairingQr } from "../../apps/mobile/src/api/client.ts";
import { routedMobileClient, type MobileConnection } from "../../apps/mobile/src/api/routes.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { generateIdentity } from "../../apps/gateway/src/computers/identity.ts";
import { openListener } from "../../apps/gateway/src/network/listener.ts";
import { create } from "@bufbuild/protobuf";
import { SERVICE_TOKEN, eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("mobile pairing + pinned native app Connect client", () => {
  let gw: TestGateway;
  let network: NetworkAccess;
  let unmount: () => void;
  const transport = nodePinnedTransport();

  const client = (token?: string, connection: MobileConnection = gw.core.mobile.networkRoutes()) =>
    routedMobileClient({ connection, ...(token && { token }), transport });

  const query = (text: string, params: unknown[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        return yield* sql.unsafe<SqlConnection.Row>(text, params);
      }),
    );

  const invite = () => gw.api.createMobilePairing({});

  const exchange = (code: string, name = "Test iPhone") =>
    client().pairing.exchangeMobilePairing({ code, name, platform: "ios" });

  beforeAll(async () => {
    gw = await startTestGateway();
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
  });

  test("code exchanges atomically once; only hashes persist, with owner/name/platform metadata", async () => {
    const invitation = await invite();
    expect(invitation.routes?.fingerprint).toBe(network.fingerprint);
    expect(
      readPairingQr(JSON.stringify({ type: "canopy-pair", version: 2, code: invitation.code, ...invitation.routes })),
    ).toMatchObject({ addresses: network.origins(), fingerprint: network.fingerprint });
    expect(invitation.code).toMatch(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){3}$/);
    const expires = Number(invitation.pairing!.expiresAt!.seconds) * 1000;
    expect(expires - Date.now()).toBeGreaterThan(590_000);
    const attempts = await Promise.allSettled([exchange(invitation.code), exchange(invitation.code)]);
    const successes = attempts.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(successes).toHaveLength(1);
    const result = successes[0]!;
    expect(result.device).toMatchObject({ name: "Test iPhone", platform: "ios" });

    const rows = await query(
      "SELECT d.owner_user_id, d.token_hash, p.code_hash, p.used_at, p.device_id FROM mobile_devices d JOIN mobile_pairings p ON p.device_id = d.id WHERE d.id = $1",
      [result.device!.id],
    );

    expect(rows[0]?.["owner_user_id"]).toBe(gw.userId);
    expect(rows[0]?.["token_hash"]).toBe(createHash("sha256").update(result.deviceToken).digest("hex"));
    expect(rows[0]?.["code_hash"]).toBe(createHash("sha256").update(invitation.code.replaceAll("-", "")).digest("hex"));
    expect(rows[0]?.["used_at"]).toBeDefined();
    expect((await gw.api.getMobileDevices({})).devices.some((d) => d.id === result.device!.id && d.lastSeenAt)).toBe(
      true,
    );
    expect(await failure(exchange(invitation.code))).toContain("already used");
  });

  test("expired and revoked codes fail; invalid exchanges do not consume a valid code", async () => {
    const expired = await invite();
    await query(
      "UPDATE mobile_pairings SET created_at = now() - interval '20 minutes', expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.pairing!.id],
    );
    expect(await failure(exchange(expired.code))).toContain("expired");
    const revoked = await invite();
    await gw.api.revokeMobilePairing({ id: revoked.pairing!.id });
    expect(await failure(exchange(revoked.code))).toContain("revoked");
    const valid = await invite();
    expect(
      await failure(client().pairing.exchangeMobilePairing({ code: valid.code, name: "", platform: "android" })),
    ).toContain("device name");
    expect(
      await failure(client().pairing.exchangeMobilePairing({ code: valid.code, name: "Browser", platform: "web" })),
    ).toContain("platform");
    expect((await exchange(valid.code)).deviceToken).toStartWith("canopy_device_");
  });

  test("a paired HTTP/2 client receives its overview snapshot before the stream closes", async () => {
    const paired = await exchange((await invite()).code);
    const identity = await new ComputerStore(gw.runtime, gw.userId, gw.secretsKey).identity();

    const phone = createClient(
      ui.GatewayService,
      createConnectTransport({
        baseUrl: network.origins()[0]!,
        httpVersion: "2",
        acceptCompression: [],
        nodeOptions: {
          ca: identity.certificate,
          checkServerIdentity: (_host, certificate) =>
            createHash("sha256").update(certificate.raw).digest("hex") === network.fingerprint
              ? undefined
              : new Error("Certificate mismatch"),
        },
        interceptors: [
          (next) => (request) => {
            request.header.set("authorization", `Bearer ${paired.deviceToken}`);

            return next(request);
          },
        ],
      }),
    );

    const controller = new AbortController();
    let received = false;

    try {
      for await (const update of phone.watchOverview(
        { includeSnapshot: true },
        { signal: controller.signal, timeoutMs: 3000 },
      )) {
        received = true;
        expect(update.change.case).toBe("mobileSnapshot");

        if (update.change.case === "mobileSnapshot")
          expect(update.change.value.overview?.workers.some((w) => w.id === gw.workerId)).toBe(true);
        break;
      }

      expect(received).toBe(true);
    } finally {
      controller.abort();
    }
  }, 10000);

  test("device has owner settings access; revocation closes existing streams and rejects new RPCs", async () => {
    const paired = await exchange((await invite()).code);
    const phone = client(paired.deviceToken).api;
    expect((await phone.getOverview({})).workers.some((w) => w.id === gw.workerId)).toBe(true);
    const invitation = await phone.createMobilePairing({});
    expect((await phone.getMobileDevices({})).pairings.some((p) => p.id === invitation.pairing!.id)).toBe(true);
    await phone.revokeMobilePairing({ id: invitation.pairing!.id });
    expect(await failure(exchange(invitation.code))).toContain("revoked");
    expect((await phone.getNetworkAccess({})).fingerprint).toBe(network.fingerprint);
    expect((await phone.updateNetworkAccess({ action: "set_hostnames", hostnames: ["localhost"] })).hostnames).toEqual([
      "localhost",
    ]);
    const enrollment = await phone.createWorkerEnrollment({ name: "Phone setup" });
    expect((await phone.getWorkerSetup({})).enrollments.some((e) => e.id === enrollment.enrollment!.id)).toBe(true);
    await phone.revokeWorkerEnrollment({ id: enrollment.enrollment!.id });
    await phone.renameWorker({ workerId: gw.workerId, name: "Phone-managed worker" });
    expect(await failure(phone.reportAppControl({}))).toContain("Only the Canopy app");
    expect((await phone.getOverview({})).workers.find((w) => w.id === gw.workerId)?.name).toBe("Phone-managed worker");
    expect(await failure(phone.rotateWorkerCredential({ workerId: Bun.randomUUIDv7() }))).not.toContain("web Settings");
    const signal = AbortSignal.timeout(5000);
    const watch = phone.watchOverview({ includeSnapshot: true }, { signal })[Symbol.asyncIterator]();
    expect((await watch.next()).value?.change.case).toBe("mobileSnapshot");

    // Drain any initial worker updates until the revoked stream completes.
    const ended = (async () => {
      while (!(await watch.next()).done) {
        /* no further access once canceled */
      }
    })();

    await gw.api.revokeMobileDevice({ id: paired.device!.id });
    await ended;
    expect(await failure(phone.getOverview({}))).toContain("revoked");
    expect(
      (await gw.api.getMobileDevices({})).devices.find((d) => d.id === paired.device!.id)?.revokedAt,
    ).toBeDefined();
    // Independent devices retain access.
    const other = await exchange((await invite()).code, "Android");
    expect((await client(other.deviceToken).api.getOverview({})).workers.length).toBeGreaterThan(0);
    await client(other.deviceToken).api.unpairMobileDevice({});
    expect(await failure(client(other.deviceToken).api.getOverview({}))).toContain("revoked");
  });

  test("phone administration cannot list or revoke another owner's devices, codes or workers", async () => {
    const paired = await exchange((await invite()).code);
    const phone = client(paired.deviceToken).api;
    const otherOwner = Bun.randomUUIDv7();
    await query("INSERT INTO users (id, email, display_name, role) VALUES ($1, $2, 'Other', 'user')", [
      otherOwner,
      `${otherOwner}@example.test`,
    ]);
    const foreignPairing = await invite();
    const foreignDevice = await exchange((await invite()).code, "Other owner phone");
    await query("UPDATE mobile_pairings SET owner_user_id = $1 WHERE id = $2", [
      otherOwner,
      foreignPairing.pairing!.id,
    ]);
    await query("UPDATE mobile_devices SET owner_user_id = $1 WHERE id = $2", [otherOwner, foreignDevice.device!.id]);
    const listed = await phone.getMobileDevices({});
    expect(listed.pairings.some((p) => p.id === foreignPairing.pairing!.id)).toBe(false);
    expect(listed.devices.some((d) => d.id === foreignDevice.device!.id)).toBe(false);
    expect(await failure(phone.revokeMobilePairing({ id: foreignPairing.pairing!.id }))).toContain("not found");
    expect(await failure(phone.revokeMobileDevice({ id: foreignDevice.device!.id }))).toContain("not found");
    expect(await failure(client(foreignDevice.deviceToken).api.getMobileDevices({}))).toContain("token");
    expect(
      (await query("SELECT revoked_at FROM mobile_devices WHERE id = $1", [foreignDevice.device!.id]))[0]?.[
        "revoked_at"
      ],
    ).toBeNull();
    expect(
      (await query("SELECT revoked_at FROM mobile_pairings WHERE id = $1", [foreignPairing.pairing!.id]))[0]?.[
        "revoked_at"
      ],
    ).toBeNull();
    const worker = Bun.randomUUIDv7();
    await query(
      "INSERT INTO workers(id,owner_user_id,name,credential_hash) VALUES($1::uuid,$2::uuid,'Other worker','x')",
      [worker, otherOwner],
    );
    expect((await phone.getOverview({})).workers.some((w) => w.id === worker)).toBe(false);
    expect(await failure(phone.renameWorker({ workerId: worker, name: "Changed" }))).toContain("not found");
    expect(await failure(phone.rotateWorkerCredential({ workerId: worker }))).toContain("not found");
    expect(await failure(phone.revokeWorker({ workerId: worker }))).toContain("not found");
    expect(await failure(phone.archiveWorker({ workerId: worker }))).toContain("not found");
    expect(
      (await query("SELECT name, revoked_at, archived_at, credential_hash FROM workers WHERE id = $1", [worker]))[0],
    ).toMatchObject({ name: "Other worker", revoked_at: null, archived_at: null, credential_hash: "x" });
    const enrollment = await gw.api.createWorkerEnrollment({ name: "Other owner's pending worker" });
    await query("UPDATE worker_enrollments SET owner_user_id = $1 WHERE id = $2", [
      otherOwner,
      enrollment.enrollment!.id,
    ]);
    expect((await phone.getWorkerSetup({})).enrollments.some((e) => e.id === enrollment.enrollment!.id)).toBe(false);
    expect(await failure(phone.revokeWorkerEnrollment({ id: enrollment.enrollment!.id }))).toContain("not found");
    expect(
      (await query("SELECT revoked_at FROM worker_enrollments WHERE id = $1", [enrollment.enrollment!.id]))[0]?.[
        "revoked_at"
      ],
    ).toBeNull();
  });

  test("app's pure-TS transport gets overview and receives snapshot + live WatchThread messages via HTTP/1.1", async () => {
    const paired = await exchange((await invite()).code);
    const api = client(paired.deviceToken).api;
    const overview = await api.getOverview({});
    const project = overview.projects.find((p) => p.kind === "scratch")!;
    const workspace = project.workspaces.find((w) => w.workerId === gw.workerId)!;

    const thread = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        title: "Mobile streaming transport",
      })
    ).thread!;

    await eventually(
      () => gw.api.getThread({ threadId: thread.id }),
      (r) => r.thread?.status === "idle",
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let snapshot = false;
    let live = false;

    try {
      for await (const update of api.watchThread({ threadId: thread.id }, { signal: controller.signal })) {
        if (update.change.case === "snapshot") {
          expect(update.change.value.thread?.id).toBe(thread.id);
          snapshot = true;
          await api.sendMessage({
            threadId: thread.id,
            text: "Hello from a paired phone",
            clientRequestId: Bun.randomUUIDv7(),
          });
        }

        if (
          update.change.case === "event" &&
          update.change.value.event?.body.case === "itemCompleted" &&
          update.change.value.event.body.value.item?.content.case === "agentMessage"
        ) {
          live = true;
          break;
        }
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
    }

    expect({ snapshot, live }).toEqual({ snapshot: true, live: true });
    expect((await client(SERVICE_TOKEN).api.getOverview({})).workers.length).toBeGreaterThan(0);
    expect((await gw.api.getOverview({})).workers.length).toBeGreaterThan(0); // existing h2c BFF path unchanged
    expect(await failure(client().api.getOverview({}))).toContain("token");
    expect(await failure(client("incorrect-service-token").api.getOverview({}))).toContain("token");
    const invalidBff = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: gw.grpcUrl }));
    expect(await failure(invalidBff.getOverview({}))).toContain("token");
    expect(
      (
        await transport.fetch(
          network.origins()[0]!,
          { method: "OPTIONS", headers: { Origin: "https://untrusted.example" } },
          network.fingerprint,
        )
      ).status,
    ).toBe(403);
  });

  test("multiple addresses fall back before sending; last success wins and authenticated address pushes update the route list", async () => {
    await network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_hostnames", hostnames: ["localhost"] }),
    );
    const invitation = await invite();
    expect(invitation.routes?.addresses).toHaveLength(2);
    const routes = { fingerprint: network.fingerprint, addresses: ["https://127.0.0.1:1", ...network.origins()] };

    const paired = await client(undefined, routes).pairing.exchangeMobilePairing({
      code: invitation.code,
      name: "Route phone",
      platform: "android",
    });

    const phone = client(paired.deviceToken, routes);
    await phone.api.getOverview({});
    expect(phone.connection().lastAddress).toBe(network.origins()[0]);
    const controller = new AbortController();
    const updates = phone.api.watchOverview({ includeSnapshot: true }, { signal: controller.signal });
    let received = false;

    try {
      for await (const update of updates) {
        if (update.change.case === "mobileSnapshot")
          await network.update(
            create(ui.UpdateNetworkAccessRequestSchema, {
              action: "set_hostnames",
              hostnames: ["localhost", "phone.example.test"],
            }),
          );

        if (
          update.change.case === "mobileRoutes" &&
          update.change.value.addresses.some((a) => a.includes("phone.example.test"))
        ) {
          phone.update(update.change.value);
          received = true;
          break;
        }
      }
    } finally {
      controller.abort();
    }

    expect(received).toBe(true);
    expect(phone.connection().addresses).toEqual(network.origins());
    phone.update({ fingerprint: "0".repeat(64), addresses: ["https://attacker.invalid"] });
    expect(phone.connection().fingerprint).toBe(network.fingerprint);
    expect(phone.connection().addresses).toEqual(network.origins());
  }, 15_000);

  test("a wrong certificate pin cannot exchange or authorize a device", async () => {
    const invitation = await invite();
    const wrong = client(undefined, { fingerprint: "0".repeat(64), addresses: [network.origins()[0]!] });
    expect(
      await failure(wrong.pairing.exchangeMobilePairing({ code: invitation.code, name: "Wrong pin", platform: "ios" })),
    ).toContain("securely");
    expect((await exchange(invitation.code)).deviceToken).toStartWith("canopy_device_");
  });

  test("a false route receives no pairing secret and a real route still works", async () => {
    let requests = 0;

    const falseRoute = await openListener({
      host: "127.0.0.1",
      port: 0,
      identity: await generateIdentity(),
      route: () => (_request, response) => {
        requests++;
        response.end();
      },
    });

    try {
      const invitation = await invite();

      const phone = client(undefined, {
        fingerprint: network.fingerprint,
        addresses: [`https://127.0.0.1:${falseRoute.port}`, ...network.origins()],
      });

      expect(
        (await phone.pairing.exchangeMobilePairing({ code: invitation.code, name: "Pinned phone", platform: "ios" }))
          .deviceToken,
      ).toStartWith("canopy_device_");
      expect(requests).toBe(0);
    } finally {
      await falseRoute.close();
    }
  });

  test("a lost exchange response is not replayed on another route", async () => {
    const invitation = await invite();
    let requests = 0;

    const phone = routedMobileClient({
      connection: gw.core.mobile.networkRoutes(),
      transport: {
        ...transport,
        async fetch(...args) {
          requests++;
          const response = await transport.fetch(...args);
          await response.body?.cancel();
          throw new Error("Response lost after the server committed");
        },
      },
    });

    expect(
      await failure(
        phone.pairing.exchangeMobilePairing({ code: invitation.code, name: "One exchange", platform: "android" }),
      ),
    ).toContain("Response lost");
    expect(requests).toBe(1);
    expect(
      (await gw.api.getMobileDevices({})).pairings.find((p) => p.id === invitation.pairing?.id)?.usedAt,
    ).toBeDefined();
  });

  test("exchange rate limit cannot be bypassed by changing code or forwarding headers", async () => {
    let limited = false;

    for (let i = 0; i < 31; i++) {
      const error = await failure(
        client().pairing.exchangeMobilePairing(
          { code: String(i), name: "Phone", platform: "android" },
          { headers: { "x-forwarded-for": `192.0.2.${i}` } },
        ),
      );

      if (error.includes("Too many pairing")) {
        limited = true;
        break;
      }
    }

    expect(limited).toBe(true);
  });
});
