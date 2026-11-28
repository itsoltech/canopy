import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { JsonObject } from "@canopy/domain";
import { create } from "@bufbuild/protobuf";
import { bots, CommandSchema, Provider, ProviderProfileKind } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { BotModel, BotTurn, ModelInput, ModelReply } from "../../apps/gateway/src/bots/types.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const reply = (text: string): ModelReply => ({ text, calls: [] });

const tool = (name: string, args: JsonObject): ModelReply => ({
  text: "",
  calls: [{ id: "requested", name, arguments: args }],
});

const lastTool = (i: ModelInput) => (i.messages.at(-1)?.role === "tool" ? i.messages.at(-1)!.text : undefined);

describe.skipIf(!dockerAvailable)("bot event triggers: scoped thread events become coalesced background runs", () => {
  let gw: TestGateway;
  let core: GatewayCore;
  let clock: Date;
  let model: BotModel;
  let ids: string[] = [];
  let project: string;
  let other: string;

  const query = <A extends object>(text: string, values: unknown[] = []) =>
    gw.runtime.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SqlClient.SqlClient).unsafe<A>(text, values);
      }),
    );

  const read = (id: string) => core.bots.run((s) => s.conversation(gw.userId, id));

  const idle = async (id: string) => {
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

  const add = async (approvalPolicy = "safe") => {
    const bot = (
      await gw.api.createBot({
        clientRequestId: Bun.randomUUIDv7(),
        configuration: {
          name: `Trigger ${Bun.randomUUIDv7()}`,
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "trigger-test",
          model: "gpt-6.1-sol",
          approvalPolicy,
        },
      })
    ).bot!;

    ids.push(bot.id);

    return bot.id;
  };

  const send = async (id: string, text: string) => {
    await core.bots.send(
      create(bots.SendBotMessageRequestSchema, { botId: id, text, clientRequestId: Bun.randomUUIDv7() }),
    );

    return idle(id);
  };

  /** The owner asks; the model calls one tool and reports its result. */
  const ask = async (id: string, name: string, args: JsonObject) => {
    let result = "";
    model = async (i) => {
      const done = lastTool(i);

      if (done === undefined) return tool(name, args);
      result = done;

      return reply("Done");
    };

    await core.bots.send(
      create(bots.SendBotMessageRequestSchema, {
        botId: id,
        text: `Please ${name}`,
        clientRequestId: Bun.randomUUIDv7(),
      }),
    );

    // A trigger whose frequency cannot be estimated (a new installation has no week of history) asks first.
    const pending = await eventually(
      async () => {
        await core.bots.tick();

        return read(id);
      },
      (x) => !x.working || x.approvals.some((a) => a.status === "pending"),
    );

    const card = pending.approvals.find((a) => a.status === "pending");

    if (card) await gw.api.answerBotApproval({ approvalId: card.id, approve: true, answer: "" });

    return { snapshot: await idle(id), result };
  };

  const watchFailures = async (id: string, filter: JsonObject = {}) => {
    const { snapshot, result } = await ask(id, "create_trigger", {
      title: "Failed turns",
      instructions: "Explain each failure and message me.",
      event: "thread.turn_finished",
      filter: { scope: { project: [project] }, where: { status: { in: ["failed"] } }, ...filter },
    });

    expect(result).not.toContain("error");

    return snapshot.triggers[0]!;
  };

  const thread = async (projectId: string, title = "Release build") => {
    const id = crypto.randomUUID();
    await query(
      `INSERT INTO threads(id, root_thread_id, project_id, owner_user_id, kind, runtime, provider, status, title)
       VALUES($1::uuid, $1::uuid, $2::uuid, $3::uuid, 'main', 'gateway', 'anthropic', 'running', $4)`,
      [id, projectId, gw.userId, title],
    );

    return id;
  };

  /** A turn that runs and then ends with `status`: the source fact of thread.turn_finished. */
  const finish = async (threadId: string, status: "completed" | "failed", ordinal = 1) => {
    const turn = crypto.randomUUID();
    await query(
      `INSERT INTO turns(id, thread_id, ordinal, trigger, author_user_id, input, status)
       VALUES($1::uuid, $2::uuid, $3, 'user', $4::uuid, '{}', 'running')`,
      [turn, threadId, ordinal, gw.userId],
    );
    await query("UPDATE turns SET status = $2, completed_at = now(), last_seq = 0 WHERE id = $1::uuid", [turn, status]);

    return turn;
  };

  const runs = (triggerId: string) =>
    query<{ input: string; status: string; client_request_id: string }>(
      "SELECT input, status, client_request_id FROM bot_turns WHERE routine_id = $1 ORDER BY created_at",
      [triggerId],
    );

  /** Matching happens on a tick; the batch closes once its quiet window passed. */
  const settle = async (id: string, seconds = 301) => {
    await idle(id);
    clock = new Date(clock.getTime() + seconds * 1000);

    return idle(id);
  };

  beforeAll(async () => {
    gw = await startTestGateway();
    await gw.api.saveProviderInstance({
      harness: Provider.CODEX,
      id: "trigger-test",
      label: "Trigger test",
      create: true,
      kind: ProviderProfileKind.CLIPROXYAPI,
      baseUrl: "http://127.0.0.1:1",
      apiKey: "fixture",
      allWorkers: true,
    });
    await eventually(
      () => gw.core.bots.run((s) => s.harnessModels(gw.userId, Provider.CODEX, "trigger-test")),
      (models) => models.some((m) => m.id === "gpt-6.1-sol"),
    );
    project = (await gw.api.createProject({ name: "Watched project" })).project!.id;
    other = (await gw.api.createProject({ name: "Other project" })).project!.id;
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

  test("a filter must name an event type and concrete resources of the owner", async () => {
    const id = await add();

    const empty = await ask(id, "create_trigger", {
      title: "Everything",
      instructions: "Tell me everything",
      event: "thread.turn_finished",
      filter: { scope: {} },
    });

    expect(empty.result).toContain("needs a scope");

    const foreign = await ask(id, "create_trigger", {
      title: "Someone else's",
      instructions: "x",
      event: "thread.turn_finished",
      filter: { scope: { project: [crypto.randomUUID()] } },
    });

    expect(foreign.result).toContain("Unknown or unavailable project ids");

    const unknown = await ask(id, "preview_trigger", { event: "thread.anything", filter: { scope: {} } });
    expect(unknown.result).toContain("unknown event type");
    expect((await read(id)).triggers).toHaveLength(0);
    expect(await query("SELECT * FROM bot_trigger_scopes WHERE owner_user_id = $1", [gw.userId])).toHaveLength(0);
  });

  test("matching failed turns in the scope coalesce into one isolated background run", async () => {
    const id = await add();
    await send(id, "My private note: the release is on Friday");
    const trigger = await watchFailures(id);

    expect(trigger.description).toContain("Watched project");
    expect(trigger.description).toContain("status is failed");

    const watched = await thread(project);
    const elsewhere = await thread(other);

    // Out of scope, or not matching the condition: nothing reaches a batch.
    await finish(elsewhere, "failed");
    expect(await query("SELECT id FROM bot_trigger_events WHERE owner_user_id = $1", [gw.userId])).toHaveLength(0);
    await finish(watched, "completed", 1);
    await finish(watched, "failed", 2);
    await finish(watched, "failed", 3);

    const seen: ModelInput[] = [];
    model = async (i) => {
      seen.push(i);

      return reply("Internal: two failures");
    };

    const after = await settle(id);
    const [run, ...rest] = await runs(trigger.id);

    expect(rest).toHaveLength(0);
    expect(run!.client_request_id).toStartWith(`trigger:${trigger.id}:`);
    expect(run!.status).toBe("completed");
    expect(run!.input).toContain("Event trigger instructions (Failed turns)");
    expect(run!.input).toContain("Matched events: 2");
    expect(run!.input).toContain('thread "Release build"');
    expect(run!.input).toContain("status=failed");
    expect(seen[0]!.instructions).toContain('HIDDEN BACKGROUND RUN of event trigger "Failed turns"');
    // Event data only: the owner's private conversation stays out of a trigger run.
    expect(seen[0]!.messages.some((m) => m.text.includes("release is on Friday"))).toBe(false);
    expect(seen[0]!.tools.map((t) => t.name)).not.toContain("create_trigger");
    expect(after.triggers[0]!.runCount).toBe(1);
    expect(after.triggers[0]!.matchedWeek).toBe(2);
  });

  test("a trigger changed after an event was recorded never receives it, and its own threads never wake it", async () => {
    const id = await add();
    const trigger = await watchFailures(id);
    const watched = await thread(project);

    await finish(watched, "failed");
    expect(await query("SELECT id FROM bot_trigger_events WHERE owner_user_id = $1", [gw.userId])).toHaveLength(1);
    await core.bots.run((s) => s.updateTrigger(gw.userId, id, trigger.id, { instructions: "New instructions" }));
    await settle(id);
    expect(await runs(trigger.id)).toHaveLength(0);

    // A thread this bot started is its own work.
    const own = await thread(project, "Bot's own work");
    const call = crypto.randomUUID();
    const [turn] = await query<{ id: string }>("SELECT id FROM bot_turns WHERE bot_id = $1 LIMIT 1", [id]);
    await query(
      `INSERT INTO bot_tool_calls(id, turn_id, call_key, tool, arguments, status) VALUES ($1::uuid, $2::uuid, $3, '{}', '{}', 'completed')`,
      [call, turn!.id, `own-${call}`],
    );
    await query("INSERT INTO bot_started_threads(thread_id, bot_id) VALUES ($1::uuid, $2::uuid)", [own, id]);
    await finish(own, "failed");
    await settle(id);
    expect(await runs(trigger.id)).toHaveLength(0);

    // A turn it watches reaches it as the watch's report, even after that report was delivered.
    const reported = await finish(watched, "failed", 2);
    await query(
      `INSERT INTO bot_thread_watches(call_id, bot_id, target_thread_id, target_turn_id, hops, delivered)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 1, true)`,
      [call, id, watched, reported],
    );
    await settle(id);
    expect(await runs(trigger.id)).toHaveLength(0);
  });

  test("turning a trigger off stops recording; the hourly limit holds batches and pauses a noisy trigger", async () => {
    const id = await add();
    clock = new Date("2030-01-07T08:01:00Z");
    const trigger = await watchFailures(id, { max_turns_per_hour: 1, coalesce_seconds: 30 });
    const watched = await thread(project);

    await gw.api.setBotTriggerEnabled({ botId: id, triggerId: trigger.id, enabled: false });
    await finish(watched, "failed", 1);
    expect(await query("SELECT id FROM bot_trigger_events WHERE owner_user_id = $1", [gw.userId])).toHaveLength(0);

    await gw.api.setBotTriggerEnabled({ botId: id, triggerId: trigger.id, enabled: true });
    await finish(watched, "failed", 2);
    await settle(id);
    expect(await runs(trigger.id)).toHaveLength(1);

    // A steady flood: each hour runs once and then holds the next batch at the limit. A run in between does not
    // reset the count; the third consecutive held hour pauses the trigger.
    let paused = await read(id);

    for (let ordinal = 3; ordinal <= 5; ordinal += 1) {
      await finish(watched, "failed", ordinal);
      paused = await settle(id, 31);
      expect(await runs(trigger.id)).toHaveLength(ordinal - 2);
      await finish(watched, "failed", ordinal + 10);
      paused = await settle(id, 31);

      if (ordinal < 5) clock = new Date(clock.getTime() + 3_600_000);
    }

    expect(await runs(trigger.id)).toHaveLength(3);
    expect(paused.triggers[0]!.autoPaused).toBe(true);
    expect(paused.messages.some((m) => m.text.includes("it fired too often"))).toBe(true);
    expect(await query("SELECT * FROM bot_trigger_scopes WHERE trigger_id = $1", [trigger.id])).toHaveLength(0);

    // The owner resumes it explicitly.
    const resumed = await gw.api.setBotTriggerEnabled({ botId: id, triggerId: trigger.id, enabled: true });
    expect(resumed.trigger?.autoPaused).toBe(false);
  });

  test("a trigger without history needs the owner's card, even in full auto; delete stops its runs", async () => {
    const id = await add("full_auto");
    model = async (i) =>
      lastTool(i) === undefined
        ? tool("create_trigger", {
            title: "Habits",
            instructions: "Review new habit suggestions",
            event: "habit.suggested",
            filter: { scope: { project: [project] } },
          })
        : reply("Asked");

    await core.bots.send(
      create(bots.SendBotMessageRequestSchema, {
        botId: id,
        text: "Tell me about habit suggestions",
        clientRequestId: Bun.randomUUIDv7(),
      }),
    );

    const waiting = await eventually(
      async () => {
        await core.bots.tick();

        return read(id);
      },
      (s) => s.approvals.some((a) => a.status === "pending"),
    );

    const card = waiting.approvals.find((a) => a.status === "pending");

    expect(card?.prompt).toContain("Creating event trigger “Habits”");
    expect(card?.prompt).toContain("cannot be estimated");
    await gw.api.answerBotApproval({ approvalId: card!.id, approve: true, answer: "" });
    const created = await idle(id);
    expect(created.triggers.map((t) => t.event)).toEqual(["habit.suggested"]);

    await gw.api.deleteBotTrigger({ botId: id, triggerId: created.triggers[0]!.id });
    expect((await read(id)).triggers).toHaveLength(0);
    expect(await failure(gw.api.deleteBotTrigger({ botId: id, triggerId: created.triggers[0]!.id }))).toContain(
      "not found",
    );
  });

  test("a due batch is read again under its locks: an event added while it waited is not lost", async () => {
    const id = await add();
    const trigger = await watchFailures(id);
    const watched = await thread(project);
    await finish(watched, "failed", 1);
    await idle(id);

    const gate = Promise.withResolvers<void>();
    const holding = Promise.withResolvers<void>();

    // Another session holds the trigger, as a matcher adding an event does, while the batch falls due.
    const matcher = gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM bot_routines WHERE id = ${trigger.id}::uuid FOR UPDATE`;
            holding.resolve();
            yield* Effect.promise(() => gate.promise);
            yield* sql`UPDATE bot_trigger_batches SET matched = matched + 1,
              events = events || jsonb_build_array(events -> 0) WHERE trigger_id = ${trigger.id}::uuid AND status = 'open'`;
          }),
        );
      }),
    );

    await holding.promise;
    clock = new Date(clock.getTime() + 301_000);
    const ticking = core.bots.tick();
    await eventually(
      () => query("SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()"),
      (rows) => rows.length > 0,
    );
    gate.resolve();
    await matcher;
    await ticking;
    await idle(id);

    const [run] = await runs(trigger.id);
    expect(run!.input).toContain("Matched events: 2");
  });

  test("a queued trigger run whose events were settled meanwhile ends without a model call", async () => {
    const id = await add("always");
    const trigger = await watchFailures(id);
    const watched = await thread(project);
    const runAt = new Date(Date.now() + 3600_000).toISOString();

    // The owner's own turn waits on a card, so the trigger run queues behind it.
    model = async (i) =>
      lastTool(i) === undefined ? tool("schedule_wakeup", { prompt: "Later", run_at: runAt }) : reply("Set");
    await core.bots.send(
      create(bots.SendBotMessageRequestSchema, { botId: id, text: "Remind me", clientRequestId: Bun.randomUUIDv7() }),
    );

    const card = (
      await eventually(
        async () => {
          await core.bots.tick();

          return read(id);
        },
        (x) => x.approvals.some((a) => a.status === "pending"),
      )
    ).approvals.find((a) => a.status === "pending")!;

    await finish(watched, "failed");
    await core.bots.tick();
    clock = new Date(clock.getTime() + 301_000);
    await core.bots.tick();
    expect((await runs(trigger.id)).map((r) => r.status)).toEqual(["queued"]);

    await query("UPDATE threads SET archived_at = now() WHERE id = $1::uuid", [watched]);
    const seen: ModelInput[] = [];
    model = async (i) => {
      seen.push(i);

      return lastTool(i) === undefined ? tool("schedule_wakeup", { prompt: "Later", run_at: runAt }) : reply("Set");
    };

    await gw.api.answerBotApproval({ approvalId: card.id, approve: true, answer: "" });
    const after = await idle(id);

    expect((await runs(trigger.id)).map((r) => r.status)).toEqual(["completed"]);
    expect(seen.some((i) => i.instructions.includes("event trigger"))).toBe(false);
    expect(after.triggers[0]!.lastOutcome).toBe("Nothing left to report");
  });

  test("a trigger run's first command is checked again under its lease and before it is first sent", async () => {
    const id = await add("always");
    const trigger = await watchFailures(id);
    const watched = await thread(project);
    const runAt = new Date(Date.now() + 3600_000).toISOString();

    // The owner's own turn waits on a card, so the trigger run stays queued.
    model = async (i) =>
      lastTool(i) === undefined ? tool("schedule_wakeup", { prompt: "Later", run_at: runAt }) : reply("Set");
    await core.bots.send(
      create(bots.SendBotMessageRequestSchema, { botId: id, text: "Remind me", clientRequestId: Bun.randomUUIDv7() }),
    );
    await eventually(
      async () => {
        await core.bots.tick();

        return read(id);
      },
      (x) => x.approvals.some((a) => a.status === "pending"),
    );
    const second = await thread(project, "Nightly build");
    await finish(watched, "failed");
    await finish(second, "failed");
    await core.bots.tick();
    clock = new Date(clock.getTime() + 301_000);
    await core.bots.tick();

    // As if this gateway had claimed it and written its command for a worker that is offline.
    const lease = crypto.randomUUID();

    const [turn] = await query<BotTurn>(
      `UPDATE bot_turns SET status = 'running', lease_token = $2::uuid, lease_until = now() + interval '1 minute'
       WHERE routine_id = $1::uuid RETURNING *`,
      [trigger.id, lease],
    );

    const write = async () => {
      const command = crypto.randomUUID();
      await query(
        `WITH c AS (INSERT INTO worker_commands(id, worker_id, kind, payload, expires_at)
           VALUES ($4::uuid, $3::uuid, 'runBotTurn', '\\x00'::bytea, now() + interval '1 day'))
         INSERT INTO bot_harness_turns(turn_id, bot_id, worker_id, command_id) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        [turn!.id, id, gw.workerId, command],
      );

      return command;
    };

    const status = async (command: string) =>
      (await query<{ status: string }>("SELECT status FROM worker_commands WHERE id = $1::uuid", [command]))[0]?.status;

    const row = async () =>
      (
        await query<{ input: string; lease_token: string | null; job: string | null }>(
          `SELECT t.input, t.lease_token, h.command_id AS job FROM bot_turns t
           LEFT JOIN bot_harness_turns h ON h.turn_id = t.id WHERE t.id = $1::uuid`,
          [turn!.id],
        )
      )[0]!;

    const first = await write();
    const dispatchable = (command: string) => core.bots.run((s) => s.triggerDispatchable(command, clock));

    const recheck = (token: string) =>
      core.bots.run((s) => s.recheckTrigger(gw.userId, { ...turn!, lease_token: token }, clock));

    // One of the two events is settled before the first send: the refusal is recorded with the check.
    await query("UPDATE threads SET archived_at = now() WHERE id = $1::uuid", [second]);
    expect(await dispatchable(first)).toBe(false);
    expect(await status(first)).toBe("failed");
    // Its payload (events and context) is cleared; the row keeps its id and result for late deliveries.
    expect(
      (
        await query<{ size: number }>("SELECT length(payload) AS size FROM worker_commands WHERE id = $1::uuid", [
          first,
        ])
      )[0]?.size,
    ).toBe(0);
    // Restoring the thread cannot revive a refused command.
    await query("UPDATE threads SET archived_at = NULL WHERE id = $1::uuid", [second]);
    expect(await dispatchable(first)).toBe(true);
    expect(await status(first)).toBe("failed");
    await query("UPDATE threads SET archived_at = now() WHERE id = $1::uuid", [second]);

    // A gateway that lost the lease changes nothing; the holder restarts the run with the event still current.
    expect(await recheck(crypto.randomUUID())).toBe("lost");
    expect((await row()).lease_token).toBe(lease);
    expect(await recheck(lease)).toBe("changed");
    const restarted = await row();
    expect(restarted.job).toBeNull();
    expect(restarted.lease_token).toBeNull();
    expect(restarted.input).toContain(watched);
    expect(restarted.input).not.toContain(second);
    // The refused command id is retired: a delivery still holding it never goes out.
    expect(await core.bots.run((s) => s.harnessDispatchable(first))).toBe(false);

    // The first send is recorded before the frame leaves; after it, a settled event never stops recovery.
    await query("UPDATE bot_turns SET lease_token = $2::uuid WHERE id = $1::uuid", [turn!.id, lease]);
    const next = await write();
    expect(await dispatchable(next)).toBe(true);
    expect(await status(next)).toBe("delivered");
    await query("UPDATE threads SET archived_at = now() WHERE id = $1::uuid", [watched]);
    expect(await dispatchable(next)).toBe(true);
    await query("DELETE FROM bot_harness_turns WHERE turn_id = $1::uuid", [turn!.id]);
    await query("DELETE FROM worker_commands WHERE id = ANY($1::uuid[])", [[first, next]]);

    // A trigger run waits for its worker's bot link on any gateway; a link without the bot harness fails it.
    const [saved] = await query<{ journal: string | null; presence: string | null }>(
      `SELECT bot_journal_id AS journal, bot_presence_until::text AS presence FROM worker_connections
       WHERE worker_id = $1::uuid`,
      [gw.workerId],
    );

    const link = async (journal: string | null, presence: string | null) => {
      await query(
        `INSERT INTO worker_connections(worker_id, instance_id, epoch, bot_journal_id, bot_presence_until)
         VALUES ($1::uuid, 'other-gateway', 1, $2, $3::timestamptz)
         ON CONFLICT (worker_id) DO UPDATE SET bot_journal_id = $2, bot_presence_until = $3::timestamptz`,
        [gw.workerId, journal, presence],
      );

      return core.bots.run((s) => s.workerBotLink(gw.workerId));
    };

    expect(await link("journal", new Date(Date.now() + 30_000).toISOString())).toBe("present");
    expect(await link("journal", null)).toBe("away");
    expect(await link(null, null)).toBe("outdated");

    // A worker archived while a turn waits for it can never connect again: its open command ends, sent or not,
    // and a start it already acknowledged ends its harness turn.
    const settle = () => core.bots.run((s) => s.settleRemovedWorker(turn!.id, gw.workerId));

    const outcome = async () =>
      (
        await query<{ outcome: number | null; error_code: string }>(
          "SELECT outcome, error_code FROM bot_harness_turns WHERE turn_id = $1::uuid",
          [turn!.id],
        )
      )[0];

    const waiting = await write();
    await query("UPDATE worker_commands SET status = 'delivered' WHERE id = $1::uuid", [waiting]);
    expect(await settle()).toBe(false);
    expect(await status(waiting)).toBe("delivered");
    // A stale check naming another, removed worker never touches this worker's command.
    const other = (await gw.addWorker(`Removed ${crypto.randomUUID().slice(0, 8)}`)).workerId;
    await query("UPDATE workers SET archived_at = now() WHERE id = $1::uuid", [other]);
    expect(await core.bots.run((s) => s.settleRemovedWorker(turn!.id, other))).toBe(true);
    expect(await status(waiting)).toBe("delivered");
    await query("UPDATE workers SET archived_at = now() WHERE id = $1::uuid", [gw.workerId]);
    expect(await link("journal", null)).toBe("removed");
    expect(await settle()).toBe(true);
    expect(await status(waiting)).toBe("failed");
    expect((await outcome())?.outcome).toBeNull();
    await query("UPDATE worker_commands SET status = 'completed' WHERE id = $1::uuid", [waiting]);
    await settle();
    expect(await outcome()).toEqual({ outcome: 3, error_code: "BOT_WORKER_REMOVED" });
    await query("UPDATE workers SET archived_at = NULL WHERE id = $1::uuid", [gw.workerId]);
    await query("DELETE FROM bot_harness_turns WHERE turn_id = $1::uuid", [turn!.id]);
    await query("DELETE FROM worker_commands WHERE id = $1::uuid", [waiting]);

    // Only the worker's current registration refuses a command it cannot run, and only one never attempted.
    const [{ epoch } = { epoch: "0" }] = await query<{ epoch: string }>(
      "SELECT epoch::text AS epoch FROM worker_connections WHERE worker_id = $1::uuid",
      [gw.workerId],
    );

    const refuse = async (command: string, registration: string) => {
      await core.bots.run((s) => s.refuseBotCommand(command, gw.workerId, BigInt(registration)));

      return status(command);
    };

    const pending = crypto.randomUUID();
    await query(
      `INSERT INTO worker_commands(id, worker_id, kind, payload, expires_at)
       VALUES ($1::uuid, $2::uuid, 'runBotTurn', '\\x00'::bytea, now() + interval '1 day')`,
      [pending, gw.workerId],
    );
    expect(await refuse(pending, String(BigInt(epoch) - 1n))).toBe("pending");

    // Any bot command handed to the link counts as attempted, even while its ACK is still outstanding.
    const command = create(CommandSchema, {
      commandId: pending,
      kind: { case: "runBotTurn", value: { turnId: crypto.randomUUID() } },
    });

    await gw.runtime.runPromise(GatewayStore.use((s) => s.sendPending(command, () => undefined)));
    expect(await refuse(pending, epoch)).toBe("delivered");
    await query("UPDATE worker_commands SET status = 'pending', delivered_epoch = NULL WHERE id = $1::uuid", [pending]);
    expect(await refuse(pending, epoch)).toBe("failed");
    await query("DELETE FROM worker_commands WHERE id = $1::uuid", [pending]);

    if (saved) await link(saved.journal, saved.presence);
    else await query("DELETE FROM worker_connections WHERE worker_id = $1::uuid", [gw.workerId]);
  });

  test("events recorded before Bots is turned off are never delivered after it is turned back on", async () => {
    const id = await add();
    const trigger = await watchFailures(id);
    const watched = await thread(project);
    await finish(watched, "failed");
    await idle(id);

    const settings = async (...enabled: string[]) => {
      const { user } = await gw.api.getSettings({});
      await gw.api.updateUserSettings({ expectedVersion: user!.version, modules: { enabled } });
    };

    // A source transaction records its event before both transitions and commits after them.
    const gate = Promise.withResolvers<void>();
    const recorded = Promise.withResolvers<void>();
    const late = crypto.randomUUID();

    const source = gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO turns(id, thread_id, ordinal, trigger, author_user_id, input, status)
              VALUES (${late}::uuid, ${watched}::uuid, 7, 'user', ${gw.userId}::uuid, '{}', 'running')`;
            yield* sql`UPDATE turns SET status = 'failed', completed_at = now(), last_seq = 0 WHERE id = ${late}::uuid`;
            recorded.resolve();
            yield* Effect.promise(() => gate.promise);
          }),
        );
      }),
    );

    await recorded.promise;
    await settings("threads");
    await settings("threads", "bots");
    gate.resolve();
    await source;
    expect(await query("SELECT id FROM bot_trigger_events WHERE owner_user_id = $1", [gw.userId])).toHaveLength(1);
    await settle(id);
    expect(await runs(trigger.id)).toHaveLength(0);
    expect(await query("SELECT id FROM bot_trigger_events WHERE owner_user_id = $1", [gw.userId])).toHaveLength(0);
    expect(
      await query("SELECT id FROM bot_trigger_batches WHERE trigger_id = $1 AND status = 'open'", [trigger.id]),
    ).toHaveLength(0);
  });

  test("a trigger run cannot read a thread delegated from an external conversation", async () => {
    const id = await add();
    const trigger = await watchFailures(id);
    const watched = await thread(project);
    const delegated = await thread(project, "Delegated work");
    await query("UPDATE threads SET memory_audience = $2 WHERE id = $1::uuid", [delegated, `conversation:${id}:x`]);

    const results: string[] = [];
    model = async (i) => {
      const done = lastTool(i);

      if (done === undefined) return tool("read_thread", { thread_id: delegated });
      results.push(done);

      return reply("Internal: done");
    };

    await finish(watched, "failed");
    await settle(id);
    expect(await runs(trigger.id)).toHaveLength(1);
    expect(results[0]).toContain("not delegated from a conversation");
  });
});
