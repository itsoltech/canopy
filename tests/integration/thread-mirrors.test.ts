import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo } from "node:net";
import { create, toBinary } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { NoticeLevel, Provider, ui, computerLink as link } from "@canopy/contracts";
import { qualifyId, REMOTE_THREADS, THREAD_MIRROR } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { AsyncChannel, startGrpcServer } from "@canopy/transport";
import { Effect, Match } from "effect";
import { SqlClient } from "effect/sql";
import { remoteServe, serviceTokenAuth, uiHandlers, uiRoutes } from "@canopy/gateway/api";
import { GatewayCore } from "@canopy/gateway/core";
import { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkClient } from "../../apps/gateway/src/computers/transport.ts";
import {
  eventually as poll,
  failure,
  SERVICE_TOKEN,
  startTestGateway,
  watchUntil,
  type TestGateway,
} from "./support/gateway.ts";

const port = () =>
  new Promise<number>((resolve) => {
    const server = createServer().listen(0, "127.0.0.1", () => {
      const p = (server.address() as AddressInfo).port;
      server.close(() => resolve(p));
    });
  });

const id = () => crypto.randomUUID();

const eventually = async (predicate: () => Promise<boolean>) =>
  expect(await poll(predicate, Boolean, 20_000)).toBe(true);

