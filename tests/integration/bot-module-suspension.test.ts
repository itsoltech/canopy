import { describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { Provider, TurnOutcome, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { BotStore } from "../../apps/gateway/src/bots/store.ts";
import { lockModuleChanges } from "../../apps/gateway/src/store/module-access.ts";
import { SettingsStore } from "@canopy/gateway/store";
import type { BotTurn } from "../../apps/gateway/src/bots/types.ts";
import { botsSuite, lastInput, reply, tool } from "./support/bots.ts";
import { harnessBots } from "./support/harness-bots.ts";
import { eventually, failure } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("suspending and resuming the owner's Bots module", () => {
  const { suite, add, read, send, restart, settled } = botsSuite();

  const query = <R extends object>(text: string, values: string[]) =>
    suite.gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<R>(text, values)));

  async function modules(...enabled: string[]) {
    const { user } = await suite.gw.api.getSettings({});
    await suite.gw.api.updateUserSettings({ expectedVersion: user!.version, modules: { enabled } });
  }

  test("interrupts active work, expires approvals and keeps untouched inputs through a restart", async () => {
    const bot = await add("Paused conversation");
    const waiting = await add("Pending proposal", { approvalPolicy: "always" });
    const started = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const inputs: string[] = [];
    suite.model = async (input) => {
      const text = lastInput(input);
      inputs.push(text);

      if (text === "Request approval") return tool("rename_project", { project_id: suite.projectId, name: "Changed" });

      if (text === "Hold me") {
        started.resolve(input.signal);
        await release.promise;
      }

      return reply(`Finished ${text}`);
    };

    try {
      await send(waiting.id, "Request approval");

      const proposal = await eventually(
        () => read(waiting.id),
        (v) => v.approvals.some((a) => a.status === "pending"),
      );

      expect(proposal.approvals[0]?.status).toBe("pending");
      await send(bot.id, "Hold me");
      const signal = await started.promise;
      await send(bot.id, "First queued input");
      await send(bot.id, "Second queued input");
      await modules("threads");

      expect(signal.aborted).toBe(true);
      expect((await read(bot.id)).working).toBe(false);
      expect((await read(waiting.id)).approvals[0]?.status).toBe("expired");
      expect(await failure(send(bot.id, "Refuse new input"))).toContain("Enable Bots");
      release.resolve();
      await restart();

      expect(await suite.current.bots.run((s) => s.claim(suite.gw.userId))).toBeUndefined();
      expect((await read(bot.id)).messages.at(-1)?.text).toContain("Bots was turned off");
      await modules("threads", "bots");
      await suite.current.bots.tick();
      const resumed = await settled(bot.id);
      expect(inputs).toEqual(["Request approval", "Hold me", "First queued input", "Second queued input"]);
      expect(resumed.messages.map((m) => m.text)).not.toContain("Finished Hold me");
      expect(resumed.messages.at(-1)?.text).toBe("Finished Second queued input");
    } finally {
      release.resolve();
      await modules("threads", "bots");
    }
  }, 25_000);

  for (const operation of ["archive", "delete"] as const) {
    test(`can ${operation} a pinned bot during module disable`, async () => {
      const bot = await add(`Pinned for ${operation}`);
      const owner = suite.gw.userId;
      const { user } = await suite.gw.api.getSettings({});

      const pinned = await suite.gw.api.updateUserSettings({
        expectedVersion: user!.version,
        sidebar: { pinnedBotIds: [bot.id] },
      });

      const writerPid = Promise.withResolvers<number>();
      const botPid = Promise.withResolvers<number>();
      const finishDisable = Promise.withResolvers<void>();

      const disabling = failure(
        suite.gw.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                // Pause the real settings write at the point immediately before it needs the bot row.
                yield* lockModuleChanges(sql, owner);
                yield* sql`SELECT user_id FROM user_settings WHERE user_id=${owner}::uuid FOR UPDATE`;
                writerPid.resolve((yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
                yield* Effect.promise(() => finishDisable.promise);
                yield* SettingsStore.use((s) =>
                  s.updateUser({
                    userId: owner,
                    expectedVersion: pinned.settings!.version,
                    modules: create(ui.ModuleSettingsSchema, { enabled: ["threads"] }),
                  }),
                );
              }),
            );
          }),
        ),
      );

      const writer = await writerPid.promise;

      const unpinning = failure(
        suite.gw.runtime.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const bots = yield* BotStore;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                botPid.resolve((yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);

                if (operation === "archive") yield* bots.archive(owner, bot.id, true);
                else yield* bots.remove(owner, bot.id);
              }),
            );
          }),
        ),
      );

      try {
        const candidate = await botPid.promise;

        const waits = await eventually(
          () =>
            query("SELECT pid FROM pg_stat_activity WHERE pid=$1 AND $2=ANY(pg_blocking_pids(pid))", [
              String(candidate),
              String(writer),
            ]),
          (rows) => rows.length === 1,
        );

        expect(waits).toHaveLength(1);
        finishDisable.resolve();
        expect(await Promise.all([disabling, unpinning])).toEqual(["", ""]);
        const { user: after } = await suite.gw.api.getSettings({});
        expect(after?.modules?.enabled).toEqual(["threads"]);
        expect(after?.sidebar?.pinnedBotIds).toEqual([]);
      } finally {
        finishDisable.resolve();
        await Promise.all([disabling, unpinning]);
        await modules("threads", "bots");
      }
    }, 15_000);
  }

  test("skips missed routine ticks and delivers overdue one-shot reminders once after resume", async () => {
    const bot = await add("Paused scheduler");
    await suite.current.bots.stop();
    const owner = suite.gw.userId;
    const run = suite.current.bots.run.bind(suite.current.bots);
    await run((s) => s.enqueue(owner, bot.id, "Set up", crypto.randomUUID()));
    const source = (await run((s) => s.claim(owner)))!;

    const makeRoutine = (title: string) =>
      run((s) =>
        s.createRoutine(
          owner,
          source,
          crypto.randomUUID(),
          {
            title,
            instructions: "Check for changes",
            cron: "*/15 * * * *",
            timezone: "Europe/Warsaw",
          },
          new Date(),
        ),
      );

    const recurring = await makeRoutine("Every quarter hour");
    const paused = await makeRoutine("Manually paused");
    await run((s) => s.updateRoutine(owner, bot.id, paused.id, { enabled: false }, new Date()));

    const makeReminder = async (turn: BotTurn, prompt: string) => {
      const call = await run((s) =>
        s.planCall(
          turn,
          prompt,
          {
            name: "schedule_wakeup",
            source: "platform",
            description: "",
            parameters: {},
          },
          { prompt, run_at: new Date(Date.now() + 60_000).toISOString() },
        ),
      );

      await run((s) => s.wakeup(turn, call));
      await query("UPDATE bot_wakeups SET run_at=now()-interval '1 second' WHERE id=$1", [call.id]);

      return call.id;
    };

    const reminder = await makeReminder(source, "Overdue reminder");
    const cancelled = await makeReminder(source, "Cancelled reminder");
    await run((s) => s.cancelReminder(owner, bot.id, cancelled));
    await run((s) => s.finish(source, "completed", "Configured"));

    const foreignOwner = crypto.randomUUID();
    const foreignBot = crypto.randomUUID();
    await query("INSERT INTO users(id,email,display_name,role) VALUES($1,'other-bots@example.test','Other','user')", [
      foreignOwner,
    ]);
    await query(
      `INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
      SELECT $1,$2,'foreign',configuration,provider,provider_instance FROM bots WHERE id=$3`,
      [foreignBot, foreignOwner, bot.id],
    );
    await run((s) => s.enqueue(foreignOwner, foreignBot, "Keep running", crypto.randomUUID()));
    const other = (await run((s) => s.claim(foreignOwner)))!;

    await makeReminder(other, "Other owner");

    try {
      await modules("threads");
      await query("UPDATE bot_routines SET next_run_at=now()-interval '1 day' WHERE id=$1", [recurring.id]);
      expect(await run((s) => s.poll(owner, new Date()))).toEqual({ configured: false, ready: false });
      await run((s) => s.deliver(owner));
      await run((s) => s.deliverRoutines(owner, new Date()));
      expect(await run((s) => s.claim(owner))).toBeUndefined();
      expect(await query("SELECT delivered FROM bot_wakeups WHERE id=$1", [reminder])).toEqual([{ delivered: false }]);
      expect(await run((s) => s.heartbeat(other))).toBe(true);

      await modules("bots", "threads");
      await run((s) => s.deliverRoutines(owner, new Date()));
      await run((s) => s.deliver(owner));
      await run((s) => s.deliver(owner));

      const jobs = await query<{ client_request_id: string }>(
        "SELECT client_request_id FROM bot_turns WHERE bot_id=$1 AND status='queued'",
        [bot.id],
      );

      expect(jobs).toEqual([{ client_request_id: `wakeup:${reminder}` }]);
      expect(await query("SELECT delivered FROM bot_wakeups WHERE bot_id=$1", [foreignBot])).toEqual([
        { delivered: false },
      ]);
      expect(
        await query("SELECT enabled,run_count,next_run_at>now() AS future FROM bot_routines WHERE id=$1", [
          recurring.id,
        ]),
      ).toEqual([{ enabled: true, run_count: 0, future: true }]);
      expect(await query("SELECT enabled,next_run_at FROM bot_routines WHERE id=$1", [paused.id])).toEqual([
        { enabled: false, next_run_at: null },
      ]);
    } finally {
      await modules("threads", "bots");
    }
  }, 20_000);
});

