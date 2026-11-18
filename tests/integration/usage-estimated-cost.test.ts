import { describe, expect, test } from "bun:test";
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { CommandResultSchema, Provider, ThreadEventSchema, UsageSchema, UsageScope } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Ingest } from "@canopy/gateway/store";
import { accountGeneration } from "../../apps/gateway/src/usage/generation.ts";
import { SqlClient } from "effect/sql";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

async function running(gw: TestGateway) {
  gw.worker.holdTurns = true;
  const project = (await gw.api.createProject({ name: "Estimates" })).project!;

  const workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo" }))
    .workspace!;

  const thread = (
    await gw.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      title: "Estimates",
      initialMessage: "Wait",
      clientRequestId: Bun.randomUUIDv7(),
    })
  ).thread!;

  const turns = await eventually(
    () =>
      gw.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) => sql<{ id: string; status: string }>`SELECT id,status FROM turns WHERE thread_id=${thread.id}::uuid`,
        ),
      ),
    (rows) => rows[0]?.status === "running",
  );

  return { threadId: thread.id, turnId: turns[0]!.id };
}

describe.skipIf(!dockerAvailable)("estimated API-equivalent accounting", () => {
  test("aggregate effective amounts select independent overlapping prices per counter", async () => {
    const gw = await startTestGateway();

    try {
      const result = create(CommandResultSchema, {
        commandId: Bun.randomUUIDv7(),
        ok: true,
        consumedUsages: [
          {
            scope: UsageScope.TURN,
            model: "both",
            inputTokens: 100n,
            reportedCostUsd: 3,
            estimatedCostUsd: 5,
            pricingVersion: "quote",
          },
          {
            scope: UsageScope.TURN,
            model: "estimate",
            inputTokens: 100n,
            estimatedCostUsd: 2,
            pricingVersion: "quote",
          },
          { scope: UsageScope.TURN, model: "unknown", inputTokens: 100n },
        ],
      });

      await accountGeneration(gw.runtime, gw.userId, Provider.CODEX, "", result);
      await accountGeneration(gw.runtime, gw.userId, Provider.CODEX, "", result);
      expect((await gw.api.getUsageStats({ days: 1 })).totals).toMatchObject({
        inputTokens: 300n,
        reports: 3n,
        reportedCostUsd: 3,
        estimatedCostUsd: 7,
        effectiveCostUsd: 5,
        unknownCostReports: 2n,
        unknownEstimatedCostReports: 1n,
        unknownEffectiveCostReports: 1n,
        effectiveReportedCostReports: 1n,
        effectiveEstimatedCostReports: 1n,
      });
      // A late known zero for the estimated-only counter reduces effective total, never either independent sum.
      const estimated = result.consumedUsages.find((u) => u.model === "estimate")!;
      estimated.reportedCostUsd = 0;
      await accountGeneration(gw.runtime, gw.userId, Provider.CODEX, "", result);
      expect((await gw.api.getUsageStats({ days: 1 })).totals).toMatchObject({
        reports: 3n,
        reportedCostUsd: 3,
        estimatedCostUsd: 7,
        effectiveCostUsd: 3,
        unknownCostReports: 1n,
        unknownEstimatedCostReports: 1n,
        unknownEffectiveCostReports: 1n,
        effectiveReportedCostReports: 2n,
        effectiveEstimatedCostReports: 0n,
      });
    } finally {
      await gw.close();
    }
  }, 60_000);

  test("gRPC estimates, independent corrections, unknown growth and tier relocation survive restart", async () => {
    let gw = await startTestGateway();

    try {
      const target = await running(gw);
      // Leave the stored turn unknown: a later observation must relocate its entire contribution.
      await gw.runtime.runPromise(
        SqlClient.SqlClient.use((sql) => sql`UPDATE turns SET service_tier='' WHERE id=${target.turnId}::uuid`),
      );
      let seq = 0n;

      const sample = (values: MessageInitShape<typeof UsageSchema>) =>
        create(UsageSchema, {
          scope: UsageScope.TURN,
          model: "gpt-model",
          inputTokens: 100n,
          ...values,
        });

      const send = async (values: MessageInitShape<typeof UsageSchema>) => {
        const event = create(ThreadEventSchema, {
          threadId: target.threadId,
          turnId: target.turnId,
          eventId: Bun.randomUUIDv7(),
          journalSeq: ++seq,
          body: { case: "usageUpdated", value: { usage: sample(values) } },
        });

        await gw.runtime.runPromise(Ingest.use((store) => store.ingest(gw.workerId, "estimate-replay", [event])));

        return event;
      };

      gw.worker.emit(target.threadId, target.turnId, {
        case: "usageUpdated",
        value: {
          usage: sample({ estimatedCostUsd: 2, pricingVersion: "quote-v1" }),
        },
      });
      await eventually(
        () => gw.api.getUsageStats({ days: 1 }),
        (s) => s.totals?.estimatedCostUsd === 2,
      );
      expect((await gw.api.getUsageStats({ days: 1 })).totals).toMatchObject({
        reports: 1n,
        reportedCostUsd: 0,
        unknownCostReports: 1n,
        estimatedCostUsd: 2,
        unknownEstimatedCostReports: 0n,
        effectiveCostUsd: 2,
        effectiveEstimatedCostReports: 1n,
        effectiveReportedCostReports: 0n,
        unknownEffectiveCostReports: 0n,
      });
      // Reported zero replaces the estimate in effective cost, without erasing the independent quote.
      await send({ reportedCostUsd: 0 });
      expect((await gw.api.getUsageStats({ days: 1 })).totals).toMatchObject({
        estimatedCostUsd: 2,
        effectiveCostUsd: 0,
        effectiveReportedCostReports: 1n,
        effectiveEstimatedCostReports: 0n,
      });
      await send({ inputTokens: 200n, estimatedCostUsd: Number.NaN });
      expect((await gw.api.getUsageStats({ days: 1 })).totals).toMatchObject({
        inputTokens: 200n,
        estimatedCostUsd: 2,
        unknownEstimatedCostReports: 1n,
        unknownCostReports: 1n,
        effectiveCostUsd: 0,
        unknownEffectiveCostReports: 1n,
      });
      // Neither a smaller delayed price nor invalid infinity makes the grown counter complete.
      await send({ reportedCostUsd: 0, estimatedCostUsd: Number.POSITIVE_INFINITY });
      expect((await gw.api.getUsageStats({ days: 1 })).totals?.unknownEffectiveCostReports).toBe(1n);
      await send({ inputTokens: 200n, estimatedCostUsd: 5, pricingVersion: "quote-v1+v2" });
      const correction = await send({ inputTokens: 200n, reportedCostUsd: 3, requestedServiceTier: "fast" });
      const final = await gw.api.getUsageStats({ days: 1 });
      expect(final.totals).toMatchObject({
        inputTokens: 200n,
        reports: 1n,
        reportedCostUsd: 3,
        estimatedCostUsd: 5,
        effectiveCostUsd: 3,
        unknownCostReports: 0n,
        unknownEstimatedCostReports: 0n,
        unknownEffectiveCostReports: 0n,
        effectiveReportedCostReports: 1n,
        effectiveEstimatedCostReports: 0n,
      });
      expect(final.speeds.map((s) => s.key)).toEqual(["fast"]);

      const counters = await gw.runtime.runPromise(
        SqlClient.SqlClient.use(
          (sql) =>
            sql<{
              pricing_version: string;
            }>`SELECT pricing_version FROM usage_counters WHERE owner_user_id=${gw.userId}::uuid`,
        ),
      );

      expect(counters.map((c) => c.pricing_version)).toEqual(["quote-v1+v2"]);
      const empty = await gw.api.getUsageStats({ days: 1, requestedServiceTier: "" });
      expect(empty.totals?.reports).toBe(0n);
      expect(empty.totals?.estimatedCostUsd).toBe(0);

      const storage = {
        pg: gw.pg,
        secretsKey: gw.secretsKey,
        workerId: gw.workerId,
        workerCredential: gw.workerCredential,
      };

      await gw.close(true);
      gw = await startTestGateway({ storage });
      await gw.runtime.runPromise(Ingest.use((store) => store.ingest(gw.workerId, "estimate-replay", [correction])));
      expect((await gw.api.getUsageStats({ days: 1 })).totals).toEqual(final.totals);
    } finally {
      await gw.close();
    }
  }, 60_000);
});
