import { describe, expect, test } from "bun:test";
import { create, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
  Provider,
  CommandSchema,
  ThreadEventSchema,
  TurnOutcome,
  UsageSchema,
  UsageScope,
  ui,
  type ThreadEvent,
} from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Ingest } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import { ingestThread } from "../../apps/gateway/src/store/ingest.ts";
import { accountGeneration } from "../../apps/gateway/src/usage/generation.ts";
import { getUsageStats } from "../../apps/gateway/src/usage/query.ts";
import { CommandResultSchema } from "@canopy/contracts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const query = <A extends object>(gw: TestGateway, text: string, params: string[] = []) =>
  gw.runtime.runPromise(SqlClient.SqlClient.use((sql) => sql.unsafe<A>(text, params)));

async function running(gw: TestGateway, { worker, workerId }: Pick<TestGateway, "worker" | "workerId"> = gw) {
  worker.holdTurns = true;
  const project = (await gw.api.createProject({ name: `Usage ${workerId}` })).project!;

  const workspace = (await gw.api.createWorkspace({ projectId: project.id, workerId, rootPath: "/repo" })).workspace!;

  const thread = (
    await gw.api.createThread({
      projectId: project.id,
      workspaceId: workspace.id,
      provider: Provider.CODEX,
      title: "Usage",
      initialMessage: "Wait",
      clientRequestId: Bun.randomUUIDv7(),
    })
  ).thread!;

  const turns = await eventually(
    () =>
      query<{ id: string; status: string }>(gw, "SELECT id,status FROM turns WHERE thread_id=$1::uuid", [thread.id]),
    (rows) => rows[0]?.status === "running",
  );

  return { threadId: thread.id, turnId: turns[0]!.id };
}

const usage = (inputTokens: bigint, reportedCostUsd?: number) =>
  create(UsageSchema, {
    scope: UsageScope.TURN,
    model: "actual-model",
    inputTokens,
    outputTokens: 10n,
    cachedInputTokens: 20n,
    cacheWriteInputTokens: 5n,
    reasoningOutputTokens: 3n,
    ...(reportedCostUsd !== undefined && { reportedCostUsd }),
  });

async function speedFixture(gw: TestGateway) {
  const target = await running(gw);
  await query(
    gw,
    "UPDATE threads SET settings=jsonb_set(settings,'{serviceTier}','\"fast\"'::jsonb) WHERE id=$1::uuid",
    [target.threadId],
  );
  await query(gw, "UPDATE turns SET service_tier='' WHERE id=$1::uuid", [target.turnId]);
  const turns = [target.turnId];

  for (const tier of ["default", "fast", "ultrafast", "priority"]) {
    const turn = Bun.randomUUIDv7();
    await gw.runtime.runPromise(
      SqlClient.SqlClient.use(
        (sql) => sql`INSERT INTO turns
      (id,thread_id,ordinal,status,trigger,input,first_seq,last_seq,service_tier)
      SELECT ${turn}::uuid,${target.threadId}::uuid,coalesce(max(ordinal),0)+1,'completed','provider','{}'::jsonb,1,1,${tier}
      FROM turns WHERE thread_id=${target.threadId}::uuid`,
      ),
    );
    turns.push(turn);
  }

  let seq = 0n;

  const event = (turn: string, values: MessageInitShape<typeof UsageSchema>) =>
    create(ThreadEventSchema, {
      threadId: target.threadId,
      turnId: turn,
      eventId: Bun.randomUUIDv7(),
      journalSeq: ++seq,
      body: { case: "usageUpdated", value: { usage: { ...values, scope: UsageScope.TURN } } },
    });

  const samples = turns.map((turn, index) => event(turn, usage(BigInt(index + 1) * 100n, index + 1)));
  samples.push(event(target.turnId, { model: "helper-model", inputTokens: 5n, reportedCostUsd: 0.1 }));

  const ingest = (events: ThreadEvent[]) =>
    gw.runtime.runPromise(Ingest.use((store) => store.ingest(gw.workerId, "requested-speed", events)));

  await ingest(samples);

  return { target, event, ingest, samples };
}

