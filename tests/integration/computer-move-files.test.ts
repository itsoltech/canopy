import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { computerLink as link } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { THREAD_TRANSFER_CAPABILITY } from "@canopy/domain/release/protocol";
import { remoteServe, uiHandlers } from "@canopy/gateway/api";
import { ComputerStore } from "../../apps/gateway/src/computers/store.ts";
import type { LinkedComputers } from "../../apps/gateway/src/computers/runtime.ts";
import { linkedComputers } from "./support/computers.ts";
import { eventually, failure, startTestGateway, type TestGateway } from "./support/gateway.ts";

/**
 * The target side of a linked-computer move that carries a thread's session and files (docs/thread-transfers.md):
 * the first step binds the move to the partner that sent it and its workspace. Another partner can neither continue,
 * discard nor decide it, a step can't name a folder the move did not create, and once the move is staged only its
 * decision removes the files.
 */
describe.skipIf(!dockerAvailable)("files of a linked-computer move on the target", () => {
  let gw: TestGateway;
  let computers: LinkedComputers;
  let store: ComputerStore;
  let workspaceId = "";

  beforeAll(async () => {
    gw = await startTestGateway({ role: "desktop" });
    const office = await gw.addWorker("Office");
    await gw.connect(office.workerId, office.credential, "linux", {
      hello: { capabilities: [THREAD_TRANSFER_CAPABILITY] },
    });
    await eventually(
      () => gw.api.getOverview({}),
      (o) => o.workers.some((w) => w.id === office.workerId && w.online),
    );
    const project = (await gw.api.createProject({ name: "Moved" })).project!;

    workspaceId = (
      await gw.api.createWorkspace({ projectId: project.id, workerId: office.workerId, rootPath: "/repo/moved" })
    ).workspace!.id;

    store = new ComputerStore(gw.runtime, gw.userId, gw.secretsKey);

    computers = linkedComputers({
      store,
      host: "127.0.0.1",
      heartbeatMs: 60_000,
      serve: remoteServe(uiHandlers(gw.core), gw.core),
      core: gw.core,
    });
  }, 60_000);

  afterAll(async () => {
    await computers?.close("updating");
    await gw?.close();
  });

  const serve = (peer: string, files: Parameters<typeof create<typeof link.MoveFilesSchema>>[1]) =>
    computers.moves!.serve(
      peer,
      link.ComputerMoveService.method.transferMoveFiles,
      create(link.MoveFilesSchema, { workspaceId, ...files }),
    );

  const reservation = async (moveId: string) =>
    (
      await store.query<{ peer_node_id: string; state: string }>(
        `SELECT peer_node_id, state FROM computer_move_files WHERE move_id = $1::uuid`,
        [moveId],
      )
    )[0];

  test("a move belongs to its partner, its folder and its time before staging, and to its partner's decision", async () => {
    const moveId = crypto.randomUUID();

    const apply = {
      operation: { action: { case: "apply" as const, value: { token: moveId, cwd: "/repo/moved", sessions: [] } } },
    };

    // The first step binds the move to partner A; the folder is not one this move created.
    expect(await failure(serve("node-a", { moveId, ...apply }))).toContain("The step names another folder.");
    expect(await reservation(moveId)).toEqual({ peer_node_id: "node-a", state: "receiving" });

    // Partner B can't continue A's move or discard it.
    expect(await failure(serve("node-b", { moveId, ...apply }))).toContain("The step belongs to another move.");
    await serve("node-b", { moveId, discard: true });
    expect(await reservation(moveId)).toEqual({ peer_node_id: "node-a", state: "receiving" });

    // Once the move is staged here, its files take no more steps, not even from A.
    await store.query(
      `INSERT INTO computer_moves (owner_user_id, id, role, kind, item_id, peer_node_id, state, title)
      VALUES ($1::uuid, $2::uuid, 'target', 'thread', $2::uuid, 'node-a', 'prepared', 'Moved')`,
      [gw.userId, moveId],
    );
    expect(await failure(serve("node-a", { moveId, ...apply }))).toContain("This move is already staged.");
    await serve("node-a", { moveId, discard: true });
    expect(await reservation(moveId)).toEqual({ peer_node_id: "node-a", state: "receiving" });

    // Only its own partner's abort removes the files: B's decision on A's move changes nothing.
    await computers.moves!.serve(
      "node-b",
      link.ComputerMoveService.method.decideMove,
      create(link.MoveDecisionSchema, { moveId, decision: "abort" }),
    );
    expect(await reservation(moveId)).toEqual({ peer_node_id: "node-a", state: "receiving" });
  });
});