test.skipIf(!dockerAvailable)(
  "an offline bot harness is interrupted on reconnect and cannot publish a late answer",
  async () => {
    const f = await harnessBots();
    let disconnect = async () => {};

    try {
      const bot = await f.add(Provider.CODEX);
      const turn = await f.send(bot.id, "STOP_REPLY HOLD:module-offline");

      const partial = await eventually(
        () => f.read(bot.id),
        (v) => v.streamingText === "Partial reply",
        10_000,
      );

      expect(partial.streamingText).toBe("Partial reply");
      const processRecord = f.records().findLast((r) => r.event === "turn" && r.home.includes(`/bots/${bot.id}/`));
      expect(processRecord).toBeDefined();
      await f.disconnect();
      const { user } = await f.gw.api.getSettings({});
      await f.gw.api.updateUserSettings({ expectedVersion: user!.version, modules: { enabled: ["threads"] } });
      await f.restartGateway();
      f.gw.core.bots.start();
      disconnect = await f.reconnect();

      const gone = await eventually(async () => {
        try {
          process.kill(processRecord!.pid, 0);

          return false;
        } catch {
          return true;
        }
      }, Boolean);

      expect(gone).toBe(true);
      expect((await f.read(bot.id)).messages.slice(-2).map((m) => m.text)).toEqual([
        "Partial reply",
        "Stopped because Bots was turned off",
      ]);
      expect((await f.gw.core.bots.run((s) => s.harnessTurn(turn.turnId)))?.outcome).toBe(TurnOutcome.INTERRUPTED);
      const state = await f.gw.api.getSettings({});
      await f.gw.api.updateUserSettings({
        expectedVersion: state.user!.version,
        modules: { enabled: ["threads", "bots"] },
      });
      await f.send(bot.id, "Next reply");
      expect((await f.settled(bot.id)).messages.at(-1)?.text).toBe("FIXTURE_OK");
    } finally {
      await disconnect();
      await f.close();
    }
  },
  35_000,
);