describe.skipIf(!dockerAvailable)("durable usage accounting", () => {
  test("one gateway reports threads on two workers separately for the same model and activity", async () => {
    const gw = await startTestGateway();

    try {
      const { workerId, credential } = await gw.addWorker("Studio");
      const studio = await gw.connect(workerId, credential, "darwin");
      await eventually(
        () => gw.api.listModels({}),
        (catalog) => catalog.workers.some((row) => row.workerId === workerId && row.configVersion > 0n),
      );
      const first = await running(gw);
      const second = await running(gw, { workerId, worker: studio });
      gw.worker.emit(first.threadId, first.turnId, { case: "usageUpdated", value: { usage: usage(100n, 1) } });
      studio.emit(second.threadId, second.turnId, { case: "usageUpdated", value: { usage: usage(300n, 3) } });

      const report = await eventually(
        () => gw.api.getUsageStats({ days: 7, provider: "codex", activityKind: "thread" }),
        (stats) => stats.totals?.reports === 2n,
      );

      expect(report.sources).toHaveLength(1);
      expect(report.supportsWorkerBreakdown).toBe(true);
      expect(report.totals).toMatchObject({ inputTokens: 400n, effectiveCostUsd: 4 });
      expect(report.workers.toSorted((a, b) => a.name.localeCompare(b.name))).toMatchObject([
        { workerId: gw.workerId, name: "laptop", totals: { inputTokens: 100n, effectiveCostUsd: 1 } },
        { workerId, name: "Studio", totals: { inputTokens: 300n, effectiveCostUsd: 3 } },
      ]);
      expect((await gw.api.getUsageStats({ days: 7, activityKind: "bot" })).workers).toEqual([]);
    } finally {
      await gw.close();
    }
  }, 60_000);

  test("gRPC observations survive restart, replay, late turns, deletion and owner isolation", async () => {
    let gw = await startTestGateway();

    try {
      const target = await running(gw);
      gw.worker.emit(target.threadId, target.turnId, { case: "usageUpdated", value: { usage: usage(100n, 1) } });

      const initial = await eventually(
        () => gw.api.getUsageStats({ days: 7 }),
        (s) => s.totals?.inputTokens === 100n,
      );

      expect(initial.totals).toMatchObject({ reports: 1n, unknownCostReports: 0n, reportedCostUsd: 1 });
      expect(initial.activities).toMatchObject([{ key: "thread", totals: { inputTokens: 100n } }]);
      let seq = 0n;

      const event = (turnId: string, body: NonNullable<MessageInitShape<typeof ThreadEventSchema>["body"]>) =>
        create(ThreadEventSchema, {
          eventId: Bun.randomUUIDv7(),
          threadId: target.threadId,
          turnId,
          journalSeq: ++seq,
          body,
        });

      const nextTurn = Bun.randomUUIDv7();

      const started = event(nextTurn, {
        case: "turnStarted",
        value: { providerTurnRef: "new", origin: 0 },
      });

      const current = event(nextTurn, {
        case: "usageUpdated",
        value: { usage: usage(30n) },
      });

      const ingest = (events: ThreadEvent[]) =>
        gw.runtime.runPromise(Ingest.use((s) => s.ingest(gw.workerId, "usage-test", events)));

      // The autonomous turn and all of its consumption arrive in one durable journal batch.
      await ingest([started, current]);
      expect((await gw.api.getUsageStats({ days: 7 })).totals?.inputTokens).toBe(130n);

      // An earlier priced snapshot does not cover additional unpriced work of that older turn.
      const growing = event(target.turnId, {
        case: "usageUpdated",
        value: { usage: usage(200n) },
      });

      await ingest([growing]);
      expect((await gw.api.getUsageStats({ days: 7 })).totals).toMatchObject({
        inputTokens: 230n,
        reports: 2n,
        unknownCostReports: 2n,
        reportedCostUsd: 1,
      });
      await ingest([
        event(target.turnId, {
          case: "usageUpdated",
          value: { usage: usage(100n, 1) },
        }),
      ]);
      expect((await gw.api.getUsageStats({ days: 7 })).totals?.unknownCostReports).toBe(2n);

      // Finish repeats cumulative totals; the late correction belongs to the earlier turn/model.
      const finished = event(target.turnId, {
        case: "turnFinished",
        value: {
          outcome: TurnOutcome.INTERRUPTED,
          reason: "",
          source: 0,
          providerTurnRef: "old",
          errorCode: "",
          errorClass: "",
          usage: usage(200n, 3),
        },
      });

      await ingest([finished]);
      await ingest([finished, current]);
      const totals = (await gw.api.getUsageStats({ days: 7 })).totals!;
      expect(totals).toMatchObject({
        inputTokens: 230n,
        outputTokens: 20n,
        cachedInputTokens: 40n,
        cacheWriteInputTokens: 10n,
        reasoningOutputTokens: 6n,
        reports: 2n,
        unknownCostReports: 1n,
        reportedCostUsd: 3,
      });

      // A failing transaction cannot publish either consumption or the corresponding journal ACK.
      const rollback = event(nextTurn, {
        case: "usageUpdated",
        value: { usage: usage(500n, 9) },
      });

      await expect(
        gw.runtime.runPromise(
          SqlClient.SqlClient.use((sql) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* ingestThread(sql, gw.workerId, "usage-test", target.threadId, [rollback]);

                return yield* Effect.fail(new Error("rollback accounting"));
              }),
            ),
          ),
        ),
      ).rejects.toThrow("rollback accounting");
      expect((await gw.api.getUsageStats({ days: 7 })).totals).toEqual(totals);
      const other = Bun.randomUUIDv7();
      await query(gw, "INSERT INTO users(id,email,display_name,role) VALUES($1,$2,'Other','user')", [
        other,
        `${other}@test.invalid`,
      ]);

      const scoped = await gw.runtime.runPromise(
        SqlClient.SqlClient.use((sql) => getUsageStats(sql, other, create(ui.GetUsageStatsRequestSchema, { days: 7 }))),
      );

      expect(scoped.totals?.inputTokens).toBe(0n);
      expect(scoped.workers).toEqual([]);

      // A process restart restores the same independent aggregates and counter watermarks.
      const storage = {
        pg: gw.pg,
        secretsKey: gw.secretsKey,
        workerId: gw.workerId,
        workerCredential: gw.workerCredential,
      };

      await gw.close(true);
      gw = await startTestGateway({ storage });
      await gw.runtime.runPromise(Ingest.use((s) => s.ingest(gw.workerId, "usage-test", [finished, current])));
      expect((await gw.api.getUsageStats({ days: 7 })).totals).toEqual(totals);
      await gw.api.setThreadArchived({ threadId: target.threadId, archived: true });
      await gw.api.deleteThread({ threadId: target.threadId });
      expect((await gw.api.getUsageStats({ days: 7 })).totals).toEqual(totals);
      // Purging transcript rows does not affect the accounting tables.
      await query(gw, "DELETE FROM thread_events WHERE thread_id=$1::uuid", [target.threadId]);
      expect((await gw.api.getUsageStats({ days: 7 })).totals).toEqual(totals);
    } finally {
      await gw.close();
    }
  }, 60_000);

  test("context snapshots are excluded and GenerateText keeps per-model zero/unknown costs with command dedup", async () => {
    const gw = await startTestGateway();

    try {
      const target = await running(gw);
      gw.worker.emit(target.threadId, target.turnId, {
        case: "usageUpdated",
        value: {
          usage: { inputTokens: 999n, costUsd: 10 },
          contextUsage: { usedTokens: 999n, limitTokens: 10_000n },
        },
      });

      const result = create(CommandResultSchema, {
        commandId: Bun.randomUUIDv7(),
        ok: false,
        consumedUsages: [
          {
            scope: UsageScope.TURN,
            model: "small",
            inputTokens: 7n,
            reportedCostUsd: 0,
            requestedServiceTier: "default",
          },
          { scope: UsageScope.TURN, model: "large", inputTokens: 13n },
        ],
      });

      const worker = { id: gw.workerId, name: "laptop" };
      await accountGeneration(gw.runtime, gw.userId, Provider.CLAUDE, "fallback", result, worker);
      await accountGeneration(gw.runtime, gw.userId, Provider.CLAUDE, "fallback", result, worker);
      await accountGeneration(
        gw.runtime,
        gw.userId,
        Provider.CODEX,
        "small",
        create(CommandResultSchema, {
          commandId: Bun.randomUUIDv7(),
          ok: true,
          consumedUsages: [{ scope: UsageScope.TURN, model: "small", inputTokens: 5n, reportedCostUsd: 0.2 }],
        }),
        worker,
      );
      const stats = await gw.api.getUsageStats({ days: 1 });
      expect(stats.totals).toMatchObject({
        inputTokens: 25n,
        reports: 3n,
        unknownCostReports: 1n,
        reportedCostUsd: 0.2,
      });
      expect(stats.days[0]?.providers.map((provider) => provider.key)).toEqual(["claude", "codex"]);
      expect(stats.days[0]?.providers.map((provider) => provider.totals?.inputTokens)).toEqual([20n, 5n]);
      expect(stats.days[0]?.providers.map((provider) => provider.totals?.unknownCostReports)).toEqual([1n, 0n]);
      const dailyProviders = stats.days.flatMap((day) => day.providers);
      expect(stats.totals).toMatchObject({
        inputTokens: dailyProviders.reduce((sum, provider) => sum + (provider.totals?.inputTokens ?? 0n), 0n),
        reportedCostUsd: dailyProviders.reduce((sum, provider) => sum + (provider.totals?.reportedCostUsd ?? 0), 0),
      });
      expect(stats.models.map((m) => m.key)).toEqual(["large", "small"]);
      expect(stats.activities).toMatchObject([{ key: "generation", totals: { inputTokens: 25n } }]);
      expect(stats.workers).toMatchObject([{ workerId: gw.workerId, totals: { reports: 3n, inputTokens: 25n } }]);
      expect((await gw.api.getUsageStats({ days: 1, activityKind: "thread" })).totals?.reports).toBe(0n);
      expect(stats.speeds.map((speed) => [speed.key, speed.totals?.inputTokens])).toEqual([
        ["", 5n],
        ["default", 20n],
      ]);
      const filtered = await gw.api.getUsageStats({ days: 1, provider: "codex" });
      expect(filtered.totals?.inputTokens).toBe(5n);
      expect(filtered.days[0]?.providers.map((provider) => provider.key)).toEqual(["codex"]);
    } finally {
      await gw.close();
    }
  }, 60_000);
  test("bot harness usage is owner/worker scoped and survives failed terminal replay", async () => {
    const gw = await startTestGateway();

    try {
      await gw.core.bots.stop();
      const bot = Bun.randomUUIDv7();
      const turn = Bun.randomUUIDv7();
      const commandId = Bun.randomUUIDv7();

      const command = create(CommandSchema, {
        commandId,
        kind: {
          case: "runBotTurn",
          value: {
            botId: bot,
            turnId: turn,
            provider: Provider.CLAUDE,
            model: "selected-at-start",
            serviceTier: "fast",
          },
        },
      });

      await gw.runtime.runPromise(
        SqlClient.SqlClient.use((sql) =>
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
          VALUES(${bot}::uuid,${gw.userId}::uuid,${bot},'{"name":"Release bot","serviceTier":"ultrafast"}'::jsonb,'codex','native')`;
              yield* sql`INSERT INTO bot_turns(id,bot_id,client_request_id,input,status)
          VALUES(${turn}::uuid,${bot}::uuid,${turn},'Wait','running')`;
              yield* sql`INSERT INTO worker_commands(id,worker_id,kind,payload,status,expires_at)
          VALUES(${commandId}::uuid,${gw.workerId}::uuid,'runBotTurn',${toBinary(CommandSchema, command)},'completed',now())`;
              yield* sql`INSERT INTO bot_harness_turns(turn_id,bot_id,worker_id,command_id)
          VALUES(${turn}::uuid,${bot}::uuid,${gw.workerId}::uuid,${commandId}::uuid)`;
            }),
          ),
        ),
      );
      gw.worker.emit(bot, turn, { case: "usageUpdated", value: { usage: usage(100n, 2) } });
      await eventually(
        () => gw.api.getUsageStats({ days: 7 }),
        (stats) => stats.totals?.inputTokens === 100n,
      );
      gw.worker.emit(bot, turn, {
        case: "turnFinished",
        value: { outcome: TurnOutcome.FAILED, usage: usage(100n, 2) },
      });
      await eventually(
        () =>
          query<{ outcome: number | null }>(gw, "SELECT outcome FROM bot_harness_turns WHERE turn_id=$1::uuid", [turn]),
        (rows) => rows[0]?.outcome === TurnOutcome.FAILED,
      );
      // Terminal watermarks still admit a late larger observation without reconstructing raw events.
      gw.worker.emit(bot, turn, { case: "usageUpdated", value: { usage: usage(150n, 3) } });

      const stats = await eventually(
        () => gw.api.getUsageStats({ days: 7 }),
        (value) => value.totals?.inputTokens === 150n,
      );

      expect(stats.totals).toMatchObject({ reports: 1n, unknownCostReports: 0n, reportedCostUsd: 3 });
      expect(stats.providers[0]?.key).toBe("claude");
      expect(stats.speeds.map((speed) => speed.key)).toEqual(["fast"]);
      expect(stats.activities).toMatchObject([{ key: "bot", totals: { inputTokens: 150n, reportedCostUsd: 3 } }]);
      expect(stats.bots).toMatchObject([{ botId: bot, name: "Release bot", totals: { inputTokens: 150n } }]);
      expect(stats.workers).toMatchObject([{ workerId: gw.workerId, totals: { inputTokens: 150n } }]);

      const filtered = await gw.api.getUsageStats({
        days: 7,
        botId: bot,
        provider: "claude",
        requestedServiceTier: "fast",
      });

      expect(filtered.totals).toEqual(stats.totals);
      expect(filtered.workers).toEqual(stats.workers);
      expect(filtered.days.flatMap((day) => day.providers)).toMatchObject([
        { key: "claude", totals: { inputTokens: 150n, effectiveCostUsd: 3 } },
      ]);
      expect((await gw.api.getUsageStats({ days: 7, botId: Bun.randomUUIDv7() })).totals?.reports).toBe(0n);
      const wrongWorker = await gw.addWorker("Unrelated worker");

      const denied = await gw.runtime.runPromise(
        BotStore.use((store) =>
          store.harnessEvent(
            wrongWorker.workerId,
            "untrusted",
            create(ThreadEventSchema, {
              threadId: bot,
              turnId: turn,
              eventId: Bun.randomUUIDv7(),
              journalSeq: 1n,
              body: { case: "usageUpdated", value: { usage: usage(999n, 99) } },
            }),
          ),
        ),
      );

      expect(denied).toBe(false);
      expect((await gw.api.getUsageStats({ days: 7 })).totals).toEqual(stats.totals);
    } finally {
      await gw.close();
    }
  }, 60_000);
  test("requested speeds freeze per turn and corrected unknown partitions survive replay and deletion", async () => {
    let gw = await startTestGateway();

    try {
      const fixture = await speedFixture(gw);
      const before = await gw.api.getUsageStats({ days: 7 });
      expect(before.totals?.inputTokens).toBe(1505n);
      expect(before.speeds.map((speed) => [speed.key, speed.totals?.inputTokens])).toEqual([
        ["", 105n],
        ["default", 200n],
        ["fast", 300n],
        ["priority", 500n],
        ["ultrafast", 400n],
      ]);
      expect((await gw.api.getUsageStats({ days: 7, requestedServiceTier: "" })).totals?.inputTokens).toBe(105n);
      const correction = fixture.event(fixture.target.turnId, { ...usage(100n, 1), requestedServiceTier: "fast" });
      // Relocation and its journal ACK roll back together if ingestion does not commit.
      await expect(
        gw.runtime.runPromise(
          SqlClient.SqlClient.use((sql) =>
            sql.withTransaction(
              Effect.gen(function* () {
                yield* ingestThread(sql, gw.workerId, "requested-speed", fixture.target.threadId, [correction]);

                return yield* Effect.fail(new Error("rollback requested tier"));
              }),
            ),
          ),
        ),
      ).rejects.toThrow("rollback requested tier");
      expect((await gw.api.getUsageStats({ days: 7 })).speeds).toEqual(before.speeds);
      await fixture.ingest([correction]);
      const corrected = await gw.api.getUsageStats({ days: 7 });
      expect(corrected.totals?.inputTokens).toBe(before.totals?.inputTokens);
      expect(corrected.totals?.reportedCostUsd).toBeCloseTo(before.totals?.reportedCostUsd ?? 0);
      expect(corrected.totals?.reports).toBe(6n);
      expect(corrected.days).toEqual(before.days);
      expect(corrected.speeds.map((speed) => [speed.key, speed.totals?.inputTokens])).toEqual([
        ["default", 200n],
        ["fast", 405n],
        ["priority", 500n],
        ["ultrafast", 400n],
      ]);
      expect((await gw.api.getUsageStats({ days: 7, requestedServiceTier: "" })).totals?.inputTokens).toBe(0n);
      expect((await gw.api.getUsageStats({ days: 7, requestedServiceTier: "priority" })).totals?.inputTokens).toBe(
        500n,
      );
      expect((await gw.api.getUsageStats({ days: 7, requestedServiceTier: "fast" })).totals?.inputTokens).toBe(405n);

      const tombstones = await query<{ reports: bigint; input_tokens: bigint }>(
        gw,
        "SELECT reports,input_tokens FROM usage_buckets WHERE owner_user_id=$1::uuid AND requested_service_tier=''",
        [gw.userId],
      );

      expect(tombstones).toEqual([
        { reports: 0n, input_tokens: 0n },
        { reports: 0n, input_tokens: 0n },
      ]);
      await query(
        gw,
        "UPDATE threads SET settings=jsonb_set(settings,'{serviceTier}','\"ultrafast\"'::jsonb) WHERE id=$1::uuid",
        [fixture.target.threadId],
      );
      const conflicting = fixture.event(fixture.target.turnId, { ...usage(100n, 1), requestedServiceTier: "priority" });
      await fixture.ingest([...fixture.samples, correction, conflicting]);
      expect((await gw.api.getUsageStats({ days: 7 })).speeds).toEqual(corrected.speeds);

      const storage = {
        pg: gw.pg,
        secretsKey: gw.secretsKey,
        workerId: gw.workerId,
        workerCredential: gw.workerCredential,
      };

      await gw.close(true);
      gw = await startTestGateway({ storage });
      await gw.runtime.runPromise(
        Ingest.use((store) => store.ingest(gw.workerId, "requested-speed", [correction, conflicting])),
      );
      expect((await gw.api.getUsageStats({ days: 7 })).speeds).toEqual(corrected.speeds);
      await gw.api.setThreadArchived({ threadId: fixture.target.threadId, archived: true });
      await gw.api.deleteThread({ threadId: fixture.target.threadId });
      expect((await gw.api.getUsageStats({ days: 7 })).speeds).toEqual(corrected.speeds);
    } finally {
      await gw.close();
    }
  }, 60_000);
});
