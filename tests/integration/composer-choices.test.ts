import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { PermissionMode, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { composerChoices } from "@canopy/domain/composer-choices";
import { GatewayCore } from "@canopy/gateway/core";
import { GatewayStore } from "@canopy/gateway/store";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("durable composer choices", () => {
  let gw: TestGateway;
  let projectId: string;
  let workspaceId: string;

  beforeAll(async () => {
    gw = await startTestGateway();
    projectId = (await gw.api.createProject({ name: "Composer choices" })).project!.id;
    workspaceId = (await gw.api.createWorkspace({ projectId, workerId: gw.workerId, rootPath: "/repo/composer" }))
      .workspace!.id;
  }, 60_000);

  afterAll(async () => gw?.close());

  const createThread = async (title: string) =>
    (
      await gw.api.createThread({
        projectId,
        workspaceId,
        title,
        provider: Provider.CODEX,
        model: "gpt-5.5",
        effort: "low",
        permissionMode: PermissionMode.ASK,
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!;

  async function snapshot(core: GatewayCore, threadId: string, pageSize = 1) {
    const controller = new AbortController();

    try {
      for await (const update of core.watchThread(threadId, controller.signal, "", false, {
        pageSize,
        beforeTurnId: "",
        targetItemId: "",
        historyVersion: "",
        fromTurnId: "",
      })) {
        if (update.change.case === "snapshot") return update.change.value;
      }

      throw new Error("No thread snapshot");
    } finally {
      controller.abort();
    }
  }

  test("last user choices survive a fresh gateway and a history window of newer provider turns", async () => {
    const thread = await createThread("Remember my turn");
    expect(thread.lastUserTurnChoices).toBeUndefined();

    const sent = await gw.api.sendMessage({
      threadId: thread.id,
      text: "Use these choices again",
      model: "gpt-6.1-sol",
      effort: "high",
      permissionMode: PermissionMode.READ_ONLY,
      clientRequestId: crypto.randomUUID(),
    });

    await eventually(
      () => snapshot(gw.core, thread.id),
      (s) => s.turns.some((t) => t.id === sent.turn!.id && t.status === "completed"),
    );
    // A long provider continuation fills the history page without replacing the user's choices.
    await gw.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO turns(id,thread_id,ordinal,trigger,status,input,model,effort,permission_mode,last_seq)
          SELECT gen_random_uuid(),${thread.id}::uuid,n,'provider','completed','{}'::jsonb,
            'gpt-5.5','low','FULL_AUTO',last_seq FROM threads
            CROSS JOIN generate_series(2,2048) n WHERE id=${thread.id}::uuid`;
      }),
    );
    const fresh = new GatewayCore({ runtime: gw.runtime, instanceId: "composer-restart", userId: gw.userId });
    const view = await snapshot(fresh, thread.id);
    expect(view.turns.map((t) => t.trigger)).toEqual(["provider"]);
    expect(view.historyHasMore).toBe(true);

    const expected = {
      turnId: sent.turn!.id,
      model: "gpt-6.1-sol",
      effort: "high",
      permissionMode: PermissionMode.READ_ONLY,
    };

    expect(view.thread?.lastUserTurnChoices).toMatchObject(expected);
    expect((await gw.api.getThread({ threadId: thread.id })).thread?.lastUserTurnChoices).toBeUndefined();
    expect(
      (await gw.api.listThreads({ projectId })).threads.find((t) => t.id === thread.id)?.lastUserTurnChoices,
    ).toBeUndefined();
    // Thread defaults and a second thread keep their own settings.
    expect([view.thread?.model, view.thread?.effort, view.thread?.permissionMode]).toEqual([
      "gpt-5.5",
      "low",
      PermissionMode.ASK,
    ]);
    expect((await createThread("Separate choices")).lastUserTurnChoices).toBeUndefined();

    const other = await gw.runtime.runPromise(GatewayStore.use((s) => s.ensureUser("composer-other@test", "Other")));
    const stranger = new GatewayCore({ runtime: gw.runtime, instanceId: "composer-stranger", userId: other });
    expect(await failure(stranger.getThread(thread.id))).toContain("thread not found");
    expect(await failure(snapshot(stranger, thread.id))).toContain("thread not found");
    expect(await stranger.listThreads("")).toEqual([]);
    expect(
      await gw.runtime.runPromise(GatewayStore.use((s) => s.composerTurnChoices(thread.id, other))),
    ).toBeUndefined();
  });

  test("an open watch refreshes choices on turn and title changes while overview metadata omits them", async () => {
    const thread = await createThread("Live choices");
    const controller = new AbortController();
    const updates = gw.core.watchThread(thread.id, controller.signal);
    const overview = gw.core.watchOverview(controller.signal, true);

    try {
      await updates.next();
      await overview.next();

      const sent = await gw.api.sendMessage({
        threadId: thread.id,
        text: "Remember the live pick",
        effort: "high",
        permissionMode: PermissionMode.READ_ONLY,
        clientRequestId: crypto.randomUUID(),
      });

      let sawTurn = false;

      while (!sawTurn) {
        const update = (await updates.next()).value;

        if (update?.change.case !== "thread") continue;
        expect(update.change.value.lastUserTurnChoices).toMatchObject({
          turnId: sent.turn!.id,
          effort: "high",
          permissionMode: PermissionMode.READ_ONLY,
        });
        sawTurn = true;
      }

      await gw.api.updateThread({ threadId: thread.id, title: "Renamed with choices" });
      let sawTitle = false;

      while (!sawTitle) {
        const update = (await updates.next()).value;

        if (update?.change.case !== "thread" || update.change.value.title !== "Renamed with choices") continue;
        expect(update.change.value.lastUserTurnChoices?.turnId).toBe(sent.turn!.id);
        sawTitle = true;
      }

      let sawOverview = false;

      while (!sawOverview) {
        const update = (await overview.next()).value;

        if (update?.change.case !== "thread" || update.change.value.id !== thread.id) continue;
        expect(update.change.value.lastUserTurnChoices).toBeUndefined();
        sawOverview = true;
      }
    } finally {
      controller.abort();
      await updates.return(undefined);
      await overview.return(undefined);
    }
  });

  test("queue choices resolve defaults, withdrawn messages and shell commands do not replace them", async () => {
    gw.worker.holdTurns = true;
    const thread = await createThread("Queued picks");

    const first = await gw.api.sendMessage({
      threadId: thread.id,
      text: "Running",
      effort: "high",
      clientRequestId: crypto.randomUUID(),
    });

    await eventually(
      () => snapshot(gw.core, thread.id),
      (s) => s.turns.some((t) => t.status === "running"),
    );

    const queued = await gw.api.sendMessage({
      threadId: thread.id,
      text: "Queued",
      model: "gpt-6.1-sol",
      permissionMode: PermissionMode.READ_ONLY,
      clientRequestId: crypto.randomUUID(),
    });

    expect((await snapshot(gw.core, thread.id)).thread?.lastUserTurnChoices).toMatchObject({
      turnId: queued.turn!.id,
      model: "gpt-6.1-sol",
      effort: "low",
      permissionMode: PermissionMode.READ_ONLY,
    });
    await gw.api.deleteQueuedTurn({ turnId: queued.turn!.id });
    await gw.api.sendMessage({ threadId: thread.id, text: "!pwd", clientRequestId: crypto.randomUUID() });
    expect((await snapshot(gw.core, thread.id)).thread?.lastUserTurnChoices?.turnId).toBe(first.turn!.id);
    gw.worker.holdTurns = false;
    gw.worker.finish(thread.id, first.turn!.id);
  });

  test("both clients resolve available choices with explicit picks before the last turn and thread defaults", async () => {
    const thread = await createThread("Available choices");
    const models = (await gw.api.listModels({})).workers[0]!.profiles[0]!.models;
    const options = models.map((m) => ({ ...m, model: m.id }));
    expect(composerChoices(thread, options)).toMatchObject({ option: { model: "gpt-5.5" }, effort: "low" });

    const saved = create(ui.ThreadSchema, {
      ...thread,
      lastUserTurnChoices: create(ui.ComposerTurnChoicesSchema, {
        model: "gpt-6.1-sol",
        effort: "xhigh",
        permissionMode: PermissionMode.READ_ONLY,
      }),
    });

    expect(composerChoices(saved, options)).toMatchObject({
      option: { model: "gpt-6.1-sol" },
      effort: "xhigh",
      permissionMode: PermissionMode.READ_ONLY,
    });
    expect(
      composerChoices(saved, options, { model: "gpt-5.5", effort: "medium", permissionMode: PermissionMode.ASK }),
    ).toMatchObject({ option: { model: "gpt-5.5" }, effort: "medium", permissionMode: PermissionMode.ASK });
    expect(composerChoices(saved, options, { model: "gpt-5.5" }).effort).toBe("medium");
    expect(
      composerChoices(
        saved,
        options.filter((m) => m.model !== "gpt-6.1-sol"),
      ),
    ).toMatchObject({ option: { model: "gpt-5.5" }, effort: "medium" });
    expect(composerChoices(saved, [{ ...options[0]!, efforts: [], defaultEffort: "" }]).effort).toBe("");
    expect(composerChoices(saved, [])).toMatchObject({ option: undefined, effort: "" });
  });
});
