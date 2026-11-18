import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { computerLink as link } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { saveUsagePage, usageCursor } from "../../apps/gateway/src/computers/usage-store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const hour = new Date(new Date().toISOString().slice(0, 13) + ":00:00.000Z");

describe.skipIf(!dockerAvailable)("estimated API costs across pinned computer links", () => {
  let a: TestGateway;
  let b: TestGateway;
  let sa: ComputerStore;
  let sb: ComputerStore;
  let la: ReturnType<typeof linkedComputers>;
  let lb: ReturnType<typeof linkedComputers>;
  let node = "";

  function attach(gateway: TestGateway, store: ComputerStore) {
    const linked = linkedComputers({ store, host: "127.0.0.1", heartbeatMs: 100 });
    gateway.core.computers = linked;
    gateway.core.network = linked.options.network;

    return linked;
  }

  async function synced(revision: bigint) {
    la.usage.connected(node);
    expect(
      await eventually(
        () => usageCursor(sa, node),
        (value) => value === revision,
        10_000,
      ),
    ).toBe(revision);
  }

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    sa = new ComputerStore(a.runtime, a.userId, randomBytes(32));
    sb = new ComputerStore(b.runtime, b.userId, randomBytes(32));
    la = attach(a, sa);
    lb = attach(b, sb);
    await la.start();
    await lb.start();
    node = lb.hello().nodeId;
    await sb.query(
      `INSERT INTO usage_buckets(owner_user_id,bucket_start,provider,model,requested_service_tier,input_tokens,
       reports,unknown_cost_reports,estimated_cost_usd,effective_cost_usd,effective_estimated_cost_reports,revision)
       VALUES($1::uuid,$2,'codex','gpt-6.1-sol','fast',100,1,1,1.5,1.5,1,1)`,
      [sb.owner, hour],
    );
    await sb.query(
      `INSERT INTO usage_state(owner_user_id,computer_id,revision)
       SELECT $1::uuid,node_id,1 FROM computer_identity WHERE owner_user_id=$1::uuid
       ON CONFLICT(owner_user_id) DO UPDATE SET revision=excluded.revision`,
      [sb.owner],
    );
    const invitation = await a.api.createComputerPairing({});
    await b.api.linkComputer({ address: la.addresses[0]!, code: invitation.code });
    await synced(1n);
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 20_000);

  test("source estimates survive import and a lower reported correction replaces their displayed cost", async () => {
    const request = { days: 1, computerId: node, requestedServiceTier: "fast" };
    const first = await a.api.getUsageStats(request);

    expect(first.totals).toMatchObject({
      inputTokens: 100n,
      estimatedCostUsd: 1.5,
      effectiveCostUsd: 1.5,
      effectiveEstimatedCostReports: 1n,
      unknownEffectiveCostReports: 0n,
    });
    await sb.query(
      `UPDATE usage_buckets SET reported_cost_usd=1.2,unknown_cost_reports=0,effective_cost_usd=1.2,
       effective_reported_cost_reports=1,effective_estimated_cost_reports=0,revision=2 WHERE owner_user_id=$1::uuid`,
      [sb.owner],
    );
    await sb.query("UPDATE usage_state SET revision=2 WHERE owner_user_id=$1::uuid", [sb.owner]);
    await synced(2n);
    const corrected = await a.api.getUsageStats(request);

    expect(corrected.totals).toMatchObject({
      inputTokens: 100n,
      reportedCostUsd: 1.2,
      estimatedCostUsd: 1.5,
      effectiveCostUsd: 1.2,
      effectiveReportedCostReports: 1n,
      effectiveEstimatedCostReports: 0n,
      reports: 1n,
    });
    await la.close();
    await lb.close();
    la = attach(a, sa);
    await la.start();
    const offline = await a.api.getUsageStats(request);

    expect(offline.totals).toMatchObject({ effectiveCostUsd: 1.2, estimatedCostUsd: 1.5, reports: 1n });
    expect(offline.sources.find((source) => source.computerId === node)?.online).toBe(false);
  }, 20_000);

  test("invalid monetary or source coverage totals cannot advance the checkpoint", async () => {
    const page = create(link.UsageBucketsResponseSchema, {
      trackingSince: timestampFromDate(hour),
      nextRevision: 3n,
      buckets: [
        {
          bucketStart: timestampFromDate(hour),
          provider: "codex",
          model: "gpt-6.1-sol",
          requestedServiceTier: "fast",
          revision: 3n,
          totals: {
            reports: 1n,
            unknownCostReports: 1n,
            estimatedCostUsd: 2,
            effectiveCostUsd: 2,
            effectiveEstimatedCostReports: 1n,
          },
        },
      ],
    });

    const totals = page.buckets[0]!.totals!;
    totals.estimatedCostUsd = Number.NaN;
    await expect(saveUsagePage(sa, node, 2n, page, 256)).rejects.toThrow("Invalid linked usage page");
    totals.estimatedCostUsd = 2;
    totals.effectiveCostUsd = -1;
    await expect(saveUsagePage(sa, node, 2n, page, 256)).rejects.toThrow("Invalid linked usage page");
    totals.effectiveCostUsd = 2;
    totals.effectiveReportedCostReports = 1n;
    await expect(saveUsagePage(sa, node, 2n, page, 256)).rejects.toThrow("Invalid linked usage page");
    totals.effectiveReportedCostReports = 0n;
    totals.unknownEstimatedCostReports = 1n;
    await expect(saveUsagePage(sa, node, 2n, page, 256)).rejects.toThrow("Invalid linked usage page");
    expect(await usageCursor(sa, node)).toBe(2n);
  });

  test("legacy snapshots retain complete reported cost and do not invent an estimate", async () => {
    const page = create(link.UsageBucketsResponseSchema, {
      trackingSince: timestampFromDate(hour),
      nextRevision: 4n,
      buckets: [
        {
          bucketStart: timestampFromDate(hour),
          provider: "codex",
          model: "legacy-known",
          revision: 3n,
          totals: { reports: 1n, reportedCostUsd: 0.5 },
        },
        {
          bucketStart: timestampFromDate(hour),
          provider: "codex",
          model: "legacy-partial",
          revision: 4n,
          totals: { reports: 2n, reportedCostUsd: 0.75, unknownCostReports: 1n },
        },
      ],
    });

    await saveUsagePage(sa, node, 2n, page, 256);
    await saveUsagePage(sa, node, 2n, page, 256);
    const stats = await a.api.getUsageStats({ days: 1, computerId: node });

    expect(stats.models.find((model) => model.key === "legacy-known")?.totals).toMatchObject({
      reportedCostUsd: 0.5,
      effectiveCostUsd: 0.5,
      unknownEstimatedCostReports: 1n,
      effectiveReportedCostReports: 1n,
    });
    expect(stats.models.find((model) => model.key === "legacy-partial")?.totals).toMatchObject({
      reportedCostUsd: 0.75,
      effectiveCostUsd: 0,
      unknownEstimatedCostReports: 2n,
      unknownEffectiveCostReports: 2n,
    });
    expect(stats.totals?.reports).toBe(4n);
    expect(stats.totals?.effectiveCostUsd).toBe(1.7);
  });
});
