import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { JsonObject } from "@canopy/domain";
import { create } from "@bufbuild/protobuf";
import { bots, Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { BotModel, ModelReply } from "../../apps/gateway/src/bots/types.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

const reply = (text: string): ModelReply => ({ text, calls: [] });

describe.skipIf(!dockerAvailable)("bot event trigger sources: CI, schedules, usage limits and habits", () => {
  let gw: TestGateway;
  let core: GatewayCore;
  let clock: Date;
  let model: BotModel;
  let ids: string[] = [];
  let project: string;

  const query = <A extends object>(text: string, values: unknown[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SqlClient.SqlClient).unsafe<A>(text, values);
      }),
    );

  const read = (id: string) => core.bots.run((s) => s.conversation(gw.userId, id));

  const settled = async (id: string) => {
    await eventually(
      async () => {
        await core.bots.tick();

        return query("SELECT id FROM bot_turns WHERE bot_id = $1 AND status IN ('queued','running','waiting')", [id]);
      },
      (r) => r.length === 0,
      10_000,
    );

    return read(id);
  };

  /** The owner asks for a trigger; a card it needs is approved. Returns the trigger. */
  const trigger = async (title: string, event: string, filter: JsonObject) => {
    const bot = (
      await gw.api.createBot({
        clientRequestId: Bun.randomUUIDv7(),
        configuration: {
          name: `Sources ${Bun.randomUUIDv7()}`,
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "sources-test",
          model: "gpt-6.1-sol",
          approvalPolicy: "safe",
        },
      })
    ).bot!;

    ids.push(bot.id);
    model = async (i) =>
      i.messages.at(-1)?.role === "tool"
        ? reply("Done")
        : {
            text: "",
            calls: [
              { id: "c", name: "create_trigger", arguments: { title, instructions: "Report it", event, filter } },
            ],
          };

    await core.bots.send(
      create(bots.SendBotMessageRequestSchema, {
        botId: bot.id,
        text: "Watch it",
        clientRequestId: Bun.randomUUIDv7(),
      }),
    );

    const pending = await eventually(
      async () => {
        await core.bots.tick();

        return read(bot.id);
      },
      (s) => s.triggers.length > 0 || s.approvals.some((a) => a.status === "pending"),
    );

    const card = pending.approvals.find((a) => a.status === "pending");

    if (card) await gw.api.answerBotApproval({ approvalId: card.id, approve: true, answer: "" });
    const ready = await settled(bot.id);
    model = async () => reply("Internal: reported");

    return { botId: bot.id, trigger: ready.triggers[0]! };
  };

  /** Matches on one tick; the batch closes after its quiet window. */
  const runsAfterWindow = async (botId: string, triggerId: string) => {
    await settled(botId);
    clock = new Date(clock.getTime() + 301_000);
    await settled(botId);

    return query<{ input: string }>("SELECT input FROM bot_turns WHERE routine_id = $1 ORDER BY created_at", [
      triggerId,
    ]);
  };

  const thread = async () => {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO threads(id, root_thread_id, project_id, owner_user_id, kind, runtime, provider, status, title)
       VALUES($1::uuid, $1::uuid, $2::uuid, $3::uuid, 'main', 'gateway', 'anthropic', 'running', 'Ship it')`,
      [id, project, gw.userId],
    );

    return id;
  };

  beforeAll(async () => {
    gw = await startTestGateway();
    await gw.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "sources-test",
      label: "Sources test",
      create: true,
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture",
      allWorkers: true,
    });
    await eventually(
      () => gw.core.bots.run((s) => s.harnessModels(gw.userId, Provider.CODEX, "sources-test")),
      (models) => models.some((m) => m.id === "gpt-6.1-sol"),
    );

    // Only native profiles report usage; both harnesses use one id.
    for (const harness of [Provider.CODEX, Provider.CLAUDE])
      await gw.api.saveProviderInstance({
        harness,
        id: "usage-native",
        label: "Usage",
        create: true,
        kind: ProviderProfileKind.NATIVE,
        allWorkers: true,
      });
    project = (await gw.api.createProject({ name: "Sources project" })).project!.id;
  }, 30_000);
  beforeEach(() => {
    clock = new Date();
    ids = [];
    model = async () => reply("Nothing");
    core = new GatewayCore({
      runtime: gw.runtime,
      userId: gw.userId,
      instanceId: Bun.randomUUIDv7(),
      botClock: () => clock,
      botModel: (i) => model(i),
    });
  });
  afterEach(async () => {
    await core.bots.stop();

    for (const id of ids) await gw.api.deleteBot({ botId: id });
  });
  afterAll(async () => {
    await gw?.close();
  });

  test("a CI note of a watched pull request runs the trigger only when its conditions hold", async () => {
    const threadId = await thread();
    const pr = crypto.randomUUID();
    await query(
      `INSERT INTO github_pull_requests(id,owner_user_id,repository_id,repository_name,number,node_id,created_at)
       VALUES ($1::uuid,$2::uuid,'1','acme/app',7,'n',now())`,
      [pr, gw.userId],
    );

    const { botId, trigger: t } = await trigger("CI failures", "pr.checks", {
      scope: { repository: ["acme/app"] },
      where: { event: { eq: "complete" }, failed_count: { gte: 1 } },
    });

    const watch = crypto.randomUUID();
    await query(
      `INSERT INTO pr_check_watches(id, owner_user_id, thread_id, pull_request_id, call_id, notify_on, hops, expires_at, head_sha)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$1::uuid,ARRAY['complete'],1,now()+interval '1 hour','abc')`,
      [watch, gw.userId, threadId, pr],
    );

    const note = (failed: number) =>
      query(
        `INSERT INTO pr_check_notes(id, watch_id, thread_id, body, wake, hops) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::jsonb,false,1)`,
        [
          crypto.randomUUID(),
          watch,
          threadId,
          JSON.stringify({
            watch_id: watch,
            pull_request_id: pr,
            repository: "acme/app",
            number: 7,
            event: "complete",
            reason: "",
            counts: { total: 2, passed: 2 - failed, failed, skipped: 0, pending: 0 },
          }),
        ],
      );

    await note(0);
    expect(await runsAfterWindow(botId, t.id)).toHaveLength(0);
    await note(2);
    const [run] = await runsAfterWindow(botId, t.id);
    expect(run!.input).toContain("pr.checks");
    expect(run!.input).toContain("failed_count=2");
    expect(run!.input).toContain('pull_request "acme/app #7"');
  });

  test("a skipped schedule occurrence runs a trigger scoped to that schedule", async () => {
    const threadId = await thread();
    const schedule = crypto.randomUUID();
    await query(
      `INSERT INTO schedules(id,thread_id,project_id,kind,prompt,run_at,next_run_at,created_by_user_id)
       VALUES ($1::uuid,$2::uuid,$3::uuid,'once','Nightly',now()+interval '1 hour',now()+interval '1 hour',$4::uuid)`,
      [schedule, threadId, project, gw.userId],
    );

    const { botId, trigger: t } = await trigger("Skipped runs", "schedule.run", {
      scope: { schedule: [schedule] },
      where: { phase: { in: ["skipped", "expired"] } },
    });

    await query("INSERT INTO schedule_runs(schedule_id, scheduled_for, outcome) VALUES ($1::uuid, now(), 'running')", [
      schedule,
    ]);
    const [run] = await runsAfterWindow(botId, t.id);
    expect(run!.input).toContain("phase=skipped");

    // The occurrence that ends a schedule still reports after the schedule is marked completed.
    await query(
      `WITH r AS (INSERT INTO schedule_runs(schedule_id, scheduled_for, outcome) VALUES ($1::uuid, now() + interval '2 minutes', 'expired'))
       UPDATE schedules SET status = 'completed', next_run_at = NULL WHERE id = $1::uuid`,
      [schedule],
    );
    expect(await runsAfterWindow(botId, t.id)).toHaveLength(2);

    // A schedule working for an external conversation never reports to the owner's triggers.
    await query("UPDATE threads SET memory_audience = $2 WHERE id = $1::uuid", [threadId, `conversation:${botId}:x`]);
    await query(
      "INSERT INTO schedule_runs(schedule_id, scheduled_for, outcome) VALUES ($1::uuid, now() + interval '1 minute', 'missed')",
      [schedule],
    );
    expect(await runsAfterWindow(botId, t.id)).toHaveLength(2);
  });

  /** Usage of a native profile on a worker: the first row sets the baseline, later ones rise. */
  const usage = (worker: string, provider: number, profile: string) => {
    const snapshot = (percent: number) =>
      JSON.stringify({ windows: [{ key: "five_hour", usedPercent: percent, resetsAt: "2031-01-01T00:00:00Z" }] });

    return {
      start: (percent: number) =>
        query(
          `INSERT INTO provider_usage(worker_id, provider, profile_id, account_key, config_version, snapshot, observed_at)
           VALUES ($1::uuid, $2, $3, $4, coalesce((SELECT version FROM worker_configs WHERE worker_id = $1::uuid), 1),
             $5::jsonb, now())`,
          [worker, provider, profile, "a".repeat(64), snapshot(percent)],
        ),
      observe: (percent: number) =>
        query(
          `UPDATE provider_usage SET snapshot = $4::jsonb, observed_at = now()
           WHERE worker_id = $1::uuid AND provider = $2 AND profile_id = $3`,
          [worker, provider, profile, snapshot(percent)],
        ),
    };
  };

  const limitFilter = (worker: string) => ({
    scope: { worker: [worker], profile: ["codex/usage-native"] },
    where: { window: { eq: "five_hour" }, used_percent: { gte: 80 } },
  });

  test("a usage window rising past the threshold runs once per window and reset, for that exact profile", async () => {
    const codex = usage(gw.workerId, 2, "usage-native");
    // Observed before the trigger existed: a later rise cannot use it as the baseline.
    await codex.start(70);
    const { botId, trigger: t } = await trigger("Usage", "provider.limit", limitFilter(gw.workerId));
    await codex.observe(85);
    expect(await runsAfterWindow(botId, t.id)).toHaveLength(0);

    await codex.observe(70);
    await codex.observe(85);
    expect(await runsAfterWindow(botId, t.id)).toHaveLength(1);
    await codex.observe(90);
    // The same window and reset again, after a dip: already reported.
    await codex.observe(60);
    await codex.observe(95);
    expect(await runsAfterWindow(botId, t.id)).toHaveLength(1);

    // A Claude profile with the same id is another profile.
    const claude = usage(gw.workerId, 1, "usage-native");
    await claude.start(10);
    await claude.observe(99);
    expect(await runsAfterWindow(botId, t.id)).toHaveLength(1);
  });

  test("two windows of one report cross on their own; a window that already reset reports nothing", async () => {
    await query(
      "DELETE FROM provider_usage WHERE worker_id = $1::uuid AND provider = 2 AND profile_id = 'usage-native'",
      [gw.workerId],
    );

    const report = (short: number, long: number, resetsAt = "2031-01-01T00:00:00Z") =>
      JSON.stringify({
        windows: [
          { key: "five_hour", windowMinutes: 60, usedPercent: short, resetsAt },
          { key: "five_hour", windowMinutes: 120, usedPercent: long, resetsAt },
        ],
      });

    const { botId, trigger: t } = await trigger("Usage", "provider.limit", limitFilter(gw.workerId));
    await query(
      `INSERT INTO provider_usage(worker_id, provider, profile_id, account_key, config_version, snapshot, observed_at)
       VALUES ($1::uuid, 2, 'usage-native', $2, coalesce((SELECT version FROM worker_configs WHERE worker_id = $1::uuid), 1),
         $3::jsonb, now())`,
      [gw.workerId, "a".repeat(64), report(10, 70)],
    );

    const observe = (snapshot: string) =>
      query(
        `UPDATE provider_usage SET snapshot = $2::jsonb, observed_at = now()
         WHERE worker_id = $1::uuid AND provider = 2 AND profile_id = 'usage-native'`,
        [gw.workerId, snapshot],
      );

    // Both windows rise in one report; only the longer one crosses 80%.
    await observe(report(20, 85));
    expect(await runsAfterWindow(botId, t.id)).toHaveLength(1);

    // A window whose reset has passed says nothing about the limit any more.
    await observe(report(10, 10, "2020-01-01T00:00:00Z"));
    await observe(report(10, 95, "2020-01-01T00:00:00Z"));
    expect(await runsAfterWindow(botId, t.id)).toHaveLength(1);

    // Matched a minute before its reset, delivered after it (bot clock): nothing left to report.
    const soon = new Date(clock.getTime() + 60_000).toISOString();
    await observe(report(10, 10, soon));
    await observe(report(10, 95, soon));
    expect(await runsAfterWindow(botId, t.id)).toHaveLength(1);
  });

  test("a rise on a shared worker is an event of every owner subscribed to it", async () => {
    const shared = crypto.randomUUID();
    const other = crypto.randomUUID();
    await query(
      `WITH u AS (INSERT INTO users(id, email, display_name, role) VALUES ($2::uuid, $3, 'Other', 'user'))
       INSERT INTO workers SELECT (jsonb_populate_record(NULL::workers, to_jsonb(w) || jsonb_build_object('id', $1::uuid,
         'owner_user_id', NULL, 'name', 'Shared worker', 'credential_hash', md5($1::text)))).* FROM workers w WHERE w.id = $4::uuid`,
      [shared, other, `other-${other}@example.test`, gw.workerId],
    );
    const { botId, trigger: t } = await trigger("Usage", "provider.limit", limitFilter(shared));
    const copy = crypto.randomUUID();
    const copyTrigger = crypto.randomUUID();
    await query(
      `WITH b AS (INSERT INTO bots SELECT (jsonb_populate_record(NULL::bots, to_jsonb(x) || jsonb_build_object('id', $3::uuid,
          'owner_user_id', $2::uuid, 'client_request_id', $3::text))).* FROM bots x WHERE x.id = $1::uuid),
       r AS (INSERT INTO bot_routines SELECT (jsonb_populate_record(NULL::bot_routines, to_jsonb(y)
          || jsonb_build_object('id', $5::uuid, 'bot_id', $3::uuid))).* FROM bot_routines y WHERE y.id = $4::uuid)
       INSERT INTO bot_trigger_scopes(trigger_id, owner_user_id, event, kind, ref_id)
         SELECT $5::uuid, $2::uuid, event, kind, ref_id FROM bot_trigger_scopes WHERE trigger_id = $4::uuid`,
      [botId, other, copy, t.id, copyTrigger],
    );

    // A profile without a creator is everyone's, as a built-in one.
    await query("UPDATE provider_instances SET created_by = NULL WHERE harness = 'codex' AND id = 'usage-native'");
    const codex = usage(shared, 2, "usage-native");
    await codex.start(70);
    await codex.observe(85);

    const owners = await query<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM bot_trigger_events WHERE event = 'provider.limit' ORDER BY owner_user_id",
    );

    expect(owners.map((o) => o.owner_user_id).sort()).toEqual([gw.userId, other].sort());
    await query("DELETE FROM bot_trigger_events WHERE owner_user_id = $1::uuid", [other]);
  });

  test("a habit suggestion ready for review runs a trigger scoped to its project", async () => {
    const { botId, trigger: t } = await trigger("Habits", "habit.suggested", { scope: { project: [project] } });

    await query(
      `INSERT INTO memory_habits(id, owner_user_id, project_id, habit_key, rule, state) VALUES ($1::uuid,$2::uuid,$3::uuid,'k','Rule','pending')`,
      [crypto.randomUUID(), gw.userId, project],
    );
    const [run] = await runsAfterWindow(botId, t.id);
    expect(run!.input).toContain("habit.suggested");
    expect(run!.input).toContain('project "Sources project"');
  });
});