describe.skipIf(!dockerAvailable)("durable read-only thread mirrors across two gateways", () => {
  let a: TestGateway;
  let b: TestGateway;
  let sa: ComputerStore;
  let sb: ComputerStore;
  let la: LinkedComputers;
  let lb: LinkedComputers;
  let node: string;
  let project: string;
  let workspace: string;
  let thread: string;
  let aPort: number;
  let bPort: number;
  const keyA = randomBytes(32);
  const keyB = randomBytes(32);
  const q = (value: string) => qualifyId(value, node);
  const mirror = () => la.mirror.snapshot(node, thread);

  const online = () =>
    eventually(async () => la.reachable().includes(node) && lb.reachable().includes(la.hello().nodeId));

  const caughtUp = () =>
    eventually(async () => {
      const clock = (
        await sb.query<{ epoch: string; revision: string }>(
          "SELECT epoch,revision::text FROM computer_thread_clock WHERE owner_user_id=$1::uuid",
          [b.userId],
        )
      )[0];

      return Boolean(clock && (await la.mirror.state(node))?.cursor === `${clock.epoch}:${clock.revision}`);
    });

  async function offline() {
    await la.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
    );
    await lb.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: false }),
    );
    await eventually(async () => !la.reachable().length && !lb.reachable().length);
  }

  async function reconnect() {
    await la.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
    );
    await lb.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
    );
    await online();
    await caughtUp();
  }

  async function createThread(title: string, text = "") {
    return (
      await b.api.createThread({
        projectId: project,
        workspaceId: workspace,
        title,
        provider: Provider.CODEX,
        initialMessage: text,
        clientRequestId: id(),
      })
    ).thread!.id;
  }

  const newB = (capabilities?: string[]) =>
    linkedComputers({
      store: sb,
      host: "127.0.0.1",
      port: bPort,
      heartbeatMs: 100,
      serve: remoteServe(uiHandlers(b.core)),
      ...(capabilities && { capabilities }),
    });

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    sa = new ComputerStore(a.runtime, a.userId, keyA);
    sb = new ComputerStore(b.runtime, b.userId, keyB);
    project = (await b.api.createProject({ name: "Laptop B project" })).project!.id;
    workspace = (await b.api.createWorkspace({ projectId: project, workerId: b.workerId, rootPath: "/repo/mirrors" }))
      .workspace!.id;
    thread = await createThread("Existing before pairing", "initial history");
    await watchUntil(b.api, thread, (updates) =>
      updates.some(
        (u) =>
          (u.change.case === "snapshot" && u.change.value.turns.some((t) => t.status === "completed")) ||
          (u.change.case === "turn" && u.change.value.status === "completed"),
      ),
    );
    aPort = await port();
    bPort = await port();
    la = linkedComputers({
      store: sa,
      host: "127.0.0.1",
      port: aPort,
      heartbeatMs: 100,
      serve: remoteServe(uiHandlers(a.core)),
    });
    lb = newB();
    a.core.computers = la;
    a.core.network = la.options.network;
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await la.start();
    await lb.start();
    node = lb.hello().nodeId;
    const pairing = await la.createPairing();
    await lb.pair(la.addresses[0]!, pairing.code);
    await online();
    await caughtUp();
  }, 90_000);
  afterAll(async () => {
    await Promise.allSettled([la?.close(), lb?.close()]);
    await a?.close();
    await b?.close();
  }, 20_000);

  test("the welcome precedes remote calls while the handshake status is still being stored", async () => {
    await offline();
    // The raw pinned client below owns B's handshake, without its runtime reconnecting alongside it.
    await lb.close();
    await la.options.network.update(
      create(ui.UpdateNetworkAccessRequestSchema, { action: "set_enabled", enabled: true }),
    );
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const status = sa.status;
    // Hold the real persistence boundary so the API can race the handshake without a timing delay.
    sa.status = async (...args) => {
      if (args[1] === "connected") {
        entered.resolve();
        await resume.promise;
      }

      return status.apply(sa, args);
    };

    const frames = new AsyncChannel<link.LinkFrame>();
    frames.push(create(link.LinkFrameSchema, { body: { case: "hello", value: lb.hello() } }));
    const controller = new AbortController();

    const stream = linkClient(la.addresses[0]!, la.identity.certificate, lb.identity)
      .connect(frames, {
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();

    const first = stream.next();
    let listing: Promise<unknown> | undefined;

    try {
      await entered.promise;
      listing = a.api.listThreads({}, { signal: controller.signal });
      expect((await first).value?.body.case).toBe("welcome");
    } finally {
      resume.resolve();
      sa.status = status;
      controller.abort();
      frames.close();
      await Promise.allSettled([first, listing]);
      await offline();
      lb = newB();
      b.core.computers = lb;
      b.core.network = lb.options.network;
      await lb.start();
      await reconnect();
    }
  }, 30_000);

  test("initial sync includes existing full timelines and metadata, with no execution rows on A", async () => {
    const snapshot = (await mirror())!;
    expect(snapshot.thread?.id).toBe(q(thread));
    expect(snapshot.items.length).toBeGreaterThan(0);
    expect(snapshot.turns[0]?.inputText).toBe("initial history");
    expect(snapshot.turns[0]?.status).toBe("completed");
    expect((await la.mirror.overview(node)).projects.some((p) => p.id === q(project))).toBe(true);
    expect(await failure(a.core.getThread(thread))).toContain("not found");
    expect(snapshot.secrets).toEqual([]);
    expect(snapshot.schedules).toEqual([]);
  });

  test("the mirror subscription excludes another owner's threads and platform secrets", async () => {
    const owner = id();
    const projectId = id();
    const privateThread = id();
    await sb.query("INSERT INTO users(id,email,display_name,role) VALUES($1::uuid,$2,'Other owner','user')", [
      owner,
      `${owner}@test`,
    ]);
    await sb.query(
      "INSERT INTO projects(id,owner_user_id,name,slug) VALUES($1::uuid,$2::uuid,'Private project','private')",
      [projectId, owner],
    );
    await sb.query(
      `INSERT INTO threads(id,project_id,owner_user_id,kind,root_thread_id,runtime,provider,status)
      VALUES($1::uuid,$2::uuid,$3::uuid,'main',$1::uuid,'gateway','openai','idle')`,
      [privateThread, projectId, owner],
    );
    // WatchThread must enforce the same owner rule as GetThread, including linked requests.
    expect(await failure(watchUntil(a.api, q(privateThread), (u) => u.length > 0))).toContain("not found");
    await caughtUp();
    expect(await la.mirror.snapshot(node, privateThread)).toBeUndefined();
    expect((await la.mirror.overview(node)).projects.some((p) => p.id === q(projectId))).toBe(false);
    const secretId = id();
    const marker = `private-secret-metadata-${id()}`;
    await sb.query(
      `INSERT INTO thread_secrets(id,thread_id,turn_id,call_id,label,description)
      SELECT $1::uuid,thread_id,id,$1::uuid,$3,'Do not mirror this request' FROM turns WHERE thread_id=$2::uuid ORDER BY ordinal LIMIT 1`,
      [secretId, thread, marker],
    );
    await sb.query("UPDATE threads SET title=title WHERE id=$1::uuid", [thread]);
    const home = (await watchUntil(b.api, thread, (u) => u.length > 0))[0]!.change;
    expect(home.case === "snapshot" && home.value.secrets.some((s) => s.requestId === secretId)).toBe(true);
    await caughtUp();

    const names = await sa.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'computer_mirror_%'",
    );

    expect(names.map((n) => n.table_name).toSorted()).toEqual([
      "computer_mirror_bots",
      "computer_mirror_state",
      "computer_mirror_threads",
    ]);
    expect((await mirror())!.secrets).toEqual([]);

    const stored = await sa.query<{ snapshot: Uint8Array }>(
      "SELECT snapshot FROM computer_mirror_threads WHERE origin_node_id=$1",
      [node],
    );

    expect(stored.some((r) => new TextDecoder().decode(r.snapshot).includes(marker))).toBe(false);
  }, 30_000);

  test("live changes, queued turns and attachment metadata converge without duplicate timeline items", async () => {
    const file = (
      await b.api.uploadAttachment({ name: "offline-notes.txt", data: new TextEncoder().encode("file stays at home") })
    ).attachment!;

    await b.api.sendMessage({ threadId: thread, text: "live change", attachmentIds: [file.id], clientRequestId: id() });
    await eventually(
      async () =>
        (await mirror())?.turns.some((t) => t.inputText.includes("live change") && t.status === "completed") ?? false,
    );
    b.worker.holdTurns = true;
    const running = (await b.api.sendMessage({ threadId: thread, text: "working", clientRequestId: id() })).turn!;
    await eventually(async () => b.worker.started.has(running.id));
    await b.api.sendMessage({ threadId: thread, text: "queued", clientRequestId: id() });
    await caughtUp();
    const snapshot = (await mirror())!;
    expect(snapshot.turns.some((t) => t.inputText === "queued" && t.status === "queued")).toBe(true);
    expect(snapshot.turns.find((t) => t.inputText.includes("live change"))?.attachments[0]?.name).toBe(
      "offline-notes.txt",
    );
    expect(new Set(snapshot.items.map((i) => i.item?.itemId)).size).toBe(snapshot.items.length);
    expect(snapshot.items.map((i) => Number(i.firstSeq))).toEqual(
      snapshot.items.map((i) => Number(i.firstSeq)).toSorted((a, b) => a - b),
    );
    await b.api.interruptThread({ threadId: thread });
    b.worker.holdTurns = false;
    b.worker.finish(thread, running.id);
    await eventually(async () => !(await b.api.getThread({ threadId: thread })).thread?.status.includes("running"));
    await caughtUp();
  }, 40_000);

  test("source reconciliation refreshes the inherited history in fork mirrors", async () => {
    const source = await createThread("Fork source", "before reconciliation");

    const updates = await watchUntil(b.api, source, (updates) =>
      updates.some(
        (u) =>
          (u.change.case === "snapshot" && u.change.value.turns.some((t) => t.status === "completed")) ||
          (u.change.case === "turn" && u.change.value.status === "completed"),
      ),
    );

    const turn = updates
      .flatMap((u) =>
        Match.value(u.change).pipe(
          Match.withReturnType<readonly ui.Turn[]>(),
          Match.discriminator("case")("snapshot", (change) => change.value.turns),
          Match.discriminator("case")("turn", (change) => [change.value]),
          Match.orElse(() => []),
        ),
      )
      .find((t) => t.status === "completed")!;

    const fork = (await b.api.createThread({ forkThreadId: source, forkAtTurnId: turn.id })).thread!.id;
    await caughtUp();
    expect(
      (await la.mirror.snapshot(node, fork))?.turns.some((t) => t.inherited && t.inputText === "before reconciliation"),
    ).toBe(true);
    await sb.query(`UPDATE turns SET input='{"text":"reconciled history"}'::jsonb WHERE thread_id=$1::uuid`, [source]);
    await caughtUp();
    expect(
      (await la.mirror.snapshot(node, fork))?.turns.some((t) => t.inherited && t.inputText === "reconciled history"),
    ).toBe(true);
  }, 30_000);

  test("full offline history retains diagnostic notices beyond the live snapshot window after reconnect", async () => {
    const long = await createThread("Full diagnostic history");

    try {
      await offline();

      // This checks complete durable history, not live throughput (covered above). Finish ingestion
      // before reconnecting so snapshots and the heartbeat do not race a flood of worker events.
      for (let i = 0; i < 205; i++)
        b.worker.emit(long, "", {
          case: "notice",
          value: { level: NoticeLevel.WARNING, code: "api_retry", message: `Retry ${i}` },
        });
      await eventually(
        async () =>
          (
            await sb.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM thread_events WHERE thread_id=$1::uuid AND kind='notice'",
              [long],
            )
          )[0]?.count === 205,
      );
      await reconnect();
      expect((await la.mirror.snapshot(node, long))?.notices.length).toBe(205);
      await offline();
      const change = (await watchUntil(a.api, q(long), (u) => u.length > 0))[0]!.change;
      expect(change.case === "snapshot" && change.value.notices.length).toBe(205);

      if (change.case === "snapshot")
        expect(change.value.notices.map((n) => n.seq)).toEqual(
          change.value.notices.map((n) => n.seq).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        );
    } finally {
      await reconnect();
    }
  }, 40_000);

  test("journal commit ordering does not invert concurrent thread and turn locks", async () => {
    const locked = Promise.withResolvers<void>();
    const updated = Promise.withResolvers<void>();

    const first = b.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`SELECT id FROM threads WHERE id=${thread}::uuid FOR UPDATE`;
            locked.resolve();
            yield* Effect.promise(() => updated.promise);
            yield* sql`UPDATE threads SET title=title WHERE id=${thread}::uuid`;
          }),
        );
      }),
    );

    const second = b.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Effect.promise(() => locked.promise);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE turns SET input=input WHERE thread_id=${thread}::uuid`;
            updated.resolve();
            yield* sql`UPDATE threads SET title=title WHERE id=${thread}::uuid`;
          }),
        );
      }),
    );

    await Promise.all([first, second]);
    await caughtUp();
    expect((await mirror())?.thread?.id).toBe(q(thread));
  }, 30_000);

  test("reconnect replaces the peer's overview so deleted offline rows cannot survive as stale upserts", async () => {
    const deleted = await createThread("Delete during disconnect");
    await caughtUp();
    const controller = new AbortController();
    const seen: ui.LinkedComputerSnapshot[] = [];

    const reading = (async () => {
      try {
        for await (const u of a.api.watchOverview({}, { signal: controller.signal }))
          if (u.change.case === "computerSnapshot") seen.push(u.change.value);
      } catch {
        /* aborted */
      }
    })();

    try {
      await eventually(async () => seen.some((s) => s.threads.some((t) => t.id === q(deleted))));
      await offline();
      await b.api.deleteThread({ threadId: deleted });
      seen.length = 0;
      await reconnect();
      await eventually(async () =>
        seen.some(
          (s) =>
            s.nodeId === node &&
            s.threads.some((t) => t.id === q(thread)) &&
            !s.threads.some((t) => t.id === q(deleted)),
        ),
      );
    } finally {
      controller.abort();
      await reading;
    }
  }, 40_000);

  test("offline lists and reads come from the mirror; writes and file contents fail fast with no queue", async () => {
    await caughtUp();
    await offline();
    const before = (b.worker.inputs.get(thread) ?? []).length;
    expect((await a.api.listThreads({})).threads.some((t) => t.id === q(thread))).toBe(true);
    expect((await a.api.listThreads({ projectId: q(project) })).threads.some((t) => t.id === q(thread))).toBe(true);
    expect((await a.api.getOverview({})).projects.some((p) => p.id === q(project))).toBe(true);
    expect((await a.api.getThread({ threadId: q(thread) })).thread?.title).toBe("Existing before pairing");
    const updates = await watchUntil(a.api, q(thread), (u) => u.length > 0);
    const snapshot = updates[0]!.change;
    expect(snapshot.case).toBe("snapshot");

    if (snapshot.case !== "snapshot") throw new Error("Expected snapshot");
    const attachment = snapshot.value.turns.flatMap((t) => t.attachments)[0]!;
    const started = Date.now();
    expect(
      await failure(a.api.sendMessage({ threadId: q(thread), text: "must not queue", clientRequestId: id() })),
    ).toContain("since");
    expect(await failure(a.api.answerInteraction({ requestId: q(id()), allow: true }))).toContain("since");
    expect(await failure(a.api.deleteThread({ threadId: q(thread) }))).toContain("since");
    expect(await failure(a.api.getAttachment({ attachmentId: attachment.id }))).toContain("Available when");
    expect(Date.now() - started).toBeLessThan(1500);
    await reconnect();
    expect((b.worker.inputs.get(thread) ?? []).length).toBe(before);
    expect((await mirror())!.turns.some((t) => t.inputText === "must not queue")).toBe(false);
  }, 40_000);

  test("changes made while disconnected resume from the durable cursor without replacing the generation", async () => {
    await caughtUp();
    await offline();
    const state = (await la.mirror.state(node))!;
    await b.api.updateThread({ threadId: thread, title: "Changed offline" });
    await b.api.sendMessage({ threadId: thread, text: "while disconnected", clientRequestId: id() });
    await watchUntil(b.api, thread, (u) =>
      u.some(
        (x) =>
          (x.change.case === "snapshot" &&
            x.change.value.turns.some((t) => t.inputText === "while disconnected" && t.status === "completed")) ||
          (x.change.case === "turn" &&
            x.change.value.inputText === "while disconnected" &&
            x.change.value.status === "completed"),
      ),
    );
    await reconnect();
    expect((await la.mirror.state(node))!.generation).toBe(state.generation);
    expect((await la.mirror.state(node))!.cursor).not.toBe(state.cursor);
    expect((await mirror())!.thread?.title).toBe("Changed offline");
    expect((await mirror())!.turns.filter((t) => t.inputText === "while disconnected")).toHaveLength(1);
  }, 40_000);

  test("a stale cursor or a journal gap fully resynchronizes, removing deleted threads and preserving archivals", async () => {
    const deleted = await createThread("To delete");
    const archived = await createThread("To archive");
    await caughtUp();
    await offline();
    const generation = (await la.mirror.state(node))!.generation;
    await b.api.deleteThread({ threadId: deleted });
    await b.api.setThreadArchived({ threadId: archived, archived: true });
    await sb.query("DELETE FROM computer_thread_changes WHERE owner_user_id=$1::uuid", [b.userId]);
    await b.api.updateThread({ threadId: thread, title: "After journal pruning" });
    await reconnect();
    expect((await la.mirror.state(node))!.generation).not.toBe(generation);
    expect(await la.mirror.snapshot(node, deleted)).toBeUndefined();
    expect((await la.mirror.snapshot(node, archived))?.thread?.status).toBe("archived");
    expect((await la.mirror.threads(node, create(ui.ListThreadsRequestSchema))).some((t) => t.id === q(archived))).toBe(
      false,
    );
    expect(
      (await la.mirror.threads(node, create(ui.ListThreadsRequestSchema, { includeArchived: true }))).some(
        (t) => t.id === q(archived),
      ),
    ).toBe(true);
    // A cursor from another journal epoch must also reset.
    await offline();
    const old = (await la.mirror.state(node))!.generation;
    await sa.query("UPDATE computer_mirror_state SET cursor=$3 WHERE owner_user_id=$1::uuid AND origin_node_id=$2", [
      a.userId,
      node,
      `${id()}:0`,
    ]);
    await reconnect();
    expect((await la.mirror.state(node))!.generation).not.toBe(old);
  }, 60_000);

  test("live deletion and archival propagate; malformed predecessor never advances the cursor", async () => {
    const deleted = await createThread("Delete live");
    const archived = await createThread("Archive live");
    await caughtUp();
    await b.api.deleteThread({ threadId: deleted });
    await b.api.setThreadArchived({ threadId: archived, archived: true });
    await caughtUp();
    expect(await la.mirror.snapshot(node, deleted)).toBeUndefined();
    expect((await la.mirror.snapshot(node, archived))?.thread?.status).toBe("archived");
    await offline();
    const cursor = (await la.mirror.state(node))!.cursor;

    async function* malformed() {
      yield create(link.MirrorUpdateSchema, { previousCursor: "wrong", cursor: "wrong:2", commit: true });
    }

    expect(await failure(la.mirror.consume(node, malformed(), () => {}, new AbortController().signal))).toContain(
      "mismatch",
    );
    expect((await la.mirror.state(node))!.cursor).toBe(cursor);
    await reconnect();
  }, 40_000);

  test("an interrupted replacement leaves the previous readable generation and cursor intact", async () => {
    await caughtUp();
    await offline();
    const state = (await la.mirror.state(node))!;

    async function* interrupted() {
      yield create(link.MirrorUpdateSchema, { reset: true });
      yield create(link.MirrorUpdateSchema, { snapshot: { thread: { id: thread, title: "Incomplete replacement" } } });
    }

    await la.mirror.consume(node, interrupted(), () => {}, new AbortController().signal);
    expect((await la.mirror.state(node))!.generation).toBe(state.generation);
    expect((await la.mirror.state(node))!.cursor).toBe(state.cursor);
    expect((await a.api.getThread({ threadId: q(thread) })).thread?.title).toBe("After journal pruning");
    expect(
      (await sa.query("SELECT DISTINCT generation FROM computer_mirror_threads WHERE origin_node_id=$1", [node]))
        .length,
    ).toBe(1);
    await reconnect();
  }, 30_000);

  test("fragment gaps and invalid checkpoints preserve data; a concurrent reset supersedes the old generation", async () => {
    await caughtUp();
    await offline();
    const state = (await la.mirror.state(node))!;
    const before = (await mirror())!;
    const home = (await watchUntil(b.api, thread, (u) => u.length > 0))[0]!.change;

    if (home.case !== "snapshot") throw new Error("Expected home snapshot");
    const homeSnapshot = home.value;

    async function* fragments() {
      yield create(link.MirrorUpdateSchema, {
        previousCursor: state.cursor,
        snapshotStart: true,
        snapshot: { thread: { id: thread, title: "Broken fragments" } },
      });
      yield create(link.MirrorUpdateSchema, { previousCursor: "wrong", snapshotEnd: true });
    }

    expect(await failure(la.mirror.consume(node, fragments(), () => {}, new AbortController().signal))).toContain(
      "mismatch",
    );

    async function* checkpoint() {
      yield create(link.MirrorUpdateSchema, { reset: true });
      yield create(link.MirrorUpdateSchema, { commit: true, cursor: "invalid" });
    }

    expect(await failure(la.mirror.consume(node, checkpoint(), () => {}, new AbortController().signal))).toContain(
      "mismatch",
    );
    expect((await mirror())!.thread?.title).toBe(before.thread?.title);
    expect((await la.mirror.state(node))!.cursor).toBe(state.cursor);

    async function* slowReset() {
      yield create(link.MirrorUpdateSchema, { reset: true });

      async function* winner() {
        yield create(link.MirrorUpdateSchema, { reset: true });
        yield create(link.MirrorUpdateSchema, { snapshot: homeSnapshot });
        yield create(link.MirrorUpdateSchema, { commit: true, cursor: state.cursor });
      }

      await la.mirror.consume(node, winner(), () => {}, new AbortController().signal);
      yield create(link.MirrorUpdateSchema, { commit: true, cursor: state.cursor });
    }

    expect(await failure(la.mirror.consume(node, slowReset(), () => {}, new AbortController().signal))).toContain(
      "superseded",
    );
    expect((await la.mirror.state(node))!.cursor).toBe(state.cursor);
    expect((await la.mirror.state(node))!.generation).not.toBe(state.generation);
    expect((await mirror())!.thread?.title).toBe(before.thread?.title);
    // The synthetic competing reset only sent one thread. Recover the complete real peer projection.
    await la.mirror.clearCursor(node);
    await reconnect();
  }, 30_000);

  test("a new gateway core and link instance keep offline mirrors and their cursor after restart", async () => {
    await caughtUp();
    await offline();
    const state = (await la.mirror.state(node))!;
    await la.close();

    const core = new GatewayCore({
      role: "desktop",
      runtime: a.runtime,
      userId: a.userId,
      instanceId: "restarted",
      sshSecretsKey: keyA,
    });

    const store = new ComputerStore(a.runtime, a.userId, keyA);
    la = linkedComputers({
      store,
      host: "127.0.0.1",
      port: aPort,
      heartbeatMs: 100,
      serve: remoteServe(uiHandlers(core)),
    });
    core.computers = la;
    a.core.computers = la;
    a.core.network = la.options.network;
    await la.start();
    const grpc = await startGrpcServer({ routes: uiRoutes(core), interceptors: [serviceTokenAuth(SERVICE_TOKEN)] });

    const api = createClient(
      ui.GatewayService,
      createGrpcTransport({
        baseUrl: grpc.url,
        interceptors: [
          (next) => (r) => {
            r.header.set("authorization", `Bearer ${SERVICE_TOKEN}`);

            return next(r);
          },
        ],
      }),
    );

    try {
      expect((await la.mirror.state(node))!.cursor).toBe(state.cursor);
      expect((await api.getComputers({})).peers[0]?.capabilities).toContain(THREAD_MIRROR);
      expect((await api.getThread({ threadId: q(thread) })).thread?.title).toBe("After journal pruning");
      expect((await watchUntil(api, q(thread), (u) => u.length > 0))[0]?.change.case).toBe("snapshot");
    } finally {
      await grpc.close();
      await core.stopSweep();
      await core.bots.stop();
    }

    await reconnect();
  }, 40_000);

  test("a peer without thread_mirror uses stage-2 behavior and stops listing when disconnected", async () => {
    await lb.close();
    lb = newB(["presence", "unlink", REMOTE_THREADS]);
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await lb.start();
    await online();
    expect((await a.api.listThreads({})).threads.some((t) => t.id === q(thread))).toBe(true);
    await offline();
    expect((await a.api.listThreads({})).threads.some((t) => t.nodeId === node)).toBe(false);
    expect(await failure(a.api.getThread({ threadId: q(thread) }))).toContain("since");
    await lb.close();
    lb = newB();
    b.core.computers = lb;
    b.core.network = lb.options.network;
    await lb.start();
    await reconnect();
  }, 45_000);

  test("unlink purges the mirror, cursor and staged generations on both sides", async () => {
    await caughtUp();
    expect(toBinary(ui.ThreadSnapshotSchema, (await mirror())!).length).toBeGreaterThan(0);
    await a.api.manageComputer({ action: "unlink", nodeId: node });
    await eventually(async () => !(await lb.snapshot()).peers.length);
    expect(await la.mirror.state(node)).toBeUndefined();
    expect(await mirror()).toBeUndefined();
    expect((await sa.query("SELECT * FROM computer_mirror_threads WHERE origin_node_id=$1", [node])).length).toBe(0);
    expect(await failure(a.api.getThread({ threadId: q(thread) }))).toContain("no longer linked");
  }, 30_000);
});
