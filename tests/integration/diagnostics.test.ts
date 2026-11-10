import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toJsonString } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { computerLink as link, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { methodId } from "../../apps/gateway/src/diagnostics/registry.ts";
import { linkedMessage } from "../../apps/gateway/src/computers/remote.ts";
import { rpcSnapshot } from "../../apps/gateway/src/diagnostics/snapshot.ts";

const rejectedCode = (promise: Promise<object>) =>
  promise.then(
    () => 0,
    (error) => ConnectError.from(error).code,
  );

describe.skipIf(!dockerAvailable)("owner diagnostics over real gRPC and one relay", () => {
  let a: TestGateway;
  let b: TestGateway;
  let c: TestGateway;
  let nodes: ReturnType<typeof linkedComputers>[] = [];

  const runtime = (gateway: TestGateway, capabilities?: string[]) =>
    linkedComputers({
      store: new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey),
      host: "127.0.0.1",
      heartbeatMs: 500,
      core: gateway.core,
      serve: remoteServe(uiHandlers(gateway.core), gateway.core),
      ...(capabilities && { capabilities }),
    });

  const ready = async (predicate: () => boolean | Promise<boolean>) =>
    expect(await eventually(async () => predicate(), Boolean, 45_000)).toBe(true);

  const diagnostics = () => a.api.getDiagnostics({ windowMinutes: 15 });
  const target = () => nodes[2]!.hello().nodeId;

  beforeAll(async () => {
    a = await startTestGateway({
      role: "desktop",
      diagnostics: true,
      worker: { hello: { capabilities: ["diagnostics_v1"] } },
    });
    b = await startTestGateway({
      role: "desktop",
      diagnostics: true,
      worker: { hello: { capabilities: ["diagnostics_v1"] } },
    });
    c = await startTestGateway({ role: "desktop", diagnostics: true });

    for (const gateway of [a, b, c]) {
      const computer = runtime(gateway);
      nodes.push(computer);
      gateway.core.computers = computer;
      gateway.core.network = computer.options.network;
      await computer.start();
      await gateway.core.diagnostics.start();
    }

    for (const gateway of [a, c]) {
      const invitation = await b.api.createComputerPairing({});
      await gateway.api.linkComputer({ address: nodes[1]!.addresses[0]!, code: invitation.code });
    }

    await ready(
      () =>
        nodes[0]!.reachable().includes(nodes[1]!.hello().nodeId) &&
        nodes[2]!.reachable().includes(nodes[1]!.hello().nodeId),
    );
    await b.api.manageComputer({
      action: "share_onward",
      nodeId: nodes[0]!.hello().nodeId,
      shareOnwardNodeIds: [target()],
    });
    await ready(
      () => nodes[0]!.reachable().includes(target()) && nodes[2]!.relay.entries.has(nodes[0]!.hello().nodeId),
    );
  }, 90_000);

  afterAll(async () => {
    for (const node of nodes) await node.close();

    for (const gateway of [a, b, c]) await gateway?.close();
  }, 30_000);

  test("records unary counts and codes without payloads, and releases a canceled watch once", async () => {
    await a.api.getClientCapabilities({});
    expect(await rejectedCode(a.api.getComputerDiagnostics({ computerId: "private-prompt-and-path" }))).toBe(
      Code.NotFound,
    );
    const abort = new AbortController();
    const watch = a.api.watchOverview({}, { signal: abort.signal })[Symbol.asyncIterator]();
    await watch.next();
    abort.abort();
    await watch.next().catch(() => undefined);
    a.core.diagnostics.collector.tick();
    const snapshot = a.core.diagnostics.local(create(ui.ComputerDiagnosticsRequestSchema, { limit: 384 }), true);
    const capabilities = snapshot.calls.find((call) => call.method.endsWith("/GetClientCapabilities"));
    const rejected = snapshot.calls.find((call) => call.method.endsWith("/GetComputerDiagnostics"));
    const stream = snapshot.calls.find((call) => call.method.endsWith("/WatchOverview"));
    expect(capabilities?.started).toBeGreaterThan(0n);
    expect(capabilities?.durationMs?.samples).toBe(capabilities?.completed);
    expect(rejected?.started).toBe(1n);
    expect(rejected?.completed).toBe(1n);
    expect(rejected?.codes[Code.NotFound]).toBe(1n);
    await ready(
      () => !a.core.diagnostics.collector.active.get(methodId("rpc:canopy.ui.v1.GatewayService/WatchOverview"))?.size,
    );
    expect(stream?.stream).toBe(true);

    const closed = rpcSnapshot(a.core.diagnostics.collector, 15).calls.find((call) =>
      call.method.endsWith("/WatchOverview"),
    );

    expect(closed?.completed).toBe(1n);
    expect(closed?.codes[Code.Canceled]).toBe(1n);
    expect(toJsonString(ui.ComputerDiagnosticsSchema, snapshot)).not.toContain("private-prompt-and-path");
    const denied = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: a.grpcUrl }));
    expect(await rejectedCode(denied.getDiagnostics({}))).toBe(Code.Unauthenticated);
  });

  test("validates pages and windows, deduplicates worker batches and separates RTT from heartbeat", async () => {
    expect(await rejectedCode(a.api.getComputerDiagnostics({ limit: 33 }))).toBe(Code.InvalidArgument);
    expect(await rejectedCode(a.api.getDiagnostics({ windowMinutes: 12 }))).toBe(Code.InvalidArgument);
    expect(
      await rejectedCode(a.api.getComputerDiagnostics({ methodKeys: Array.from({ length: 33 }, () => "rpc:method") })),
    ).toBe(Code.InvalidArgument);
    expect(await rejectedCode(a.api.getComputerDiagnostics({ methodKeys: ["m".repeat(257)] }))).toBe(
      Code.InvalidArgument,
    );
    expect(await rejectedCode(a.api.getComputerDiagnostics({ offset: 385 }))).toBe(Code.InvalidArgument);
    expect(await rejectedCode(a.api.getComputerDiagnostics({ methodKeys: ["rpc:/private/prompt"] }))).toBe(
      Code.InvalidArgument,
    );
    expect(
      await rejectedCode(a.api.getComputerDiagnostics({ computerId: target(), methodKeys: ["rpc:/private/prompt"] })),
    ).toBe(Code.InvalidArgument);

    const report = create(ui.WorkerLinkDiagnosticsSchema, {
      session: crypto.randomUUID(),
      sequence: 1n,
      startMs: BigInt(Date.now() - 1000),
      endMs: BigInt(Date.now()),
      rtt: { indices: [80], counts: [10n], sum: 10, max: 1 },
      jitter: { indices: [1], counts: [9n], max: 0.001, sum: 0.009 },
    });

    a.worker.link.send({ case: "diagnostics", value: report });
    a.worker.link.send({ case: "diagnostics", value: report });
    await ready(() => a.core.diagnostics.links.get(`worker:${a.workerId}`)?.watermark.sequence === 1n);
    const first = a.core.diagnostics.links.get(`worker:${a.workerId}`)!.snapshot(15, "Worker", true, true);
    expect(first.rttMs?.samples).toBe(10n);
    expect(first.heartbeatIntervalMs?.samples ?? 0n).toBe(0n);
    a.worker.link.send({
      case: "diagnostics",
      value: {
        ...report,
        sequence: 2n,
        rtt: create(ui.DiagnosticsHistogramSchema, { indices: [130], counts: [100n] }),
      },
    });
    await a.api.getClientCapabilities({});
    expect(a.core.diagnostics.links.get(`worker:${a.workerId}`)!.watermark.sequence).toBe(1n);
  });

  test("includes every catalog computer, serves a local-only snapshot and enforces onward grants", async () => {
    await ready(async () => (await diagnostics()).computers.length === 3);
    let denied = false;

    try {
      for await (const _ of nodes[0]!.remote(
        target(),
        link.DiagnosticsService.method.readDiagnosticsSnapshot,
        create(ui.ComputerDiagnosticsRequestSchema, { overviewOnly: true }),
        AbortSignal.timeout(3000),
      )) {
      }
    } catch (error) {
      denied = ConnectError.from(error).code === Code.PermissionDenied;
    }

    expect(denied).toBe(true);
    await c.api.setDiagnosticsGrant({ originComputerId: nodes[0]!.hello().nodeId, enabled: true });
    const received: ui.ComputerDiagnostics[] = [];

    for await (const response of nodes[0]!.remote(
      target(),
      link.DiagnosticsService.method.readDiagnosticsSnapshot,
      create(ui.ComputerDiagnosticsRequestSchema, { overviewOnly: true }),
      AbortSignal.timeout(3000),
    ))
      received.push(linkedMessage(ui.ComputerDiagnosticsSchema, response));
    expect(received[0]?.computerId).toBe(target());
    expect(received[0]?.calls).toEqual([]);
    expect(received[0]?.links.some((value) => value.targetId === nodes[0]!.hello().nodeId)).toBe(false);

    for (const read of a.core.diagnostics.peers.reads.values()) read.due = 0;
    await a.core.diagnostics.peers.tick();
    await ready(async () =>
      (await diagnostics()).computers.some((computer) => computer.computerId === target() && computer.sampledAtMs > 0n),
    );
    await c.api.setDiagnosticsGrant({ originComputerId: nodes[0]!.hello().nodeId, enabled: false });
    await ready(
      () =>
        ![...a.core.diagnostics.peers.cache.values()].some(
          (entry) => entry.value.computerId === target() && entry.value.sampledAtMs > 0n,
        ),
    );
    expect((await a.api.getComputerDiagnostics({ computerId: target() })).calls).toEqual([]);
  });

  test("measures real heartbeat echoes without using the heartbeat interval as RTT", async () => {
    for (let index = 0; index < 3; index++) {
      b.worker.link.send({ case: "heartbeat", value: {} });
      await Bun.sleep(100);
    }

    const measured = await eventually(
      async () => b.core.diagnostics.links.get(`worker:${b.workerId}`)?.snapshot(15, "Worker", true, true),
      (value) => (value?.rttMs?.samples ?? 0n) >= 3n,
      40_000,
    );

    expect(measured?.rttMs?.samples).toBeGreaterThanOrEqual(3n);
    expect(measured?.heartbeatIntervalMs?.samples).toBeGreaterThanOrEqual(2n);
    expect(measured?.rttMs?.p95).toBeLessThan(measured!.heartbeatIntervalMs!.p95);
  }, 45_000);

  test("a restarted worker adds a new session without resetting or replaying its previous window", async () => {
    const link = a.core.diagnostics.links.get(`worker:${a.workerId}`)!;
    const before = link.snapshot(15, "Worker", true, true).rttMs!.samples;
    a.worker.link.close();

    const restarted = await a.connect(a.workerId, a.workerCredential, undefined, {
      hello: { capabilities: ["diagnostics_v1"] },
    });

    const report = create(ui.WorkerLinkDiagnosticsSchema, {
      session: crypto.randomUUID(),
      sequence: 1n,
      rtt: { indices: [20], counts: [7n], sum: 1, max: 1 },
      jitter: {},
    });

    restarted.link.send({ case: "diagnostics", value: report });
    await ready(() => link.watermark.session === report.session);
    expect(link.snapshot(15, "Worker", true, true).rttMs!.samples).toBe(before + 7n);
    restarted.link.send({ case: "diagnostics", value: report });
    await a.api.getClientCapabilities({});
    expect(link.snapshot(15, "Worker", true, true).rttMs!.samples).toBe(before + 7n);
    await a.core.diagnostics.persistence!.flush(true);
    const persisted = await a.core.diagnostics.persistence!.store.state();
    expect(
      persisted?.watermarks.some(
        (value) =>
          value.processId === `worker:${a.workerId}` && value.session === report.session && value.sequence === 1n,
      ),
    ).toBe(true);
  });

  test("keeps offline snapshots and unsupported computers visible without recursive gathering", async () => {
    await c.api.setDiagnosticsGrant({ originComputerId: nodes[0]!.hello().nodeId, enabled: true });

    for (const read of a.core.diagnostics.peers.reads.values()) read.due = 0;
    await a.core.diagnostics.peers.tick();
    await ready(async () =>
      (await diagnostics()).computers.some((computer) => computer.computerId === target() && computer.sampledAtMs > 0n),
    );
    let recursiveDenied = false;

    try {
      for await (const _ of nodes[0]!.remote(
        target(),
        link.DiagnosticsService.method.readDiagnosticsSnapshot,
        create(ui.ComputerDiagnosticsRequestSchema, { computerId: nodes[1]!.hello().nodeId }),
        AbortSignal.timeout(3000),
      )) {
      }
    } catch (error) {
      recursiveDenied = ConnectError.from(error).code === Code.PermissionDenied;
    }

    expect(recursiveDenied).toBe(true);
    await nodes[2]!.close();
    await ready(async () =>
      (await diagnostics()).computers.some(
        (computer) => computer.computerId === target() && computer.status === "offline" && computer.sampledAtMs > 0n,
      ),
    );
    const capabilities = nodes[1]!.hello().capabilities.filter((value) => value !== "diagnostics_v1");
    await nodes[1]!.close();
    nodes[1] = runtime(b, capabilities);
    b.core.computers = nodes[1];
    b.core.network = nodes[1].options.network;
    await nodes[1].start();
    await ready(() => nodes[0]!.reachable().includes(nodes[1]!.hello().nodeId));
    a.core.diagnostics.peers.invalidate(nodes[1].hello().nodeId, false);
    await ready(async () =>
      (await diagnostics()).computers.some(
        (computer) => computer.computerId === nodes[1]!.hello().nodeId && computer.status === "unsupported",
      ),
    );
    expect((await diagnostics()).computers).toHaveLength(3);
    expect((await diagnostics()).computers[0]?.droppedSamples).toBe(0n);
  }, 120_000);
});
