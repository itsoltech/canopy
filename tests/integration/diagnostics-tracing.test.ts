import { afterAll, beforeAll, describe, expect, test, spyOn } from "bun:test";
import { toBinary, toJsonString } from "@bufbuild/protobuf";
import { ui, computerLink } from "@canopy/contracts";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { dockerAvailable } from "@canopy/db/testing";
import { DiagnosticsTrace, TRACE_LIMITS, governorMetric, traceState } from "@canopy/domain/diagnostics";
import { processGovernor } from "@canopy/process-governor";
import { SqlClient } from "effect/sql";
import { WorkerTracing } from "../../apps/worker/src/diagnostics/tracing.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { linkedComputers } from "./support/computers.ts";
import { startTestGateway, eventually, type TestGateway } from "./support/gateway.ts";

const code = (promise: Promise<object>) =>
  promise.then(
    () => 0,
    (error) => ConnectError.from(error).code,
  );

test("trace sampling, rate, ring, monotonic expiry and restart limits are enforced without payload storage", () => {
  let now = 0;

  const trace = new DiagnosticsTrace(
    () => now,
    () => 100000 + now,
  );

  const lease = crypto.randomUUID();
  expect(trace.start(lease, "gateway", 11)).toBe(false);
  expect(trace.start(lease, "gateway", 5)).toBe(true);
  // An observer's different wall clock must not override the home's monotonic lease.
  expect(traceState(trace.state())?.active).toBe(true);
  expect(traceState({ ...trace.state(), processId: "SELECT private_parameter" })).toBeUndefined();
  expect(trace.start(crypto.randomUUID(), "gateway", 1)).toBe(false);

  for (let i = 0; i < TRACE_LIMITS.stride - 1; i++) trace.record("ingest", 22, 1);
  expect(trace.export(lease)?.spans.length).toBe(0);
  trace.record("ingest", 22, 1);
  expect(trace.export(lease)?.spans.length).toBe(1);

  for (let i = 0; i < 20000; i++) trace.record("ingest", 22, 2);
  expect(trace.export(lease)?.spans.length).toBe(TRACE_LIMITS.perSecond);
  expect(trace.export(lease)?.droppedSamples).toBeGreaterThan(0n);

  for (let second = 1; second <= Math.ceil(TRACE_LIMITS.samples / TRACE_LIMITS.perSecond) + 2; second++) {
    now = second * 1000;

    for (let i = 0; i < 10000; i++) trace.record("ingest", 22, 3);
  }

  const result = trace.export(lease)!;
  expect(result.spans.length).toBe(TRACE_LIMITS.samples);
  expect(new Set(result.spans.map((span) => span.traceId)).size).toBe(TRACE_LIMITS.samples);
  expect(toBinary(ui.DiagnosticsTraceExportSchema, result).length).toBeLessThan(TRACE_LIMITS.bytes);
  expect(trace.stop(crypto.randomUUID())).toBe(false);
  now = 300001;
  expect(trace.state().active).toBe(false);
  const count = result.droppedSamples;
  trace.record("ingest", 22, 4);
  expect(trace.export(lease)?.droppedSamples).toBe(count);
  now += 600000;
  expect(trace.export(lease)).toBeUndefined();
  expect(new DiagnosticsTrace().state().active).toBe(false);
});

