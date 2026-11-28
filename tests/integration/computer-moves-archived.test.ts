import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { qualifyId } from "@canopy/domain/computers";
import { dockerAvailable } from "@canopy/db/testing";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { restoreArchived } from "../../apps/gateway/src/computers/move-state.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";
import { thread } from "./support/thread-move.ts";

/**
 * Stage 8 of docs/linked-computers.md with an archived thread: its side threads arrive before the main thread is
 * archived on the new computer (a side thread can't be created under an archived parent).
 */
describe.skipIf(!dockerAvailable)("moving an archived thread between linked computers", () => {
  let a: TestGateway;
  let c: TestGateway;
  let la: LinkedComputers;
  let lc: LinkedComputers;

  const runtime = (gw: TestGateway) =>
    linkedComputers({
      store: new ComputerStore(gw.runtime, gw.userId, gw.secretsKey),
      host: "127.0.0.1",
      heartbeatMs: 150,
      serve: remoteServe(uiHandlers(gw.core), gw.core),
      core: gw.core,
    });

  beforeAll(async () => {
    a = await startTestGateway({ role: "desktop" });
    c = await startTestGateway({ role: "desktop" });
    la = runtime(a);
    lc = runtime(c);

    for (const [gw, l] of [
      [a, la],
      [c, lc],
    ] as const) {
      gw.core.computers = l;
      gw.core.network = l.options.network;
      await l.start();
    }

    await c.api.linkComputer({ address: la.addresses[0]!, code: (await a.api.createComputerPairing({})).code });
    const cNode = lc.hello().nodeId;
    await eventually(async () => la.reachable().includes(cNode) && lc.reachable().includes(la.hello().nodeId), Boolean);
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([la?.close(), lc?.close()]);
    await Promise.allSettled([a?.close(), c?.close()]);
  }, 30_000);

  test("an archived thread moves with its side threads, stays archived and reopens as it would have", async () => {
    const cNode = lc.hello().nodeId;
    const project = (await a.api.createProject({ name: "Repo on A" })).project!.id;

    const workspace = (await a.api.createWorkspace({ projectId: project, workerId: a.workerId, rootPath: "/repo" }))
      .workspace!.id;

    const cProject = (await c.api.createProject({ name: "Repo on C" })).project!.id;

    const cWorkspace = (
      await c.api.createWorkspace({ projectId: cProject, workerId: c.workerId, rootPath: "/repo/new" })
    ).workspace!.id;

    const parent = await thread(a, project, workspace, "Archived move", "");
    const child = await thread(a, project, workspace, "Closed with its thread", "", parent);
    const closed = await thread(a, project, workspace, "Closed on its own", "", parent);
    // One side thread is archived on its own first; archiving the main thread then closes the other with it.
    await a.api.setThreadArchived({ threadId: closed, archived: true });
    await a.api.setThreadArchived({ threadId: parent, archived: true });

    const archived = (gw: TestGateway) =>
      gw.core.computers!.store.query<{
        id: string;
        archived_at: Date | null;
        status: string;
        archived_by: string | null;
        archived_by_thread_id: string | null;
      }>(
        `SELECT id, archived_at, status, archived_by, archived_by_thread_id FROM threads
        WHERE id = ANY($1::uuid[]) ORDER BY id`,
        [[parent, child, closed]],
      );

    const before = await archived(a);

    await a.api.startMove({
      nodeId: cNode,
      items: [{ kind: "thread", id: parent }],
      placements: [{ projectId: project, workspaceId: qualifyId(cWorkspace, cNode) }],
    });

    const state = await eventually(
      async () => (await c.api.getMoves({})).moves.find((record) => record.itemId === parent)?.state,
      (s) => s === "done",
      20_000,
    );

    expect(state).toBe("done");
    expect((await c.api.getThread({ threadId: child })).thread).toMatchObject({ parentThreadId: parent });
    // Archived as they were, at their own times (not the time of the move).
    expect(before.every((row) => row.archived_at && row.status === "archived")).toBe(true);
    expect(before.find((row) => row.id === child)).toMatchObject({ archived_by: "cascade" });
    expect(before.find((row) => row.id === closed)).toMatchObject({ archived_by: "user" });
    expect(await archived(c)).toEqual(before);

    // Reopening the main thread there reopens only the side thread that was closed with it.
    await c.api.setThreadArchived({ threadId: parent, archived: false });
    const reopened = new Map((await archived(c)).map((row) => [row.id, row.archived_at]));
    expect([reopened.get(parent), reopened.get(child)]).toEqual([null, null]);
    expect(reopened.get(closed)).toBeTruthy();
  }, 60_000);

  test("an archive reason the target doesn't know arrives as the owner's", async () => {
    const project = (await c.api.createProject({ name: "Unknown reason" })).project!.id;

    const workspace = (await c.api.createWorkspace({ projectId: project, workerId: c.workerId, rootPath: "/other" }))
      .workspace!.id;

    const id = await thread(c, project, workspace, "Archived elsewhere", "");
    const at = new Date("2026-11-01T10:00:00Z");
    const store = c.core.computers!.store;
    await restoreArchived(store, [{ id, archived_at: at, archived_by: "robot", archived_by_thread_id: null }]);

    const [row] = await store.query<{ archived_at: Date; archived_by: string }>(
      `SELECT archived_at, archived_by FROM threads WHERE id = $1::uuid`,
      [id],
    );

    expect(row).toEqual({ archived_at: at, archived_by: "user" });
  }, 30_000);
});
