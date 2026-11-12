import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink as link, Provider, ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { Code, ConnectError } from "@connectrpc/connect";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedMessage } from "../../apps/gateway/src/computers/remote.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway } from "./support/gateway.ts";

describe.skipIf(!dockerAvailable)("thread range controls after a move", () => {
  let a: Awaited<ReturnType<typeof startTestGateway>>;
  let b: Awaited<ReturnType<typeof startTestGateway>>;
  let home: ReturnType<typeof linkedComputers>;
  let local: ReturnType<typeof linkedComputers>;
  let source: ComputerStore;
  let target: ComputerStore;
  let thread: string;
  let node: string;
  let cursor: ui.ThreadSyncCursor;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const acknowledged = Promise.withResolvers<string>();

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    b = await startTestGateway({ role: "desktop" });
    source = new ComputerStore(a.runtime, a.userId, a.secretsKey);
    target = new ComputerStore(b.runtime, b.userId, b.secretsKey);
    home = linkedComputers({ store: source, core: a.core, host: "127.0.0.1", serve: remoteServe(uiHandlers(a.core)) });
    local = linkedComputers({ store: target, core: b.core, host: "127.0.0.1", serve: remoteServe(uiHandlers(b.core)) });
    const project = (await a.api.createProject({ name: "Move controls" })).project!.id;

    const workspace = (
      await a.api.createWorkspace({ projectId: project, workerId: a.workerId, rootPath: "/repo/controls" })
    ).workspace!.id;

    thread = (
      await a.api.createThread({
        projectId: project,
        workspaceId: workspace,
        provider: Provider.CODEX,
        title: "Moving thread",
        clientRequestId: crypto.randomUUID(),
      })
    ).thread!.id;
    expect(
      (
        await eventually(
          () => a.api.getThread({ threadId: thread }),
          (r) => r.thread?.status === "idle",
        )
      ).thread?.status,
    ).toBe("idle");
    a.core.computers = home;
    b.core.computers = local;
    const remote = local.remote.bind(local);
    let paused = false;
    local.remote = async function* (...args) {
      const ack = args[1].name === "AckThreadRange" && linkedMessage(link.ThreadRangeAckSchema, args[2]);

      if (paused || !ack || ack.cursor?.threadId !== thread) {
        yield* remote(...args);

        return;
      }

      paused = true;
      cursor = ack.cursor;
      // The receiver has committed its batch. Cut over before its ACK reaches
      // the original home, without a timed sleep or a production hook.
      held.resolve();
      await release.promise;

      try {
        for await (const response of remote(...args)) {
          acknowledged.resolve("");
          yield response;
        }
      } catch (cause) {
        acknowledged.resolve(ConnectError.from(cause).message);
        throw cause;
      }
    };

    await home.start();
    await local.start();
    node = home.hello().nodeId;
    await home.pair(local.addresses[0]!, (await local.createPairing()).code);
  }, 30_000);

  afterAll(async () => {
    release.resolve();
    await Promise.allSettled([local?.close(), home?.close()]);
    await Promise.allSettled([a?.close(), b?.close()]);
  });

  test("a batch committed before cutover is acknowledged at the old home and removed", async () => {
    await held.promise;

    try {
      expect(await local.ranges.cursors(node)).toContainEqual(cursor);
      expect(
        await target.query("SELECT 1 FROM computer_mirror_threads WHERE origin_node_id=$1 AND thread_id=$2::uuid", [
          node,
          thread,
        ]),
      ).toHaveLength(1);
      // These are the source-side effects of move cutover. No target execution
      // is needed to verify that an old journal's controls never redirect.
      await source.query("UPDATE threads SET deleted_at=now(),moved_to=$2 WHERE id=$1::uuid", [thread, "c".repeat(64)]);
      await home.redirects.record(
        create(link.MovedItemSchema, {
          itemId: thread,
          kind: "thread",
          fromNodeId: node,
          homeNodeId: "c".repeat(64),
          homeName: "New home",
          movedAtMs: BigInt(Date.now()),
        }),
      );
    } finally {
      release.resolve();
    }

    expect(await acknowledged.promise).toBe("");
    expect(
      await eventually(
        async () =>
          (
            await target.query("SELECT 1 FROM computer_mirror_threads WHERE origin_node_id=$1 AND thread_id=$2::uuid", [
              node,
              thread,
            ])
          ).length,
        (n) => n === 0,
      ),
    ).toBe(0);
    expect(await local.ranges.cursors(node)).toEqual([]);
  }, 15_000);

  test("a resumed subscription removes a moved thread named by its durable old cursor", async () => {
    const abort = new AbortController();
    let removed = "";

    try {
      const request = create(link.MirrorRequestSchema, { ranges: true, threadCursors: [cursor] });

      for await (const message of local.remote(
        node,
        link.ThreadMirrorService.method.watchThreadMirror,
        request,
        AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
      )) {
        const update = linkedMessage(link.MirrorUpdateSchema, message);

        if (update.removedThreadId) {
          removed = update.removedThreadId;
          break;
        }
      }
    } finally {
      abort.abort();
    }

    expect(removed).toBe(thread);
  }, 10_000);

  test("gap repair stays on the old journal instead of redirecting to another epoch", async () => {
    const request = create(link.ThreadRangeRequestSchema, { cursor });
    let code: Code | undefined;

    try {
      for await (const _message of local.remote(
        node,
        link.ThreadMirrorService.method.getThreadRange,
        request,
        AbortSignal.timeout(5000),
      )) {
        throw new Error("Deleted source returned a range");
      }
    } catch (cause) {
      code = ConnectError.from(cause).code;
    }

    expect(code).toBe(Code.NotFound);
  });
});
