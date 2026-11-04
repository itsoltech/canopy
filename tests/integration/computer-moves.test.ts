import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { bots, computerLink as link, PermissionMode, Provider, ProviderProfileKind, ui } from "@canopy/contracts";
import { qualifyId } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { MoveCrash, type MoveHost } from "../../apps/gateway/src/computers/moves.ts";
import type { BotModel, ModelInput } from "../../apps/gateway/src/bots/types.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

const id = () => crypto.randomUUID();
const input = (i: ModelInput) => i.messages.findLast((m) => m.role === "user")?.text ?? "";

/**
 * Stage 8 of docs/linked-computers.md: moving threads and bots between three real gateways with their
 * own databases and keys (A: the old laptop, C: the new one, B: a third computer that mirrors both).
 */
describe.skipIf(!dockerAvailable)("moving things between linked computers", () => {
  let a: TestGateway;
  let b: TestGateway;
  let c: TestGateway;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  let lc: LinkedComputers;
  let aNode = "";
  let bNode = "";
  let cNode = "";
  let aProject = "";
  let aWorkspace = "";
  let cWorkspace = "";
  let bThread = "";
  const ports = new Map<TestGateway, number>();
  const hooks = new Map<TestGateway, MoveHost["hook"]>();
  let modelC: BotModel = async (i) => ({ text: `C: ${input(i)}`, calls: [] });

  const runtime = (gw: TestGateway) =>
    new LinkedComputers({
      store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
      host: "127.0.0.1",
      port: ports.get(gw) ?? 0,
      heartbeatMs: 150,
      serve: remoteServe(uiHandlers(gw.core), gw.core),
      core: gw.core,
      moveHook: (phase, move) => hooks.get(gw)?.(phase, move) ?? Promise.resolve(),
    });

  const linked = () =>
    eventually(
      async () =>
        la.reachable().includes(cNode) &&
        lc.reachable().includes(aNode) &&
        la.reachable().includes(bNode) &&
        lb.reachable().includes(cNode),
      Boolean,
      20000,
    );

  const closing = new Map<TestGateway, Promise<void>>();

  /** The gateway's link runtime stops (the process "dies" or the link drops); restart() brings it back. */
  const stop = (gw: TestGateway) => {
    const p = gw.core.computers!.close("updating");
    closing.set(gw, p);

    return p;
  };

  /** Restarts a gateway's link runtime on the same database and port (the core keeps running). */
  async function restart(gw: TestGateway) {
    const old = gw.core.computers!;
    await (closing.get(gw) ?? old.close("updating"));
    closing.delete(gw);
    const next = runtime(gw);
    gw.core.computers = next;
    await next.start();

    if (gw === a) la = next;
    else if (gw === b) lb = next;
    else lc = next;

    return next;
  }

  const sql = <A extends object>(gw: TestGateway, text: string, params: unknown[] = []) =>
    gw.core.computers!.store.query<A>(text, params);

  async function thread(gw: TestGateway, project: string, workspace: string, title: string, message: string) {
    const created = (
      await gw.api.createThread({
        projectId: project,
        workspaceId: workspace,
        title,
        provider: Provider.CODEX,
        permissionMode: PermissionMode.ASK,
        initialMessage: message,
        clientRequestId: id(),
      })
    ).thread!.id;

    await idle(gw, created);

    return created;
  }

  /** Every turn of the thread ended. */
  const idle = (gw: TestGateway, threadId: string) =>
    eventually(
      async () =>
        (
          await sql<{ n: number }>(
            gw,
            `SELECT count(*)::int AS n FROM turns WHERE thread_id=$1::uuid AND status IN ('queued','running')`,
            [threadId],
          )
        )[0]!.n +
        (
          await sql<{ n: number }>(
            gw,
            `SELECT count(*)::int AS n FROM threads WHERE id=$1::uuid AND status IN ('creating','running')`,
            [threadId],
          )
        )[0]!.n,
      (n) => n === 0,
      10000,
    );

  async function snapshot(gw: TestGateway, threadId: string) {
    const abort = new AbortController();

    try {
      for await (const u of gw.api.watchThread({ threadId }, { signal: abort.signal }))
        if (u.change.case === "snapshot") return u.change.value;
    } finally {
      abort.abort();
    }

    throw new Error("no snapshot");
  }

  const move = (
    items: { kind: string; id: string }[],
    placements = [{ projectId: aProject, workspaceId: qualifyId(cWorkspace, cNode) }],
  ) => a.api.startMove({ nodeId: cNode, items, placements });

  /** Done, or rolled back (aborting: the target has yet to hear it). */
  const settled = (moveId: string, gw = a) =>
    eventually(
      async () => (await gw.api.getMoves({})).moves.find((m) => m.id === moveId),
      (m) => ["done", "aborted", "aborting"].includes(m?.state ?? ""),
      20000,
    );

  const finalState = (moveId: string, gw = a) =>
    eventually(
      async () => (await gw.api.getMoves({})).moves.find((m) => m.id === moveId)?.state,
      (s) => s === "done" || s === "aborted",
      20000,
    );

  const homes = async (threadId: string) => ({
    a: (
      await sql<{ n: number }>(
        a,
        "SELECT count(*)::int AS n FROM threads WHERE id=$1::uuid AND deleted_at IS NULL AND moved_to IS NULL",
        [threadId],
      )
    )[0]!.n,
    c: (
      await sql<{ n: number }>(
        c,
        "SELECT count(*)::int AS n FROM threads WHERE id=$1::uuid AND deleted_at IS NULL AND moved_to IS NULL",
        [threadId],
      )
    )[0]!.n,
  });

  beforeAll(async () => {
    a = await startTestGateway({ botModel: async (i) => ({ text: `A: ${input(i)}`, calls: [] }) });
    b = await startTestGateway();
    c = await startTestGateway({ botModel: (i) => modelC(i) });
    la = runtime(a);
    lb = runtime(b);
    lc = runtime(c);
    a.core.computers = la;
    b.core.computers = lb;
    c.core.computers = lc;
    await la.start();
    await lb.start();
    await lc.start();

    for (const [gw, l] of [
      [a, la],
      [b, lb],
      [c, lc],
    ] as const)
      ports.set(gw, Number(new URL(l.addresses[0]!).port));
    aNode = la.hello().nodeId;
    bNode = lb.hello().nodeId;
    cNode = lc.hello().nodeId;

    for (const [gw, name] of [
      [a, "Laptop A"],
      [b, "Desktop B"],
      [c, "Laptop C"],
    ] as const)
      await gw.api.manageComputer({ action: "rename", name });

    const pair = async (host: TestGateway, guest: TestGateway, l: LinkedComputers) =>
      guest.api.linkComputer({ address: l.addresses[0]!, code: (await host.api.createComputerPairing({})).code });

    await pair(a, c, la);
    await pair(a, b, la);
    await pair(c, b, lc);
    expect(await linked()).toBe(true);

    for (const gw of [a, b, c]) {
      await gw.api.saveProviderInstance({
        harness: Provider.CODEX,
        id: "bot-fixture",
        label: "Fixture",
        create: true,
        kind: ProviderProfileKind.CLIPROXYAPI,
        baseUrl: "http://127.0.0.1:1",
        apiKey: "fixture",
        allWorkers: true,
      });
      await gw.api.setInstanceModels({
        harness: Provider.CODEX,
        id: "bot-fixture",
        models: { custom: ["gpt-6.1-sol"], hidden: [], favorites: [] },
      });
      gw.core.bots.start();
    }

    aProject = (await a.api.createProject({ name: "Repo on A" })).project!.id;
    aWorkspace = (
      await a.api.createWorkspace({ projectId: aProject, workerId: a.workerId, rootPath: "/repo", label: "A repo" })
    ).workspace!.id;
    const cProject = (await c.api.createProject({ name: "Repo on C" })).project!.id;
    cWorkspace = (
      await c.api.createWorkspace({ projectId: cProject, workerId: c.workerId, rootPath: "/repo/new", label: "C repo" })
    ).workspace!.id;
    const bProject = (await b.api.createProject({ name: "B" })).project!.id;

    const bWorkspace = (
      await b.api.createWorkspace({ projectId: bProject, workerId: b.workerId, rootPath: "/repo", label: "B repo" })
    ).workspace!.id;

    bThread = await thread(b, bProject, bWorkspace, "Caller on B", "hello from B");
  }, 120000);
  afterAll(async () => {
    for (const gw of [a, b, c]) await gw?.core.bots.stop();
    await Promise.allSettled([la?.close(), lb?.close(), lc?.close()]);
    await Promise.allSettled([a?.close(), b?.close(), c?.close()]);
  }, 30000);

  test("a thread moves with its history and files; the old home redirects and a third computer sees the new owner", async () => {
    const t = await thread(a, aProject, aWorkspace, "Feature work", "remember the cat called Mruczek");
    const upload = await a.api.uploadAttachment({ name: "notes.txt", data: new TextEncoder().encode("moved bytes") });
    await a.api.sendMessage({
      threadId: t,
      text: "see the notes",
      attachmentIds: [upload.attachment!.id],
      clientRequestId: id(),
    });
    await eventually(
      async () => a.worker.inputs.get(t) ?? [],
      (x) => x.length === 2,
    );
    await idle(a, t);

    const schedule = (
      await a.api.createSchedule({ threadId: t, prompt: "daily check", when: { case: "cron", value: "0 9 * * *" } })
    ).schedule!;

    expect(
      await eventually(
        async () => (await b.api.listThreads({})).threads.some((x) => x.id === qualifyId(t, aNode)),
        Boolean,
        10000,
      ),
    ).toBe(true);

    const preview = await a.api.previewMove({ nodeId: cNode, items: [{ kind: "thread", id: t }] });
    expect(preview.unavailable).toBe("");
    expect(preview.items[0]).toMatchObject({
      kind: "thread",
      id: t,
      title: "Feature work",
      blocked: "",
      projectId: aProject,
    });
    expect(preview.items[0]!.moves.join()).toContain("1 schedule");
    const started = await move([{ kind: "thread", id: t }]);
    expect((await settled(started.moves[0]!.id))?.state).toBe("done");

    const arrived = await eventually(
      async () => (await c.api.getMoves({})).moves.find((m) => m.itemId === t),
      (m) => m?.state === "done",
    );

    expect(`${arrived?.state} ${arrived?.error}`).toBe("done ");
    expect(await homes(t)).toEqual({ a: 0, c: 1 });

    // History, the move notice, the attachment and the schedule are on C; new turns continue after the old ones.
    const history = await snapshot(c, t);

    const texts = history.items.map((i) =>
      i.item?.content.case === "agentMessage" || i.item?.content.case === "userMessage"
        ? i.item.content.value.text
        : "",
    );

    expect(texts).toContain("Echo: remember the cat called Mruczek");
    expect(
      history.notices.some((n) => n.notice?.code === "moved" && n.notice.message === "Moved from Laptop A to Laptop C"),
    ).toBe(true);
    expect(history.turns.length).toBe(2);
    expect(new TextDecoder().decode((await c.api.getAttachment({ attachmentId: upload.attachment!.id })).data)).toBe(
      "moved bytes",
    );
    expect((await c.api.listSchedules({ threadId: t })).schedules.map((s) => s.id)).toContain(schedule.id);
    expect(
      (await sql<{ status: string }>(a, "SELECT status FROM schedules WHERE id=$1::uuid", [schedule.id]))[0]?.status,
    ).toBe("cancelled");
    // The agent continues on C's worker in the new workspace, with a handoff note instead of the old session.
    const created = c.worker.created.find((x) => x.threadId === t)!;
    expect(created.cwd).toBe("/repo/new");
    expect(created.instructions).toContain("moved from Laptop A to Laptop C");
    expect(created.instructions).toContain("remember the cat called Mruczek");
    await c.api.sendMessage({ threadId: t, text: "continue here", clientRequestId: id() });
    expect(
      await eventually(
        async () => c.worker.inputs.get(t) ?? [],
        (x) => x.includes("continue here"),
      ),
    ).toContain("continue here");
    const after = await snapshot(c, t);
    expect(after.turns.at(-1)!.ordinal).toBe(3);

    // A's old id resolves to C: reading and writing reach the new home.
    expect((await a.api.getThread({ threadId: t })).thread?.nodeId).toBe(cNode);
    await a.api.sendMessage({ threadId: t, text: "from the old laptop", clientRequestId: id() });
    expect(
      await eventually(
        async () => c.worker.inputs.get(t) ?? [],
        (x) => x.includes("from the old laptop"),
      ),
    ).toContain("from the old laptop");
    expect(a.worker.inputs.get(t)).not.toContain("from the old laptop");
    expect((await a.api.listThreads({})).threads.find((x) => splitPlain(x.id) === t)?.nodeId).toBe(cNode);
    // B: the mirror and list update the owner, and A's qualified id follows the redirect.
    expect(
      await eventually(
        async () => (await b.api.listThreads({})).threads.filter((x) => splitPlain(x.id) === t).map((x) => x.id),
        (ids) => ids.length === 1 && ids[0] === qualifyId(t, cNode),
        15000,
      ),
    ).toEqual([qualifyId(t, cNode)]);
    expect(
      await eventually(
        async () => lb.redirects.home(t)?.home_node_id,
        (h) => h === cNode,
      ),
    ).toBe(cNode);
    expect((await b.api.getThread({ threadId: qualifyId(t, aNode) })).thread?.nodeId).toBe(cNode);
    expect(
      await eventually(
        async () =>
          (
            await sql(b, "SELECT 1 FROM computer_mirror_threads WHERE origin_node_id=$1 AND thread_id=$2::uuid", [
              aNode,
              t,
            ])
          ).length,
        (n) => n === 0,
        15000,
      ),
    ).toBe(0);
    // Both sides audit the move.
    expect(
      (await sql(a, "SELECT 1 FROM audit_log WHERE action='computer.move.thread.sent' AND target_id=$1::uuid", [t]))
        .length,
    ).toBe(1);
    expect(
      (await sql(c, "SELECT 1 FROM audit_log WHERE action='computer.move.thread.received' AND target_id=$1::uuid", [t]))
        .length,
    ).toBe(1);

    // Agent bus references to the old id reach the new home, also when B learns the move lazily.
    await sql(b, "DELETE FROM computer_redirects");
    await lb.redirects.load();

    const sent = await b.worker.callTool({
      threadId: bThread,
      tool: "send_message",
      args: { thread_id: qualifyId(t, aNode), prompt: "agent hello" },
    });

    if (sent.isError) throw new Error(sent.content);
    expect(
      await eventually(
        async () => c.worker.inputs.get(t) ?? [],
        (x) => x.some((m) => m.includes("agent hello")),
      ),
    ).toBeTruthy();
    expect(lb.redirects.home(t)?.home_node_id).toBe(cNode);
  }, 60000);

  test("a bot moves with its conversation, routines and reminders: nothing fires twice or is lost; accounts are flagged", async () => {
    const bot = (
      await a.api.createBot({
        configuration: create(bots.BotConfigurationSchema, {
          name: "Helper",
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "bot-fixture",
          model: "gpt-6.1-sol",
          approvalPolicy: "safe",
        }),
        clientRequestId: id(),
      })
    ).bot!.id;

    await a.api.sendBotMessage({ botId: bot, text: "my favourite colour is teal", clientRequestId: id() });
    await eventually(
      () => a.core.bots.run((s) => s.conversation(a.userId, bot)),
      (x) => !x.working && x.messages.some((m) => m.text === "A: my favourite colour is teal"),
      10000,
    );
    const account = id();
    await sql(
      a,
      `INSERT INTO connector_accounts (id, owner_user_id, connector_type, name, namespace, url, transport, auth_kind, status) VALUES ($1::uuid,$2::uuid,'github','Work GitHub','gh','https://example.invalid/mcp','http','headers','connected')`,
      [account, a.userId],
    );
    await sql(a, "INSERT INTO connector_bot_grants (account_id, bot_id) VALUES ($1::uuid,$2::uuid)", [account, bot]);
    // A routine and a reminder that are due while the bot moves: exactly one home runs each, once.
    const routine = id();
    const reminder = id();
    await a.core.bots.stop();
    await sql(
      a,
      `INSERT INTO bot_routines (id, bot_id, title, instructions, cron, timezone, schedule_text, next_run_at, hops) VALUES ($1::uuid,$2::uuid,'Daily digest','Summarize','0 9 * * *','UTC','Every day at 9:00', now() - interval '1 minute', 1)`,
      [routine, bot],
    );
    const turn = (await sql<{ id: string }>(a, "SELECT id FROM bot_turns WHERE bot_id=$1::uuid LIMIT 1", [bot]))[0]!.id;
    await sql(
      a,
      "INSERT INTO bot_tool_calls (id, turn_id, call_key, tool, arguments, status) VALUES ($1::uuid,$2::uuid,'remind','{}','{}','completed')",
      [reminder, turn],
    );
    await sql(
      a,
      "INSERT INTO bot_wakeups (id, bot_id, prompt, run_at, hops) VALUES ($1::uuid,$2::uuid,'Water the plants',now() - interval '1 minute',1)",
      [reminder, bot],
    );

    const preview = await a.api.previewMove({ nodeId: cNode, items: [{ kind: "bot", id: bot }] });
    expect(preview.items[0]!.blocked).toBe("");
    expect(preview.items[0]!.redo).toContain("Connect Work GitHub (github) again");
    // While frozen, A's scheduler must not run anything for the bot.
    hooks.set(a, async (phase) => {
      if (phase === "prepared") {
        await a.core.bots.tick();
        await a.core.bots.tick();
      }
    });
    a.core.bots.start();
    const started = await move([{ kind: "bot", id: bot }]);
    expect((await settled(started.moves[0]!.id))?.state).toBe("done");
    hooks.delete(a);
    expect(
      await eventually(
        async () =>
          (
            await sql<{ n: number }>(c, "SELECT count(*)::int AS n FROM bot_turns WHERE routine_id=$1::uuid", [routine])
          )[0]!.n,
        (n) => n === 1,
        10000,
      ),
    ).toBe(1);
    expect(
      await eventually(
        async () =>
          (await sql<{ d: boolean }>(c, "SELECT delivered AS d FROM bot_wakeups WHERE id=$1::uuid", [reminder]))[0]?.d,
        Boolean,
        10000,
      ),
    ).toBe(true);
    await a.core.bots.tick();
    await Bun.sleep(300);
    expect(
      (await sql<{ n: number }>(a, "SELECT count(*)::int AS n FROM bot_turns WHERE routine_id=$1::uuid", [routine]))[0]!
        .n,
    ).toBe(0);
    expect(
      (await sql<{ d: boolean }>(a, "SELECT delivered AS d FROM bot_wakeups WHERE id=$1::uuid", [reminder]))[0]?.d,
    ).toBe(false);
    // The conversation continues on C; the account to connect again is shown there.
    const moved = (await c.api.getBot({ botId: bot })).bot!;
    expect(moved.movedFromName).toBe("Laptop A");
    expect(moved.reconnect).toEqual(["Work GitHub (github)"]);
    await c.api.sendBotMessage({ botId: bot, text: "still there?", clientRequestId: id() });

    const conversation = await eventually(
      () => c.core.bots.run((s) => s.conversation(c.userId, bot)),
      (x) => x.messages.some((m) => m.text === "C: still there?"),
      10000,
    );

    expect(conversation.messages.map((m) => m.text)).toContain("my favourite colour is teal");
    // Old ids resolve: A's plain id and B's qualified one reach C.
    expect((await a.api.getBot({ botId: bot })).bot?.nodeId).toBe(cNode);
    expect((await b.api.getBot({ botId: qualifyId(bot, aNode) })).bot?.nodeId).toBe(cNode);

    const sent = await b.worker.callTool({
      threadId: bThread,
      tool: "send_message",
      args: { thread_id: qualifyId(bot, aNode), target_kind: "bot", prompt: "bus to bot" },
    });

    if (sent.isError) throw new Error(sent.content);
    expect(
      await eventually(
        () => c.core.bots.run((s) => s.conversation(c.userId, bot)),
        (x) => x.messages.some((m) => m.text.includes("bus to bot")),
        10000,
      ),
    ).toBeTruthy();
  }, 60000);

  test("a thread with a running turn is refused, and stays fully usable on its home", async () => {
    const t = await thread(a, aProject, aWorkspace, "Busy", "first");
    a.worker.holdTurns = true;
    const sent = await a.api.sendMessage({ threadId: t, text: "long work", clientRequestId: id() });
    await eventually(
      () => a.api.getThread({ threadId: t }),
      (r) => r.thread?.status === "running",
      10000,
    );
    expect(
      (await a.api.previewMove({ nodeId: cNode, items: [{ kind: "thread", id: t }] })).items[0]!.blocked,
    ).toContain("running");
    const refused = await move([{ kind: "thread", id: t }]);
    expect(refused.moves[0]).toMatchObject({ state: "aborted" });
    expect(refused.moves[0]!.error).toContain("running");
    a.worker.finish(t, sent.turn!.id, "finished");
    a.worker.holdTurns = false;
    expect(await homes(t)).toEqual({ a: 1, c: 0 });
    await a.api.sendMessage({ threadId: t, text: "after", clientRequestId: id() });
    expect(
      await eventually(
        async () => a.worker.inputs.get(t) ?? [],
        (x) => x.includes("after"),
      ),
    ).toContain("after");
  }, 30000);

  test("interrupted before the decision: the link drops or either side restarts, and the move rolls back to one home", async () => {
    // The target goes away right after A froze the thread: nothing can be prepared, A rolls back at once.
    const dropped = await thread(a, aProject, aWorkspace, "Dropped", "one");
    hooks.set(a, async (phase) => {
      if (phase === "frozen") await stop(c);
    });
    const first = await move([{ kind: "thread", id: dropped }]);
    expect((await settled(first.moves[0]!.id))?.state).toBe("aborting");
    hooks.delete(a);
    expect(await homes(dropped)).toEqual({ a: 1, c: 0 });
    await restart(c);
    expect(await linked()).toBe(true);
    expect(await finalState(first.moves[0]!.id)).toBe("aborted");

    // The source restarts after the target staged the move: the restart rolls back and C drops what it staged.
    const crashed = await thread(a, aProject, aWorkspace, "Source restart", "two");
    const prepared = Promise.withResolvers<void>();
    hooks.set(a, async (phase) => {
      if (phase === "prepared") {
        prepared.resolve();
        throw new MoveCrash();
      }
    });
    const second = await move([{ kind: "thread", id: crashed }]);
    const moveId = second.moves[0]!.id;
    expect(
      await eventually(
        async () => (await c.api.getMoves({})).moves.find((m) => m.id === moveId)?.state,
        (s) => s === "prepared",
      ),
    ).toBe("prepared");
    // Target persistence precedes the source receiving its reply. Crash the source before stopping it,
    // and keep the hook until it has stopped so a heartbeat cannot retry and commit the move.
    await prepared.promise;
    await stop(a);
    hooks.delete(a);
    await restart(a);
    expect(await linked()).toBe(true);
    expect(await finalState(moveId)).toBe("aborted");
    expect(
      await eventually(
        async () => (await c.api.getMoves({})).moves.find((m) => m.id === moveId)?.state,
        (s) => s === "aborted",
        15000,
      ),
    ).toBe("aborted");
    expect(await homes(crashed)).toEqual({ a: 1, c: 0 });
    expect(
      (await sql(c, "SELECT payload FROM computer_moves WHERE id=$1::uuid AND payload IS NOT NULL", [moveId])).length,
    ).toBe(0);
    await a.api.sendMessage({ threadId: crashed, text: "still mine", clientRequestId: id() });
    expect(
      await eventually(
        async () => a.worker.inputs.get(crashed) ?? [],
        (x) => x.includes("still mine"),
      ),
    ).toContain("still mine");

    // The target restarts while staging (before it answered): A rolls back, the stale staged copy is dropped on reconnect.
    const staged = await thread(a, aProject, aWorkspace, "Target restart", "three");
    hooks.set(c, async (phase) => {
      if (phase === "staged") {
        void stop(c);
        throw new MoveCrash();
      }
    });
    const third = await move([{ kind: "thread", id: staged }]);
    expect(["aborting", "aborted"]).toContain((await settled(third.moves[0]!.id))!.state);
    hooks.delete(c);
    await restart(c);
    expect(await linked()).toBe(true);
    expect(await finalState(third.moves[0]!.id)).toBe("aborted");
    expect(
      await eventually(
        async () =>
          (
            await sql<{ state: string }>(c, "SELECT state FROM computer_moves WHERE id=$1::uuid", [third.moves[0]!.id])
          )[0]?.state,
        (s) => s === "aborted",
        15000,
      ),
    ).toBe("aborted");
    expect(await homes(staged)).toEqual({ a: 1, c: 0 });
  }, 90000);

  test("interrupted after the decision: the move rolls forward through restarts and link drops, idempotently", async () => {
    // The source restarts right after its commit: the restart tells C, which applies it.
    const t1 = await thread(a, aProject, aWorkspace, "After commit", "four");
    hooks.set(a, async (phase) => {
      if (phase === "committed") throw new MoveCrash();
    });
    const first = await move([{ kind: "thread", id: t1 }]);
    const id1 = first.moves[0]!.id;
    expect(
      await eventually(
        async () =>
          (await sql<{ state: string }>(a, "SELECT state FROM computer_moves WHERE id=$1::uuid", [id1]))[0]?.state,
        (s) => s === "committed",
      ),
    ).toBe("committed");
    hooks.delete(a);
    expect(await homes(t1)).toEqual({ a: 0, c: 0 });
    await restart(a);
    expect(await finalState(id1)).toBe("done");
    expect(
      await eventually(
        () => homes(t1),
        (h) => h.c === 1,
        15000,
      ),
    ).toEqual({ a: 0, c: 1 });

    // The target restarts after recording the decision but before applying it; the link is gone meanwhile.
    const t2 = await thread(a, aProject, aWorkspace, "Target crash", "five");
    hooks.set(c, async (phase) => {
      if (phase === "decided") {
        void stop(c);
        throw new MoveCrash();
      }
    });
    const second = await move([{ kind: "thread", id: t2 }]);
    const id2 = second.moves[0]!.id;
    expect(
      await eventually(
        async () =>
          (await sql<{ state: string }>(c, "SELECT state FROM computer_moves WHERE id=$1::uuid", [id2]))[0]?.state,
        (s) => s === "committed",
      ),
    ).toBe("committed");
    hooks.delete(c);
    expect(
      (await sql<{ state: string }>(a, "SELECT state FROM computer_moves WHERE id=$1::uuid", [id2]))[0]?.state,
    ).toBe("committed");
    await restart(c);
    expect(await linked()).toBe(true);
    expect(
      await eventually(
        () => homes(t2),
        (h) => h.c === 1,
        15000,
      ),
    ).toEqual({ a: 0, c: 1 });
    expect(await finalState(id2)).toBe("done");

    // Repeating every message changes nothing: one thread, one history, one decision.
    const row = (await sql<{ payload: Uint8Array }>(a, "SELECT 1 FROM computer_moves WHERE id=$1::uuid", [id2])).length;
    expect(row).toBe(1);
    const decide = link.ComputerMoveService.method.decideMove;
    expect(
      await lc.moves!.serve(aNode, decide, create(link.MoveDecisionSchema, { moveId: id2, decision: "commit" })),
    ).toMatchObject({ state: "done" });

    const prepare = await lc.moves!.serve(
      aNode,
      link.ComputerMoveService.method.prepareMove,
      create(link.MovePrepareSchema, { moveId: id2, kind: "thread", itemId: t2 }),
    );

    expect(prepare).toMatchObject({ state: "prepared" });
    expect((await sql<{ n: number }>(c, "SELECT count(*)::int AS n FROM threads WHERE id=$1::uuid", [t2]))[0]!.n).toBe(
      1,
    );
    expect(
      (
        await sql<{ n: number }>(c, "SELECT count(*)::int AS n FROM computer_moved_threads WHERE thread_id=$1::uuid", [
          t2,
        ])
      )[0]!.n,
    ).toBe(1);
    // A different computer cannot decide C's move.
    expect(
      await lc.moves!.serve(bNode, decide, create(link.MoveDecisionSchema, { moveId: id2, decision: "abort" })),
    ).toMatchObject({ state: "aborted" });
    expect(await homes(t2)).toEqual({ a: 0, c: 1 });
  }, 90000);

  test("only the owner's own things move, and nothing moves through a relay or to an unknown computer", async () => {
    const other = (
      await sql<{ id: string }>(
        a,
        "INSERT INTO users (id, email, display_name, role) VALUES ($1::uuid,'other@localhost','Other','admin') RETURNING id",
        [id()],
      )
    )[0]!.id;

    const foreign = id();
    await sql(
      a,
      `INSERT INTO bots (id, owner_user_id, client_request_id, configuration, provider, provider_instance) VALUES ($1::uuid,$2::uuid,'x','{"name":"Theirs"}','codex','bot-fixture')`,
      [foreign, other],
    );
    expect((await a.api.previewMove({ nodeId: cNode, items: [{ kind: "bot", id: foreign }] })).items[0]!.blocked).toBe(
      "Bot not found",
    );
    const refused = await move([{ kind: "bot", id: foreign }]);
    expect(refused.moves[0]).toMatchObject({ state: "aborted", error: "Bot not found" });
    expect((await sql(c, "SELECT 1 FROM bots WHERE id=$1::uuid", [foreign])).length).toBe(0);
    expect(await failure(a.api.startMove({ nodeId: "f".repeat(64), items: [{ kind: "bot", id: foreign }] }))).toContain(
      "directly linked",
    );
    expect(
      await failure(a.api.startMove({ nodeId: cNode, items: [{ kind: "thread", id: qualifyId(bThread, bNode) }] })),
    ).toContain("its own computer");
  }, 20000);

  test("move everything: every thread and bot goes to the new laptop; shared and local-only configuration are listed", async () => {
    const t = await thread(a, aProject, aWorkspace, "Last one", "six");

    const bot = (
      await a.api.createBot({
        configuration: create(bots.BotConfigurationSchema, {
          name: "Last bot",
          shape: "round",
          color: "#22aaff",
          provider: Provider.CODEX,
          providerInstance: "bot-fixture",
          model: "gpt-6.1-sol",
          approvalPolicy: "safe",
        }),
        clientRequestId: id(),
      })
    ).bot!.id;

    const preview = await a.api.previewMove({ nodeId: cNode, everything: true });
    expect(preview.items.map((i) => i.id)).toEqual(expect.arrayContaining([t, bot]));
    expect(preview.localOnly.join("\n")).toContain("Connector account Work GitHub (github)");
    expect(preview.localOnly.join("\n")).toContain("Workers, workspaces");

    const started = await a.api.startMove({
      nodeId: cNode,
      everything: true,
      placements: [{ projectId: aProject, workspaceId: qualifyId(cWorkspace, cNode) }],
    });

    const batch = started.moves[0]!.batchId;
    expect(batch).not.toBe("");

    const all = await eventually(
      async () => (await a.api.getMoves({ batchId: batch })).moves,
      (m) => m.every((x) => ["done", "aborted"].includes(x.state)),
      40000,
    );

    expect(all.filter((m) => m.state !== "done").map((m) => `${m.title}: ${m.error}`)).toEqual([]);
    expect(
      (await sql(a, "SELECT 1 FROM threads WHERE owner_user_id=$1::uuid AND deleted_at IS NULL", [a.userId])).length,
    ).toBe(0);
    expect(
      (await sql(a, "SELECT 1 FROM bots WHERE owner_user_id=$1::uuid AND deleted_at IS NULL", [a.userId])).length,
    ).toBe(0);
    expect(
      await eventually(
        async () => (await c.api.getMoves({})).moves.filter((m) => m.batchId === batch && m.state !== "done").length,
        (n) => n === 0,
        20000,
      ),
    ).toBe(0);
    expect(await homes(t)).toEqual({ a: 0, c: 1 });
    expect((await c.api.getBot({ botId: bot })).bot?.configuration?.name).toBe("Last bot");
    // A's lists now show everything as C's.
    expect((await a.api.listBots({})).bots.find((x) => splitPlain(x.id) === bot)?.nodeId).toBe(cNode);
  }, 90000);
});

const splitPlain = (value: string) => value.split("~")[0]!;

void ui;
