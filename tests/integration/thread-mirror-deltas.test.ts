import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create, toBinary, toJson } from "@bufbuild/protobuf";
import { CommandSchema, ItemSchema, ItemStatus, Provider, computerLink as link, ui } from "@canopy/contracts";
import { qualifyId, REMOTE_THREADS, THREAD_MIRROR } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { applyThreadUpdate } from "@canopy/domain/thread-snapshot";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, failure, startTestGateway, watchUntil, type TestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("incremental mirrors over two real gateway links", () => {
  let a: TestGateway;
  let b: TestGateway;
  let sa: ComputerStore;
  let sb: ComputerStore;
  let la: ReturnType<typeof linkedComputers>;
  let lb: ReturnType<typeof linkedComputers>;
  let thread: string;
  let node: string;
  const opens: ui.ThreadUpdate[] = [];
  const frames: link.MirrorUpdate[] = [];

  const caughtUp = async () => {
    expect(
      await eventually(
        async () => {
          const clock = (
            await sb.query<{ cursor: string }>(
              "SELECT epoch::text || ':' || revision::text AS cursor FROM computer_thread_clock WHERE owner_user_id=$1::uuid",
              [b.userId],
            )
          )[0];

          return clock?.cursor === (await la.mirror.state(node))?.cursor;
        },
        Boolean,
        20_000,
      ),
    ).toBe(true);
  };

  const open = () => watchUntil(a.api, qualifyId(thread, node), (updates) => updates.some((u) => !u.syncing));

  const connect = async () => {
    await lb.start();
    expect(await eventually(() => Promise.resolve(la.reachable().includes(node)), Boolean, 15_000)).toBe(true);
    await caughtUp();
  };

  const home = (capabilities?: string[]) =>
    linkedComputers({
      store: sb,
      host: "127.0.0.1",
      heartbeatMs: 100,
      serve: remoteServe(uiHandlers(b.core)),
      ...(capabilities && { capabilities }),
    });

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    sa = new ComputerStore(a.runtime, a.userId, a.secretsKey);
    sb = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    const project = (await b.api.createProject({ name: "Delta history" })).project!.id;

    const workspace = (
      await b.api.createWorkspace({ projectId: project, workerId: b.workerId, rootPath: "/repo/delta" })
    ).workspace!.id;

    thread = (
      await b.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Long history",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    const item = create(ItemSchema, {
      status: ItemStatus.COMPLETED,
      content: {
        case: "commandExecution",
        value: {
          command: "bun test",
          output: "tool output\n".repeat(200),
          exitCode: 0,
        },
      },
    });

    await sb.query(
      `INSERT INTO thread_items(thread_id,item_id,type,status,content,first_seq,last_seq)
      SELECT $1::uuid,'item-' || n,'commandExecution','completed',
      $2::jsonb || jsonb_build_object('itemId','item-' || n),n,n FROM generate_series(1,3000) n`,
      [thread, JSON.stringify(toJson(ItemSchema, item))],
    );
    await sb.query("UPDATE threads SET last_seq=3000 WHERE id=$1::uuid", [thread]);
    const watch = b.core.watchThread.bind(b.core);
    b.core.watchThread = async function* (id, signal, cursor, includeCursor) {
      let first = true;

      for await (const update of watch(id, signal, cursor, includeCursor)) {
        if (id === thread && first) opens.push(update);
        first = false;
        yield update;
      }
    };

    la = linkedComputers({ store: sa, host: "127.0.0.1", heartbeatMs: 100, serve: remoteServe(uiHandlers(a.core)) });
    lb = home();
    const publish = lb.mirror.publish.bind(lb.mirror);
    lb.mirror.publish = async function* (...args) {
      for await (const frame of publish(...args)) {
        frames.push(frame);
        yield frame;
      }
    };

    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await la.start();
    await lb.start();
    node = lb.hello().nodeId;
    await lb.pair(la.addresses[0]!, (await la.createPairing()).code);
    await caughtUp();
  }, 90_000);

  afterAll(async () => {
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 20_000);

  test("a caught-up open transfers no historical items and retains the complete mirror", async () => {
    opens.length = 0;
    const updates = await open();
    expect(updates[0]?.syncing).toBe(true);
    expect(updates[0]?.change.case === "snapshot" && updates[0].change.value.items.length).toBe(3000);
    expect(updates.at(-1)?.syncing).toBe(false);
    const delta = opens.find((u) => u.change.case === "delta")!;
    expect(delta.change.case === "delta" && delta.change.value.snapshot?.items.length).toBe(0);
    expect(toBinary(ui.ThreadUpdateSchema, delta).length).toBeLessThan(4000);
    expect(updates.at(-1)?.change.case === "snapshot" && updates.at(-1)!.change.value?.$typeName).toBe(
      ui.ThreadSnapshotSchema.typeName,
    );
  });

  test("a UI checkpoint resumes at the remote home without retransmitting the gateway mirror", async () => {
    const threadId = qualifyId(thread, node);
    const cold = new AbortController();
    let snapshot: ui.ThreadSnapshot | undefined;

    try {
      for await (const update of a.api.watchThread({ threadId, incremental: true }, { signal: cold.signal })) {
        snapshot = applyThreadUpdate(snapshot, update);

        if (!update.syncing) break;
      }
    } finally {
      cold.abort();
    }

    expect(snapshot?.cursor).not.toBe("");
    expect(snapshot?.items).toHaveLength(3000);
    const warm = new AbortController();

    try {
      for await (const update of a.api.watchThread(
        { threadId, incremental: true, cursor: snapshot!.cursor },
        { signal: warm.signal },
      )) {
        expect(update.change.case).toBe("delta");
        expect(toBinary(ui.ThreadUpdateSchema, update).length).toBeLessThan(4000);
        expect(applyThreadUpdate(snapshot, update).items).toHaveLength(3000);
        break;
      }
    } finally {
      warm.abort();
    }
  });

  test("the cursor handoff continues into native live events without another snapshot", async () => {
    const placement = (await b.api.getThread({ threadId: thread })).thread!;

    const liveThread = (
      await b.api.createThread({
        projectId: placement.projectId,
        workspaceId: placement.workspaceId,
        provider: Provider.CODEX,
        title: "Native live handoff",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;

    await caughtUp();
    const abort = new AbortController();

    const stream = a.api
      .watchThread(
        { threadId: qualifyId(liveThread, node) },
        {
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        },
      )
      [Symbol.asyncIterator]();

    try {
      expect((await stream.next()).value?.syncing).toBe(true);
      expect((await stream.next()).value?.syncing).toBe(false);
      await b.api.sendMessage({ threadId: liveThread, text: "new live turn", clientRequestId: crypto.randomUUID() });
      const updates: ui.ThreadUpdate[] = [];

      for (;;) {
        const next = await stream.next();

        if (!next.value) throw new Error("Live stream ended before the turn finished");
        updates.push(next.value);

        if (next.value.change.case === "turn" && next.value.change.value.status === "completed") break;
      }

      expect(updates.some((u) => u.change.case === "event")).toBe(true);
      expect(updates.some((u) => u.change.case === "snapshot" || u.change.case === "delta")).toBe(false);
    } finally {
      abort.abort();
      await stream.return?.();
    }

    await caughtUp();

    const reply = (await la.mirror.snapshot(node, liveThread))!.items.find(
      (item) => item.item?.content.case === "agentMessage",
    );

    expect(reply?.completedAt).toBeDefined();
    expect(frames.some((frame) => frame.delta?.snapshot?.items.some((item) => item.completedAt))).toBe(true);
  }, 20_000);

  test("active publishing sends edits and tombstones instead of resending old output", async () => {
    frames.length = 0;
    await sb.query(
      "UPDATE thread_items SET content=jsonb_set(content,'{commandExecution,output}','\"changed output\"') WHERE thread_id=$1::uuid AND item_id='item-3000'",
      [thread],
    );
    await sb.query("DELETE FROM thread_items WHERE thread_id=$1::uuid AND item_id='item-2999'", [thread]);
    await caughtUp();
    const mirror = (await la.mirror.snapshot(node, thread))!;
    expect(mirror.items.length).toBe(2999);
    expect(mirror.items.some((i) => i.item?.itemId === "item-2999")).toBe(false);
    const changed = mirror.items.find((i) => i.item?.itemId === "item-3000")!.item!;
    expect(changed.content.case === "commandExecution" && changed.content.value.output).toBe("changed output");
    expect(frames.some((f) => f.deltaStart)).toBe(true);
    expect(frames.some((f) => f.snapshotStart)).toBe(false);
    expect(frames.reduce((n, f) => n + toBinary(link.MirrorUpdateSchema, f).length, 0)).toBeLessThan(10_000);
  });

  test("stale open and reconnect recover changes without replacing the mirror generation", async () => {
    await lb.close();
    const state = (await la.mirror.state(node))!;
    await sb.query("UPDATE threads SET title='After reconnect' WHERE id=$1::uuid", [thread]);
    await sb.query(
      "UPDATE thread_items SET content=jsonb_set(content,'{commandExecution,output}','\"offline edit\"') WHERE thread_id=$1::uuid AND item_id='item-1'",
      [thread],
    );
    lb = home();
    b.core.computers = lb;
    b.core.network = lb.options.network;
    const publish = lb.mirror.publish.bind(lb.mirror);
    const resume = Promise.withResolvers<void>();
    lb.mirror.publish = async function* (...args) {
      await resume.promise;
      yield* publish(...args);
    };

    opens.length = 0;

    try {
      await lb.start();
      expect(await eventually(() => Promise.resolve(la.reachable().includes(node)), Boolean, 15_000)).toBe(true);
      const updates = await open();
      const live = updates.at(-1)!.change;
      expect(live.case === "snapshot" && live.value.thread?.title).toBe("After reconnect");
      expect(
        live.case === "snapshot" && live.value.items.find((i) => i.item?.itemId === "item-1")?.item?.content,
      ).toMatchObject({ case: "commandExecution", value: { output: "offline edit" } });
      expect(opens.find((u) => u.change.case === "delta")?.change).toMatchObject({
        case: "delta",
        value: { snapshot: { items: [{ item: { itemId: "item-1" } }] } },
      });
    } finally {
      resume.resolve();
    }

    await caughtUp();
    expect((await la.mirror.state(node))!.generation).toBe(state.generation);
  }, 30_000);

  test("a stale open replaces queue, interactions and goal metadata, then removes deleted turns", async () => {
    await lb.close();
    const turn = crypto.randomUUID();
    const interaction = crypto.randomUUID();
    const goal = crypto.randomUUID();
    await sb.query("UPDATE threads SET status='running' WHERE id=$1::uuid", [thread]);
    await sb.query(
      `INSERT INTO turns(id,thread_id,ordinal,status,trigger,author_user_id,input)
      VALUES($1::uuid,$2::uuid,1,'queued','user',$3::uuid,'{"text":"queued while disconnected"}')`,
      [turn, thread, b.userId],
    );
    await sb.query(
      `INSERT INTO interaction_requests(id,thread_id,kind,request,routed_to)
      VALUES($1::uuid,$2::uuid,'permission','{}','human')`,
      [interaction, thread],
    );
    await sb.query(
      `INSERT INTO goals(id,thread_id,objective,status,created_by,created_by_user_id)
      VALUES($1::uuid,$2::uuid,'Keep metadata current','paused','user',$3::uuid)`,
      [goal, thread, b.userId],
    );
    lb = home();
    b.core.computers = lb;
    b.core.network = lb.options.network;
    const publish = lb.mirror.publish.bind(lb.mirror);
    const resume = Promise.withResolvers<void>();
    lb.mirror.publish = async function* (...args) {
      await resume.promise;
      yield* publish(...args);
    };

    opens.length = 0;

    try {
      await lb.start();
      expect(await eventually(() => Promise.resolve(la.reachable().includes(node)), Boolean, 15_000)).toBe(true);
      const live = (await open()).at(-1)!.change;
      expect(live).toMatchObject({
        case: "snapshot",
        value: {
          turns: [{ id: qualifyId(turn, node), status: "queued", inputText: "queued while disconnected" }],
          interactions: [{ requestId: qualifyId(interaction, node), status: "pending" }],
          goal: { id: qualifyId(goal, node), objective: "Keep metadata current", status: "paused" },
        },
      });
      const delta = opens.find((u) => u.change.case === "delta")!;
      expect(delta.change.case === "delta" && delta.change.value.snapshot?.items.length).toBe(0);
      expect(toBinary(ui.ThreadUpdateSchema, delta).length).toBeLessThan(6000);
    } finally {
      resume.resolve();
    }

    await caughtUp();
    const command = crypto.randomUUID();
    await sb.query(
      `INSERT INTO worker_commands(id,worker_id,thread_id,turn_id,kind,payload,expires_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'startTurn',$5,now()+interval '1 hour')`,
      [
        command,
        b.workerId,
        thread,
        turn,
        toBinary(
          CommandSchema,
          create(CommandSchema, {
            commandId: command,
            kind: { case: "startTurn", value: { thread: { threadId: thread }, turnId: turn } },
          }),
        ),
      ],
    );
    await caughtUp();
    expect((await la.mirror.snapshot(node, thread))!.turns[0]?.dispatched).toBe(true);
    await sb.query("UPDATE worker_commands SET status='failed' WHERE id=$1::uuid", [command]);
    await caughtUp();
    expect((await la.mirror.snapshot(node, thread))!.turns[0]?.dispatched).toBe(false);
    await sb.query("DELETE FROM worker_commands WHERE id=$1::uuid", [command]);

    // Source details can change without touching the turn: fall back instead of keeping a stale join.
    await sb.query(
      "UPDATE turns SET trigger='interaction',author_user_id=NULL,interaction_request_id=$2::uuid WHERE id=$1::uuid",
      [turn, interaction],
    );
    await caughtUp();
    await sb.query("UPDATE interaction_requests SET tool_name='write_file' WHERE id=$1::uuid", [interaction]);
    await caughtUp();
    opens.length = 0;
    const sourced = (await open()).at(-1)!.change;
    expect(sourced.case === "snapshot" && sourced.value.turns[0]?.questionTool).toBe("write_file");
    expect(opens.some((u) => u.change.case === "snapshot" && u.change.value.items.length === 2999)).toBe(true);
    await sb.query("DELETE FROM turns WHERE id=$1::uuid", [turn]);
    await sb.query("DELETE FROM interaction_requests WHERE id=$1::uuid", [interaction]);
    await sb.query("DELETE FROM goals WHERE id=$1::uuid", [goal]);
    await sb.query("UPDATE threads SET status='idle' WHERE id=$1::uuid", [thread]);
    await caughtUp();
    const mirror = (await la.mirror.snapshot(node, thread))!;
    expect(mirror.turns).toEqual([]);
    expect(mirror.interactions).toEqual([]);
    expect(mirror.goal).toBeUndefined();
  }, 30_000);

  test("a restarted partner keeps its base and receives deltas on the resumed link", async () => {
    const state = (await la.mirror.state(node))!;
    await la.close();
    la = linkedComputers({ store: sa, host: "127.0.0.1", heartbeatMs: 100, serve: remoteServe(uiHandlers(a.core)) });
    a.core.computers = la;
    a.core.network = la.options.network;
    await sb.query(
      "UPDATE thread_items SET content=jsonb_set(content,'{commandExecution,output}','\"restart edit\"') WHERE thread_id=$1::uuid AND item_id='item-2'",
      [thread],
    );
    const publish = lb.mirror.publish.bind(lb.mirror);
    const resumed: link.MirrorUpdate[] = [];
    lb.mirror.publish = async function* (...args) {
      for await (const frame of publish(...args)) {
        resumed.push(frame);
        yield frame;
      }
    };

    await la.start();
    await caughtUp();
    expect((await la.mirror.state(node))!.generation).toBe(state.generation);
    const changed = (await la.mirror.snapshot(node, thread))!.items.find((i) => i.item?.itemId === "item-2")!.item!;
    expect(changed.content).toMatchObject({ case: "commandExecution", value: { output: "restart edit" } });
    expect(resumed.some((f) => f.deltaStart)).toBe(true);
    expect(resumed.some((f) => f.snapshotStart)).toBe(false);
  }, 30_000);

  test("an overlapping reconnect fences the old delta before the new checkpoint", async () => {
    await lb.close();
    const state = (await la.mirror.state(node))!;
    const ready = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const abort = new AbortController();

    async function* delta(title: string) {
      yield create(link.MirrorUpdateSchema, {
        previousCursor: state.cursor,
        deltaStart: true,
        delta: { baseCursor: state.cursor, snapshot: { thread: { id: thread, title } } },
      });

      if (title === "Stale stream") {
        ready.resolve();
        await resume.promise;
      }

      yield create(link.MirrorUpdateSchema, { previousCursor: state.cursor, deltaEnd: true });
    }

    const old = failure(la.mirror.consume(node, delta("Stale stream"), () => {}, abort.signal));
    await ready.promise;

    async function* winner() {
      yield* delta("Current stream");
      // The new projection is saved, but its cursor is still the same as the old stream's.
      resume.resolve();
      expect(await old).toContain("superseded");
    }

    try {
      await la.mirror.consume(node, winner(), () => {}, abort.signal);
      expect((await la.mirror.snapshot(node, thread))?.thread?.title).toBe("Current stream");
      expect((await la.mirror.state(node))!.cursor).toBe(state.cursor);
    } finally {
      resume.resolve();
      abort.abort();
    }

    // Repair the synthetic title with a real home projection.
    await la.mirror.clearCursor(node);
    lb = home();
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await connect();
  }, 30_000);

  test("a missing base and interrupted delta preserve readable history until full recovery", async () => {
    await lb.close();
    const state = (await la.mirror.state(node))!;

    async function* partial() {
      yield create(link.MirrorUpdateSchema, {
        previousCursor: state.cursor,
        deltaStart: true,
        delta: { baseCursor: state.cursor, snapshot: { thread: { id: thread, title: "Incomplete" } } },
      });
    }

    await la.mirror.consume(node, partial(), () => {}, new AbortController().signal);
    expect((await la.mirror.snapshot(node, thread))?.thread?.title).toBe("After reconnect");
    expect((await la.mirror.state(node))!.cursor).toBe(state.cursor);
    await sa.query("DELETE FROM computer_mirror_threads WHERE origin_node_id=$1 AND thread_id=$2::uuid", [
      node,
      thread,
    ]);

    async function* missing() {
      yield* partial();
      yield create(link.MirrorUpdateSchema, { previousCursor: state.cursor, deltaEnd: true });
    }

    expect(await failure(la.mirror.consume(node, missing(), () => {}, new AbortController().signal))).toContain(
      "mismatch",
    );
    await la.mirror.clearCursor(node);
    lb = home();
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await connect();
    expect((await la.mirror.snapshot(node, thread))!.items.length).toBe(2999);
  }, 30_000);

  test("gaps and changed epochs force full open and background recovery", async () => {
    for (const epoch of [false, true]) {
      await lb.close();
      const state = (await la.mirror.state(node))!;

      if (epoch)
        await sb.query("UPDATE computer_thread_clock SET epoch=gen_random_uuid() WHERE owner_user_id=$1::uuid", [
          b.userId,
        ]);
      else {
        await sb.query("UPDATE threads SET title='Journal gap' WHERE id=$1::uuid", [thread]);
        await sb.query("DELETE FROM computer_thread_changes WHERE owner_user_id=$1::uuid", [b.userId]);
      }

      lb = home();
      b.core.computers = lb;
      b.core.network = lb.options.network;
      const publish = lb.mirror.publish.bind(lb.mirror);
      const resume = Promise.withResolvers<void>();
      lb.mirror.publish = async function* (...args) {
        await resume.promise;
        yield* publish(...args);
      };

      opens.length = 0;

      try {
        await lb.start();
        expect(await eventually(() => Promise.resolve(la.reachable().includes(node)), Boolean, 15_000)).toBe(true);
        await open();
        expect(opens.some((u) => u.change.case === "snapshot" && u.change.value.items.length === 2999)).toBe(true);
        expect(opens.some((u) => u.change.case === "delta")).toBe(false);
      } finally {
        resume.resolve();
      }

      await caughtUp();
      expect((await la.mirror.state(node))!.generation).not.toBe(state.generation);
    }
  }, 60_000);

  test("older homes and legacy mirror requests receive full snapshots", async () => {
    await lb.close();
    lb = home(["presence", "unlink", REMOTE_THREADS, THREAD_MIRROR]);
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await connect();
    opens.length = 0;
    await open();
    expect(opens.some((u) => u.change.case === "snapshot" && u.change.value.items.length === 2999)).toBe(true);
    expect(opens.some((u) => u.change.case === "delta")).toBe(false);
    const cursor = (await la.mirror.state(node))!.cursor;
    await sb.query("UPDATE threads SET title='Legacy partner' WHERE id=$1::uuid", [thread]);
    const abort = new AbortController();

    try {
      const updates: link.MirrorUpdate[] = [];

      for await (const frame of lb.mirror.publish(
        create(link.MirrorRequestSchema, { cursor }),
        remoteServe(uiHandlers(b.core)),
        abort.signal,
      )) {
        updates.push(frame);

        if (frame.commit) break;
      }

      expect(updates.some((f) => f.snapshotStart)).toBe(true);
      expect(updates.some((f) => f.deltaStart)).toBe(false);
    } finally {
      abort.abort();
    }
  }, 30_000);

  test("an older partner negotiates full opens and background projections with a new home", async () => {
    await la.close();
    await lb.close();
    la = linkedComputers({
      store: sa,
      host: "127.0.0.1",
      heartbeatMs: 100,
      capabilities: ["presence", "unlink", REMOTE_THREADS, THREAD_MIRROR],
      serve: remoteServe(uiHandlers(a.core)),
    });
    lb = home();
    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;
    const publish = lb.mirror.publish.bind(lb.mirror);
    const legacy: link.MirrorUpdate[] = [];
    lb.mirror.publish = async function* (...args) {
      for await (const frame of publish(...args)) {
        legacy.push(frame);
        yield frame;
      }
    };

    await la.start();
    await connect();
    legacy.length = 0;
    await sb.query("UPDATE threads SET title='Older partner' WHERE id=$1::uuid", [thread]);
    await caughtUp();
    expect(legacy.some((f) => f.snapshotStart)).toBe(true);
    expect(legacy.some((f) => f.deltaStart)).toBe(false);
    opens.length = 0;
    await open();
    expect(opens.some((u) => u.change.case === "snapshot" && u.change.value.items.length === 2999)).toBe(true);
    expect(opens.some((u) => u.change.case === "delta")).toBe(false);
  }, 30_000);
});
