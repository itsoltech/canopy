import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { create, toBinary, toJsonString } from "@bufbuild/protobuf";
import { Provider, ui } from "@canopy/contracts";
import { ClientMeasurements, clientMetric, DiagnosticsEpochs, Histogram } from "@canopy/domain/diagnostics";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { SqlClient } from "effect/sql";
import { processGovernor } from "@canopy/process-governor";
import { ClientDiagnostics } from "../../apps/gateway/src/diagnostics/clients.ts";
import { DiagnosticsStore } from "../../apps/gateway/src/diagnostics/store.ts";
import { diagnosticReport, REPORT_BYTES } from "../../apps/gateway/src/diagnostics/report.ts";
import { SERVICE_TOKEN, eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { NetworkAccess } from "../../apps/gateway/src/network/network.ts";
import { mountMobileNetwork } from "../../apps/gateway/src/network/devices.ts";
import { nodePinnedTransport } from "./support/phone.ts";
import { routedMobileClient } from "../../apps/mobile/src/api/routes.ts";

const rejectedCode = (promise: Promise<object>) =>
  promise.then(
    () => 0,
    (error) => ConnectError.from(error).code,
  );

describe.skipIf(!dockerAvailable)("client diagnostics auth, redaction and explicit actions", () => {
  let gw: TestGateway;
  let projectId = "";
  let workspaceId = "";
  let network: NetworkAccess | undefined;
  let unmount: (() => void) | undefined;
  const headers = { "canopy-diagnostics-client": "b".repeat(43) };
  const sample = new ClientMeasurements("web", crypto.randomUUID());

  const query = <A extends object>(sql: string, ...params: string[]) =>
    gw.runtime.runPromise(SqlClient.SqlClient.use((client) => client.unsafe<A>(sql, params)));

  const detail = () => gw.api.getComputerDiagnostics({ computerId: "local", windowMinutes: 15 });
  const report = () => gw.api.prepareDiagnosticsReport({ computerIds: ["local"], windowMinutes: 15, format: "json" });

  const placement = () => ({
    projectId,
    workspaceId,
    workerId: gw.workerId,
    provider: Provider.CODEX,
    clientRequestId: crypto.randomUUID(),
  });

  async function restart() {
    const storage = {
      pg: gw.pg,
      secretsKey: gw.secretsKey,
      workerId: gw.workerId,
      workerCredential: gw.workerCredential,
    };

    await gw.close(true);
    gw = await startTestGateway({ diagnostics: true, storage });
    await gw.core.diagnostics.start();
    await gw.core.diagnostics.persistence!.start();
  }

  beforeAll(async () => {
    gw = await startTestGateway({ diagnostics: true });
    await gw.core.diagnostics.start();
    await gw.core.diagnostics.persistence!.start();
    gw.worker.holdTurns = true;
    projectId = (await gw.api.createProject({ name: "Private project name" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/private-path" }))
      .workspace!.id;
    sample.clear((await detail()).epoch);
  }, 60_000);
  afterAll(async () => {
    unmount?.();
    await network?.close();
    await gw?.close();
  });

  test("auth-bound batches deduplicate, fence epochs and reject arbitrary metric identities", async () => {
    sample.record(1, 42);
    const batch = sample.take();
    expect(await rejectedCode(gw.api.submitDiagnostics(batch))).toBe(Code.Unauthenticated);
    expect((await gw.api.submitDiagnostics(batch, { headers })).accepted).toBe(true);
    expect((await gw.api.submitDiagnostics(batch, { headers })).accepted).toBe(false);
    expect(
      (await gw.api.submitDiagnostics({ ...batch, sequence: batch.sequence + 1n, epoch: "old" }, { headers })).accepted,
    ).toBe(false);

    for (const bad of [
      { ...batch, source: "SQL SELECT secret" },
      { ...batch, samplingRate: 1 },
      { ...batch, measures: [{ ...batch.measures[0]!, metricId: 1 }] },
      { ...batch, measures: [{ ...batch.measures[0]!, rpcMethodId: 10 }] },
      {
        ...batch,
        measures: [{ ...batch.measures[0]!, histogram: { ...batch.measures[0]!.histogram!, indices: [2, 1] } }],
      },
      { ...batch, measures: [...batch.measures, ...batch.measures] },
    ]) {
      expect(await rejectedCode(gw.api.submitDiagnostics(bad, { headers }))).toBe(Code.InvalidArgument);
    }

    const sensitive = new TextEncoder().encode("SQL parameters secret");

    const row = {
      ...batch.measures[0]!,
      $unknown: [{ no: 99, wireType: 2, data: new Uint8Array([sensitive.length, ...sensitive]) }],
    };

    expect(
      (await gw.api.submitDiagnostics({ ...batch, sequence: batch.sequence + 2n, measures: [row] }, { headers }))
        .accepted,
    ).toBe(true);
    const process = gw.core.diagnostics.collector.rollup(Math.floor(Date.now() / 60_000) * 60_000)!;
    expect(new TextDecoder().decode(toBinary(ui.DiagnosticsProcessSchema, process))).not.toContain("secret");

    // The shared diagnostics view deliberately caches its aggregate for five seconds.
    const value = await eventually(
      detail,
      (value) => value.clientMeasures.some((measure) => measure.metricId === clientMetric("web", 1)),
      10_000,
    );

    expect(value.gatewayMeasures.every((measure) => measure.metricId < 300 || measure.metricId >= 400)).toBe(true);
    expect(value.clientMeasures.find((measure) => measure.metricId === clientMetric("web", 1))?.events).toBe(2n);
  }, 15_000);

  test("bounds wire size, sender cardinality and combined BFF/browser rate", () => {
    const collector = gw.core.diagnostics.collector;
    const clients = new ClientDiagnostics(collector, () => sample.epoch);
    const now = Date.now();
    const batch = create(ui.SubmitDiagnosticsRequestSchema, { ...sample.take(now), epoch: sample.epoch });

    const heavy = create(ui.SubmitDiagnosticsRequestSchema, {
      ...batch,
      $unknown: [{ no: 99, wireType: 2, data: new Uint8Array(17_000) }],
    });

    expect(() => clients.submit(heavy, "wire", false)).toThrow();
    const h = new Histogram();
    h.record(1);

    const rate = create(ui.SubmitDiagnosticsRequestSchema, {
      ...batch,
      source: "bff",
      samplingRate: 1,
      measures: [
        create(ui.DiagnosticsMeasureAggregateSchema, {
          metricId: clientMetric("bff", 6),
          events: 1n,
          histogram: h.snapshot(),
          sampledAtMs: batch.endMs,
        }),
      ],
      $unknown: [{ no: 99, wireType: 2, data: new Uint8Array(30_000) }],
    });

    expect(clients.submit(rate, "rate", true).accepted).toBe(true);
    expect(clients.submit({ ...rate, sequence: rate.sequence + 1n }, "rate", true).accepted).toBe(true);
    expect(() => clients.submit({ ...rate, sequence: rate.sequence + 2n }, "rate", true)).toThrow();

    for (let i = 0; i < 29; i++) clients.submit(batch, `bounded-${i}`, false);
    expect(() => clients.submit(batch, "overflow", false)).toThrow();
    expect(clients.senders.size).toBeLessThanOrEqual(30);
    expect(collector.budget.used).toBeLessThanOrEqual(6 * 1024 * 1024);
  });

  test("redacts identifiers and bounds reports with explicit omissions", async () => {
    const value = await detail();
    const secret = "private-name-path-secret";

    const fake = create(ui.ComputerDiagnosticsSchema, {
      ...value,
      name: secret,
      computerId: secret,
      processSession: secret,
      appVersion: secret,
      totalMethods: 400,
      findings: [
        create(ui.DiagnosticsFindingSchema, { ruleId: "db_slow", subject: secret, value: 1, severity: "warning" }),
      ],
      links: [
        create(ui.DiagnosticsLinkSchema, {
          name: secret,
          kind: "worker",
          targetId: secret,
          measures: value.gatewayMeasures,
        }),
        create(ui.DiagnosticsLinkSchema, { name: secret, kind: "computer", targetId: secret }),
      ],
    });

    const text = diagnosticReport([fake], "json");
    expect(text.text).not.toContain(secret);
    expect(text.text).toContain("Computer A");
    expect(text.text).toContain("Worker 1");
    expect(text.text).toContain("Computer link 2");
    expect(text.omittedSections).toContain("Computer A: unrequested call pages");
    expect(
      Buffer.byteLength(
        diagnosticReport(
          Array.from({ length: 16 }, () => fake),
          "markdown",
        ).text,
      ),
    ).toBeLessThanOrEqual(REPORT_BYTES);
    expect(
      await rejectedCode(gw.api.prepareDiagnosticsReport({ computerIds: [crypto.randomUUID()], format: "json" })),
    ).toBe(Code.NotFound);
    expect(
      await rejectedCode(
        gw.api.investigateDiagnostics({ ...placement(), report: { ...(await report()), text: secret } }),
      ),
    ).toBe(Code.InvalidArgument);
  });

  test("client checkpoints commit with their observations and reject replay after restart", async () => {
    const measurements = new ClientMeasurements("desktop", crypto.randomUUID());
    measurements.clear((await detail()).epoch);
    measurements.record(1, 31);
    const batch = measurements.take();
    expect((await gw.api.submitDiagnostics(batch, { headers })).accepted).toBe(true);
    await gw.core.diagnostics.persistence!.flush(true);
    const state = await new DiagnosticsStore(gw.runtime, gw.userId, "local").state();
    expect(state?.watermarks.some((value) => value.processId === "gateway" && value.session.length === 64)).toBe(true);
    await restart();
    expect((await gw.api.submitDiagnostics(batch, { headers })).accepted).toBe(false);
    expect((await detail()).clientMeasures.find((value) => value.metricId === clientMetric("desktop", 1))?.events).toBe(
      1n,
    );
  }, 60_000);

  test("owner-scoped placement and confirmation create one ordinary thread with the preview attached", async () => {
    const preview = await report();
    const foreign = crypto.randomUUID();
    await query(
      "INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Foreign','user')",
      foreign,
      `${foreign}@example.test`,
    );
    const foreignProject = crypto.randomUUID();
    await query(
      "INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$2::uuid,'Foreign','foreign')",
      foreignProject,
      foreign,
    );
    expect(
      await rejectedCode(gw.api.investigateDiagnostics({ ...placement(), projectId: foreignProject, report: preview })),
    ).toBe(Code.NotFound);
    const request = create(ui.InvestigateDiagnosticsRequestSchema, { ...placement(), report: preview });
    const [a, b] = await Promise.all([gw.api.investigateDiagnostics(request), gw.api.investigateDiagnostics(request)]);
    expect(a.threadId).toBe(b.threadId);
    const thread = (await gw.api.getThread({ threadId: a.threadId })).thread!;
    expect(thread.projectId).toBe(projectId);
    expect(thread.workerId).toBe(gw.workerId);
    await eventually(
      () => Promise.resolve([...gw.worker.attachments.values()].flat()),
      (files) => files.some((file) => file.name === "diagnostics-report.json"),
    );

    const receipt = await query<{ n: number }>(
      "SELECT count(*)::int n FROM diagnostics_investigations WHERE owner_user_id=$1::uuid AND request_id=$2::uuid",
      gw.userId,
      request.clientRequestId,
    );

    expect(receipt[0]?.n).toBe(1);
    expect(await rejectedCode(gw.api.investigateDiagnostics({ ...request, model: "different" }))).toBe(
      Code.AlreadyExists,
    );

    // A committed receipt survives gateway restart, even though the ephemeral preview signer changes.
    await restart();
    expect((await gw.api.investigateDiagnostics(request)).threadId).toBe(a.threadId);
  }, 60_000);

  test("reset persists the epoch, rejects old batches and responses, and preserves runtime governor state", async () => {
    const before = await detail();
    const old = create(ui.ComputerDiagnosticsSchema, before);
    const governor = processGovernor.snapshot();

    await gw.core.diagnostics.persistence!.flush(true);
    const history = await query<{ n: number }>("SELECT count(*)::int n FROM diagnostics_rollups");
    await query(`CREATE FUNCTION reject_diagnostics_reset() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'private diagnostics payload and parameters'; END $$`);
    await query(`CREATE TRIGGER reject_reset BEFORE INSERT OR UPDATE ON diagnostics_state
      FOR EACH ROW EXECUTE FUNCTION reject_diagnostics_reset()`);
    const printed: string[] = [];

    const warnings = spyOn(console, "error").mockImplementation((...values: unknown[]) => {
      printed.push(values.map(String).join(" "));
    });

    try {
      expect(
        await rejectedCode(
          gw.api.resetDiagnostics({
            computerId: "local",
            processId: "gateway",
            epoch: before.epoch,
            actionId: crypto.randomUUID(),
          }),
        ),
      ).toBe(Code.Internal);
      expect((await detail()).epoch).toBe(before.epoch);
      expect((await new DiagnosticsStore(gw.runtime, gw.userId, "local").state())?.epoch).toBe(before.epoch);
      expect(await query("SELECT count(*)::int n FROM diagnostics_rollups")).toEqual(history);
      expect(printed.join(" ")).not.toContain("private diagnostics payload");
    } finally {
      warnings.mockRestore();
      await query("DROP TRIGGER reject_reset ON diagnostics_state");
      await query("DROP FUNCTION reject_diagnostics_reset()");
    }

    const reset = await gw.api.resetDiagnostics({
      computerId: "local",
      processId: "gateway",
      epoch: before.epoch,
      actionId: crypto.randomUUID(),
    });

    expect(reset.accepted).toBe(true);
    expect(reset.epoch).not.toBe(before.epoch);
    const epochs = new DiagnosticsEpochs();
    epochs.reset("local", reset.epoch, reset.epochStartedAtMs);
    expect(epochs.accept(old)).toBe(false);
    expect((await detail()).epoch).toBe(reset.epoch);
    expect((await new DiagnosticsStore(gw.runtime, gw.userId, "local").state())?.epoch).toBe(reset.epoch);
    expect(processGovernor.snapshot()).toEqual(governor);
    sample.clear(before.epoch);
    sample.record(1, 11);
    expect((await gw.api.submitDiagnostics(sample.take(), { headers })).accepted).toBe(false);
    expect(
      await rejectedCode(
        gw.api.resetDiagnostics({
          computerId: "local",
          processId: "gateway",
          epoch: before.epoch,
          actionId: crypto.randomUUID(),
        }),
      ),
    ).toBe(Code.FailedPrecondition);
    expect(
      await rejectedCode(
        gw.api.resetDiagnostics({
          computerId: crypto.randomUUID(),
          processId: "gateway",
          epoch: reset.epoch,
          actionId: crypto.randomUUID(),
        }),
      ),
    ).toBe(Code.FailedPrecondition);
  });

  test("one worker reset preserves gateway history and fences pre-baseline batches after restart", async () => {
    const processId = `worker:${gw.workerId}`;
    const before = await detail();
    const session = crypto.randomUUID();

    const stale = create(ui.WorkerLinkDiagnosticsSchema, {
      session,
      sequence: 1n,
      startMs: BigInt(Date.now() - 30_000),
      endMs: BigInt(Date.now()),
      rtt: { indices: [1], counts: [1n], sum: 0.001, min: 0.001, max: 0.001 },
      jitter: { indices: [1], counts: [1n], sum: 0.001, min: 0.001, max: 0.001 },
      workerMeasuresSupported: true,
    });

    const reset = await gw.api.resetDiagnostics({
      computerId: "local",
      processId,
      epoch: before.epoch,
      actionId: crypto.randomUUID(),
    });

    const gatewayCalls = (await detail()).totalMethods;
    expect(gatewayCalls).toBeGreaterThan(0);
    await restart();
    expect((await detail()).epoch).toBe(reset.epoch);
    const link = gw.core.diagnostics.links.get(processId)!;
    expect(link.resetAt).toBe(Number(reset.epochStartedAtMs));
    expect(link.report(stale)).toBe(true);
    expect(link.snapshot(15, "Worker", true, true).rttMs).toBeUndefined();
    expect(
      link.report({ ...stale, sequence: 2n, startMs: reset.epochStartedAtMs, endMs: reset.epochStartedAtMs + 1n }),
    ).toBe(true);
    expect(link.snapshot(15, "Worker", true, true).rttMs?.samples).toBe(1n);
    expect((await detail()).totalMethods).toBeGreaterThanOrEqual(gatewayCalls);
  }, 60_000);

  test("paired mobile ingestion is bound to its owner and stops immediately after revoke", async () => {
    network = new NetworkAccess({ store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey), host: "127.0.0.1" });
    gw.core.network = network;
    unmount = mountMobileNetwork(gw.core, network, SERVICE_TOKEN);
    await network.start();
    await network.update(create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }));
    const transport = nodePinnedTransport();
    const invitation = await gw.api.createMobilePairing({});

    const phone = (token?: string) =>
      routedMobileClient({ connection: gw.core.mobile.networkRoutes(), transport, ...(token && { token }) });

    const paired = await phone().pairing.exchangeMobilePairing({
      code: invitation.code,
      name: "Diagnostics phone",
      platform: "ios",
    });

    const api = phone(paired.deviceToken).api;
    const collector = new ClientMeasurements("mobile", crypto.randomUUID());
    collector.clear((await detail()).epoch);
    collector.record(5, 80);
    const batch = collector.take();
    expect((await api.submitDiagnostics(batch)).accepted).toBe(true);
    expect(await rejectedCode(api.submitDiagnostics({ ...batch, source: "bff", samplingRate: 1 }))).toBe(
      Code.PermissionDenied,
    );
    await gw.api.revokeMobileDevice({ id: paired.device!.id });
    expect(await rejectedCode(api.submitDiagnostics({ ...batch, sequence: batch.sequence + 1n }))).toBe(
      Code.Unauthenticated,
    );
    expect(toJsonString(ui.ComputerDiagnosticsSchema, await detail())).not.toContain(paired.deviceToken);
  }, 30_000);
});