describe.skipIf(!dockerAvailable)("owner-scoped opt-in tracing over gRPC and WorkerLink", () => {
  const gateways: TestGateway[] = [];
  const nodes: ReturnType<typeof linkedComputers>[] = [];
  const worker = new WorkerTracing();

  const request = (side = 0, action = "start", processId = "gateway") => ({
    computerId: nodes[side]!.hello().nodeId,
    processId,
    action,
    minutes: 1,
  });

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const options: NonNullable<Parameters<typeof startTestGateway>[0]> = {
        role: "desktop",
        diagnostics: true,
      };

      if (i === 0)
        options.worker = { tracing: worker, hello: { capabilities: ["diagnostics_v1", "diagnostics_trace_v1"] } };
      const gateway = await startTestGateway(options);

      gateways.push(gateway);
      await gateway.core.diagnostics.start();
      const store = new ComputerStore(gateway.runtime, gateway.userId, gateway.secretsKey);

      const node = linkedComputers({
        host: "127.0.0.1",
        store,
        core: gateway.core,
        serve: remoteServe(uiHandlers(gateway.core), gateway.core),
        heartbeatMs: 1000,
      });

      gateway.core.computers = node;
      nodes.push(node);
      await node.start();
    }

    const invitation = await gateways[1]!.api.createComputerPairing({});
    await gateways[0]!.api.linkComputer({ address: nodes[1]!.addresses[0]!, code: invitation.code });
    await eventually(() => Promise.resolve(nodes[0]!.canCall(nodes[1]!.hello().nodeId)), Boolean);
  }, 60000);

  afterAll(async () => {
    worker.close();

    for (const node of nodes) await node.close();

    for (const gateway of gateways) await gateway.close();
  });

  test("start is explicit for one home; samples require a separate export; stops and stale leases are fenced", async () => {
    const gateway = gateways[0]!;
    const unauthenticated = createClient(ui.GatewayService, createGrpcTransport({ baseUrl: gateway.grpcUrl }));
    expect(await code(unauthenticated.controlDiagnosticsTrace(request()))).toBe(Code.Unauthenticated);
    expect(await code(gateway.api.controlDiagnosticsTrace({ ...request(), minutes: 11 }))).toBe(Code.InvalidArgument);
    expect(gateways[1]!.core.diagnostics.tracing.state().active).toBe(false);
    const state = await gateway.api.controlDiagnosticsTrace(request());
    expect(state.active).toBe(true);
    expect(await code(gateway.api.controlDiagnosticsTrace(request()))).toBe(Code.ResourceExhausted);
    expect(gateways[1]!.core.diagnostics.tracing.state().active).toBe(false);
    const secret = "SELECT private_parameter /home/private secret-token";

    const query = () =>
      gateway.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe("SELECT $1::text", [secret])));

    for (let i = 0; i < 200; i++) {
      await gateway.api.getDiagnostics({});
      await query();
    }

    for (let i = 0; i < 202; i++)
      await gateway.runtime
        .runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe("SELECT $1::uuid", [secret])))
        .catch(() => {});

    const snapshot = await gateway.api.getComputerDiagnostics(request());
    expect(snapshot.tracing?.active).toBe(true);
    expect(toJsonString(ui.ComputerDiagnosticsSchema, snapshot)).not.toContain("traceId");
    const exportRequest = { ...request(), leaseId: state.leaseId };
    const exported = await gateway.api.exportDiagnosticsTrace(exportRequest);
    expect(exported.spans.length).toBeGreaterThan(0);
    expect(exported.spans.some((span) => span.operation === "rpc")).toBe(true);
    expect(exported.spans.some((span) => span.failed)).toBe(true);
    const text = toJsonString(ui.DiagnosticsTraceExportSchema, exported);

    for (const token of [secret, "SELECT", "private_parameter", "parameters", "cause", "stack", "secret-token"])
      expect(text).not.toContain(token);
    expect(await code(gateway.api.exportDiagnosticsTrace({ ...exportRequest, leaseId: crypto.randomUUID() }))).toBe(
      Code.FailedPrecondition,
    );
    expect((await gateway.api.controlDiagnosticsTrace({ ...exportRequest, action: "stop" })).active).toBe(false);
    const remote = await gateway.api.controlDiagnosticsTrace(request(1));
    expect(remote.active).toBe(true);
    expect(gateway.core.diagnostics.tracing.state().active).toBe(false);
    expect((await gateway.api.exportDiagnosticsTrace({ ...request(1), leaseId: remote.leaseId })).state?.leaseId).toBe(
      remote.leaseId,
    );
    expect(await code(gateway.api.controlDiagnosticsTrace({ ...request(), computerId: "f".repeat(64) }))).toBe(
      Code.FailedPrecondition,
    );
    await gateway.api.controlDiagnosticsTrace({ ...request(1, "stop"), leaseId: remote.leaseId });
    expect(computerLink.DiagnosticsService.method.controlHomeDiagnosticsTrace.methodKind).toBe("unary");
  });

  test.each(["local", "linked", "worker"])("%s exports honor legacy and expanded reader limits", async (kind) => {
    const gateway = gateways[0]!;

    const input = request(
      kind === "linked" ? 1 : 0,
      "start",
      kind === "worker" ? `worker:${gateway.workerId}` : "gateway",
    );

    const state = await gateway.api.controlDiagnosticsTrace({ ...input, minutes: 5 });

    const trace =
      kind === "worker" ? worker.trace : gateways[kind === "linked" ? 1 : 0]!.core.diagnostics.collector.tracing;

    let now = performance.now();
    const clock = spyOn(trace, "monotonic").mockImplementation(() => now);

    try {
      for (let sample = 0; sample < 2112; sample++) {
        now += 100;

        for (let call = 0; call < TRACE_LIMITS.stride; call++)
          trace.record("governor", governorMetric("utility", "user", "execution"), 0.1);
      }

      const exportRequest = { ...input, leaseId: state.leaseId };
      const legacy = await gateway.api.exportDiagnosticsTrace(exportRequest);
      const expanded = await gateway.api.exportDiagnosticsTrace({ ...exportRequest, maxSamples: TRACE_LIMITS.samples });
      expect(legacy.spans).toHaveLength(2000);
      expect(expanded.spans.length).toBeGreaterThan(2000);
      expect(expanded.spans.length).toBeLessThanOrEqual(TRACE_LIMITS.samples);
      expect(expanded.droppedSamples).toBeLessThan(legacy.droppedSamples);
      const bounded = await gateway.api.exportDiagnosticsTrace({ ...exportRequest, maxSamples: 1 });
      expect(bounded.spans).toHaveLength(1);
    } finally {
      clock.mockRestore();
      await gateway.api.controlDiagnosticsTrace({ ...input, action: "stop", leaseId: state.leaseId });
    }
  });

  test("worker lease records governor timings and explicit stop detaches; no restart or expiry activation", async () => {
    const gateway = gateways[0]!;
    const input = request(0, "start", `worker:${gateway.workerId}`);
    expect(
      await code(gateway.api.controlDiagnosticsTrace({ ...input, processId: `worker:${gateways[1]!.workerId}` })),
    ).toBe(Code.FailedPrecondition);
    const state = await gateway.api.controlDiagnosticsTrace(input);

    for (let i = 0; i < 150; i++) await processGovernor.run({ kind: "utility" }, async () => 1);
    const exported = await gateway.api.exportDiagnosticsTrace({ ...input, leaseId: state.leaseId });
    expect(exported.spans.length).toBeGreaterThan(0);
    expect(exported.spans.every((span) => span.operation === "governor")).toBe(true);
    expect(exported.spans.some((span) => span.operationId === governorMetric("utility", "user", "wait"))).toBe(true);
    const raw = worker.trace.export(state.leaseId)!;
    const privateText = new TextEncoder().encode("private-worker-SQL-parameter");
    raw.spans[0]!.operationName = "private-worker-SQL-parameter";
    raw.spans[0]!.$unknown = [{ no: 99, wireType: 2, data: new Uint8Array([privateText.length, ...privateText]) }];
    const malicious = spyOn(worker.trace, "export").mockReturnValue(raw);

    try {
      const clean = await gateway.api.exportDiagnosticsTrace({ ...input, leaseId: state.leaseId });
      expect(toJsonString(ui.DiagnosticsTraceExportSchema, clean)).not.toContain("private-worker-SQL-parameter");
      expect(clean.spans[0]!.operationName).toContain("utility");
    } finally {
      malicious.mockRestore();
    }

    expect(
      (await gateway.api.controlDiagnosticsTrace({ ...input, action: "stop", leaseId: state.leaseId })).active,
    ).toBe(false);
    const fresh = await gateway.api.controlDiagnosticsTrace(input);
    expect(fresh.leaseId).not.toBe(state.leaseId);
    expect(await code(gateway.api.exportDiagnosticsTrace({ ...input, leaseId: state.leaseId }))).toBe(
      Code.FailedPrecondition,
    );
    worker.close();
    expect(worker.trace.state().active).toBe(false);
    expect(await code(gateway.api.exportDiagnosticsTrace({ ...input, leaseId: fresh.leaseId }))).toBe(
      Code.FailedPrecondition,
    );
    await gateway.api.controlDiagnosticsTrace({ ...input, action: "stop", leaseId: fresh.leaseId }).catch(() => {});
    await gateway.core.diagnostics.tracing.close();
    const timer = spyOn(globalThis, "setTimeout");
    const current = await gateway.api.controlDiagnosticsTrace(request());
    const expire = timer.mock.calls.find(([, delay]) => delay === 60000)?.[0];
    timer.mockRestore();
    expect(expire).toBeDefined();

    if (expire) expire();
    expect(gateway.core.diagnostics.tracing.state().active).toBe(false);
    expect(gateway.core.diagnostics.collector.tracing.state().active).toBe(false);
    expect((await gateway.api.exportDiagnosticsTrace({ ...request(), leaseId: current.leaseId })).state?.active).toBe(
      false,
    );

    const audits = await gateway.runtime.runPromise(
      SqlClient.SqlClient.use((sql) =>
        sql.unsafe<{ result: string }>(
          "SELECT details->>'result' AS result FROM audit_log WHERE actor_user_id=$1::uuid AND action='diagnostics.tracing'",
          [gateway.userId],
        ),
      ),
    );

    for (const result of ["start", "stop", "export", "expiry"])
      expect(audits.some((row) => row.result === result)).toBe(true);
  });

  test("gateway restart never restores an active lease or its samples", async () => {
    const gateway = gateways[1]!;
    const state = await gateway.api.controlDiagnosticsTrace(request(1));
    expect(state.active).toBe(true);

    const storage = {
      pg: gateway.pg,
      secretsKey: gateway.secretsKey,
      workerId: gateway.workerId,
      workerCredential: gateway.workerCredential,
    };

    await nodes.pop()!.close();
    await gateway.close(true);
    const restarted = await startTestGateway({ diagnostics: true, storage });
    gateways[1] = restarted;
    expect((await restarted.api.getComputerDiagnostics({ computerId: "local" })).tracing?.active).toBe(false);
    expect(
      await code(
        restarted.api.exportDiagnosticsTrace({ computerId: "local", processId: "gateway", leaseId: state.leaseId }),
      ),
    ).toBe(Code.FailedPrecondition);
  });
});
