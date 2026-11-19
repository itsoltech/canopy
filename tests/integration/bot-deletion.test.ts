import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Provider } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import type { JsonObject } from "@canopy/domain";
import { GatewayStore } from "@canopy/gateway/store";
import { Code, ConnectError } from "@connectrpc/connect";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { BotStore } from "../../apps/gateway/src/bots/store.ts";
import type { BotTurn } from "../../apps/gateway/src/bots/types.ts";
import { fakeConnector } from "./support/connector.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("deleting bots through the gateway", () => {
  let gw: TestGateway;
  let connector: ReturnType<typeof fakeConnector>;

  beforeAll(async () => {
    gw = await startTestGateway();
    connector = fakeConnector();
    // Use the real store to dispatch work at explicit points in each test.
    await gw.core.bots.stop();
  }, 30_000);
  afterAll(async () => {
    try {
      await gw?.close();
    } finally {
      await connector?.close();
    }
  });

  const run = <A, E>(use: (store: BotStore["Service"]) => Effect.Effect<A, E>) => gw.core.bots.run(use);

  const query = <Row extends object>(statement: string, ...params: (string | number)[]) =>
    gw.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<Row>(statement, params)));

  const add = async (name: string) =>
    (
      await gw.api.createBot({
        clientRequestId: crypto.randomUUID(),
        configuration: {
          name,
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "native",
          model: "gpt-6.1-sol",
          workerId: gw.workerId,
        },
      })
    ).bot!;

  const send = (botId: string, text: string) =>
    gw.api.sendBotMessage({ botId, text, clientRequestId: crypto.randomUUID() }, { timeoutMs: 10_000 });

  async function claim(botId: string, text: string) {
    const { turnId } = await send(botId, text);
    const turn = (await run((store) => store.claim(gw.userId)))!;
    expect(turn.id).toBe(turnId);

    return turn;
  }

  const plan = (turn: BotTurn, key: string, name: string, arguments_: JsonObject = {}) =>
    run((store) =>
      store.planCall(turn, key, { name, source: "platform", description: "", parameters: {} }, arguments_),
    );

  async function reminder(turn: BotTurn, text: string) {
    const call = await plan(turn, text, "schedule_wakeup", {
      prompt: text,
      run_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    await run((store) => store.action(turn, call, store.wakeup(turn, call)));

    return call.id;
  }

  const routine = (turn: BotTurn) =>
    run((store) =>
      store.createRoutine(
        gw.userId,
        turn,
        crypto.randomUUID(),
        { title: "Check releases", instructions: "Read published releases", cron: "*/15 * * * *", timezone: "UTC" },
        new Date(),
      ),
    );

  async function watchThread(turn: BotTurn) {
    const project = (await gw.api.createProject({ name: "Watched project" })).project!;

    const workspace = (
      await gw.api.createWorkspace({ projectId: project.id, workerId: gw.workerId, rootPath: "/repo" })
    ).workspace!;

    const thread = (
      await gw.api.createThread({
        projectId: project.id,
        workspaceId: workspace.id,
        provider: Provider.CODEX,
        model: "gpt-6.1-sol",
        initialMessage: "Work independently",
      })
    ).thread!;

    const call = await plan(turn, "watch", "start_thread");
    await query(
      `INSERT INTO bot_thread_watches(call_id, bot_id, target_thread_id, target_turn_id, hops)
       SELECT $1::uuid, $2::uuid, thread_id, id, 1 FROM turns WHERE thread_id=$3::uuid`,
      call.id,
      turn.bot_id,
      thread.id,
    );

    return call.id;
  }

  async function deletionState(botId: string) {
    return (
      await query(
        `SELECT deleted_at, archived_at, revision, status_line,
          (SELECT jsonb_agg(t ORDER BY t.created_at,t.id) FROM bot_turns t WHERE t.bot_id=b.id) AS turns,
          (SELECT jsonb_agg(a ORDER BY a.id) FROM bot_approvals a WHERE a.bot_id=b.id) AS approvals,
          (SELECT jsonb_agg(w ORDER BY w.prompt) FROM bot_wakeups w WHERE w.bot_id=b.id) AS wakeups,
          (SELECT jsonb_agg(r ORDER BY r.id) FROM bot_routines r WHERE r.bot_id=b.id) AS routines,
          (SELECT jsonb_agg(w ORDER BY w.call_id) FROM bot_thread_watches w WHERE w.bot_id=b.id) AS watches,
          (SELECT jsonb_agg(g ORDER BY g.account_id) FROM connector_bot_grants g WHERE g.bot_id=b.id) AS grants
        FROM bots b WHERE b.id=$1::uuid`,
        botId,
      )
    )[0];
  }

  const transcript = (botId: string) =>
    query("SELECT id, text FROM bot_messages WHERE bot_id=$1::uuid ORDER BY seq", botId);

  test("a late cleanup failure rolls back active bot deletion and a retry stops work while retaining history", async () => {
    const bot = await add("Delete with active work");
    const sibling = await add("Keep connector access");
    const { user } = await gw.api.getSettings({});

    await gw.api.updateUserSettings({
      expectedVersion: user!.version,
      sidebar: { pinnedBotIds: [bot.id, sibling.id] },
    });

    const foreignOwner = await gw.runtime.runPromise(
      GatewayStore.use((store) => store.ensureUser("bot-deletion-foreign@example.test", "Other owner")),
    );

    const foreignBot = crypto.randomUUID();
    await query(
      `INSERT INTO bots(id,owner_user_id,client_request_id,configuration,provider,provider_instance)
       SELECT $1::uuid,$2::uuid,'foreign',configuration,provider,provider_instance FROM bots WHERE id=$3::uuid`,
      foreignBot,
      foreignOwner,
      sibling.id,
    );

    const foreign = await deletionState(foreignBot);
    expect(await gw.api.deleteBot({ botId: foreignBot }).catch(ConnectError.from)).toMatchObject({
      code: Code.NotFound,
    });
    expect(await deletionState(foreignBot)).toEqual(foreign);

    const account = (
      await gw.api.saveConnectorAccount({
        connectorType: "custom",
        name: "Shared account",
        url: connector.url,
        authKind: "headers",
        token: connector.secret,
      })
    ).account!;

    await gw.api.setConnectorAccess({
      accountId: account.id,
      expectedRevision: account.revision,
      workerIds: [gw.workerId],
      botIds: [bot.id, sibling.id],
    });

    const past = await claim(bot.id, "Past input");
    const delivered = await reminder(past, "Already delivered");
    await query("UPDATE bot_wakeups SET delivered=true WHERE id=$1::uuid", delivered);
    await run((store) => store.finish(past, "completed", "Past answer"));

    const active = await claim(bot.id, "Active request");
    const approval = await plan(active, "question", "ask_user");
    await run((store) => store.approval(active, approval, "Continue?", true));
    const pending = await reminder(active, "Still pending");
    const scheduled = await routine(active);
    const watch = await watchThread(active);
    const { turnId: queued } = await send(bot.id, "Queued input");
    const history = await transcript(bot.id);
    const before = await deletionState(bot.id);
    const { user: pinned } = await gw.api.getSettings({});

    await query(`CREATE FUNCTION reject_bot_grant_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM bots WHERE id=OLD.bot_id AND configuration->>'name'='Delete with active work') THEN
          RAISE EXCEPTION USING MESSAGE='fixture late cleanup failure', CONSTRAINT='fixture_late_bot_cleanup';
        END IF;
        RETURN OLD;
      END $$`);
    await query(`CREATE TRIGGER reject_bot_grant_cleanup BEFORE DELETE ON connector_bot_grants
      FOR EACH ROW EXECUTE FUNCTION reject_bot_grant_cleanup()`);

    try {
      expect(await gw.api.deleteBot({ botId: bot.id }).catch(ConnectError.from)).toMatchObject({
        code: Code.FailedPrecondition,
        rawMessage: "rejected by fixture_late_bot_cleanup",
      });
      expect(await deletionState(bot.id)).toEqual(before);
      expect(await transcript(bot.id)).toEqual(history);
      expect((await gw.api.getSettings({})).user).toEqual(pinned);
      expect((await gw.api.getBot({ botId: bot.id })).bot).toMatchObject({ id: bot.id, archived: false });
    } finally {
      await query("DROP TRIGGER reject_bot_grant_cleanup ON connector_bot_grants");
      await query("DROP FUNCTION reject_bot_grant_cleanup()");
    }

    await gw.api.deleteBot({ botId: bot.id });
    const listed = (await gw.api.listBots({ includeArchived: true })).bots.map((item) => item.id);
    expect(listed).toContain(sibling.id);
    expect(listed).not.toContain(bot.id);
    await expect(run((store) => store.finish(active, "completed", "Late answer"))).rejects.toThrow("bot lease lost");
    expect(await deletionState(bot.id)).toMatchObject({
      deleted_at: expect.any(Date),
      archived_at: null,
      status_line: "",
      turns: [
        { id: past.id, status: "completed" },
        { id: active.id, status: "interrupted", lease_token: null, lease_until: null },
        { id: queued, status: "interrupted", lease_token: null, lease_until: null },
      ],
      approvals: [{ id: approval.id, status: "expired" }],
      wakeups: [
        { id: delivered, delivered: true, cancelled: false },
        { id: pending, delivered: false, cancelled: true },
      ],
      routines: [{ id: scheduled.id, deleted_at: expect.any(String), enabled: false, next_run_at: null }],
      watches: [{ call_id: watch, delivered: true }],
      grants: null,
    });
    expect((await gw.api.getSettings({})).user?.sidebar?.pinnedBotIds).toEqual([sibling.id]);
    expect(await query("SELECT bot_id FROM connector_bot_grants WHERE account_id=$1::uuid", account.id)).toEqual([
      { bot_id: sibling.id },
    ]);
    expect(await query("SELECT worker_id FROM connector_worker_grants WHERE account_id=$1::uuid", account.id)).toEqual([
      { worker_id: gw.workerId },
    ]);
    expect(await deletionState(foreignBot)).toEqual(foreign);
    expect(history).toContainEqual({ id: expect.any(String), text: "Past answer" });
    expect(await transcript(bot.id)).toEqual(history);
  }, 20_000);

  const blockedBy = (pid: number, waiting = 1) =>
    eventually(
      () =>
        query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))",
          pid,
        ),
      (rows) => rows.length >= waiting,
    );

  test("deletion fences scheduled dispatch and message admission already waiting to proceed", async () => {
    const bot = await add("Delete while dispatching");
    const source = await claim(bot.id, "Configure scheduled work");
    const wakeup = await reminder(source, "Due wakeup");
    const scheduled = await routine(source);
    await run((store) => store.finish(source, "completed", "Configured"));
    await query("UPDATE bot_wakeups SET run_at=now()-interval '1 minute' WHERE id=$1::uuid", wakeup);
    await query("UPDATE bot_routines SET next_run_at=now()-interval '1 minute' WHERE id=$1::uuid", scheduled.id);

    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();

    const holding = gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM bot_wakeups WHERE id=${wakeup}::uuid FOR UPDATE`;
            locked.resolve((yield* sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`)[0]!.pid);
            yield* Effect.promise(() => release.promise);
          }),
        );
      }),
    );

    try {
      const pid = await Promise.race([
        locked.promise,
        holding.then(() => {
          throw new Error("Wakeup lock was released before deletion started");
        }),
      ]);

      const deleting = gw.api.deleteBot({ botId: bot.id }, { timeoutMs: 15_000 }).catch(ConnectError.from);

      try {
        const blocked = await blockedBy(pid);
        expect(blocked).toHaveLength(1);
        const sending = send(bot.id, "Concurrent input").catch(ConnectError.from);

        const dispatching = Promise.allSettled([
          run((store) => store.deliver(gw.userId)),
          run((store) => store.deliverRoutines(gw.userId, new Date())),
        ]);

        try {
          expect(await blockedBy(blocked[0]!.pid, 3)).toHaveLength(3);
        } finally {
          release.resolve();
          await Promise.all([sending, dispatching]);
        }

        expect(await sending).toMatchObject({ code: Code.NotFound });
        expect((await dispatching).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      } finally {
        release.resolve();
        await deleting;
      }

      expect(await deleting).not.toBeInstanceOf(ConnectError);
    } finally {
      release.resolve();
      await holding;
    }

    expect(await send(bot.id, "Fresh input after deletion").catch(ConnectError.from)).toMatchObject({
      code: Code.NotFound,
    });
    await run((store) => store.deliver(gw.userId));
    await run((store) => store.deliverRoutines(gw.userId, new Date()));
    expect(await run((store) => store.claim(gw.userId))).toBeUndefined();
    expect(await query("SELECT id FROM bot_turns WHERE bot_id=$1::uuid", bot.id)).toEqual([{ id: source.id }]);
  }, 25_000);

  test("an archived bot can still be deleted and cannot be unarchived afterward", async () => {
    const bot = await add("Delete archived");
    const source = await claim(bot.id, "Configure a reminder");
    const wakeup = await reminder(source, "Archive then delete");
    await run((store) => store.finish(source, "completed", "Configured"));

    await gw.api.archiveBot({ botId: bot.id });
    expect(await query("SELECT cancelled FROM bot_wakeups WHERE id=$1::uuid", wakeup)).toEqual([{ cancelled: false }]);
    await gw.api.deleteBot({ botId: bot.id });
    expect(await query("SELECT cancelled FROM bot_wakeups WHERE id=$1::uuid", wakeup)).toEqual([{ cancelled: true }]);
    expect(await gw.api.unarchiveBot({ botId: bot.id }).catch(ConnectError.from)).toMatchObject({
      code: Code.NotFound,
    });
  });
});
