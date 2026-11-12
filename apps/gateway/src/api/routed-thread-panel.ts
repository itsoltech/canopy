import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { REMOTE_THREAD_PANEL, splitId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { linkedMessage } from "../computers/remote.ts";
import { peerOf } from "./routed-home.ts";
import { unary, type Handler } from "./routed-context.ts";
import type { UiHandlers } from "./ui-service.ts";
import type { LinkedComputers } from "../computers/runtime.ts";

export async function cachedThreadPanel(computers: LinkedComputers, node: string, thread: string) {
  const rows = await computers.store.query<{ payload: Uint8Array }>(
    `SELECT p.payload FROM computer_thread_panels p JOIN computer_peers c
      ON c.owner_user_id=p.owner_user_id AND c.node_id=p.origin_node_id
      WHERE p.owner_user_id=$1::uuid AND p.origin_node_id=$2 AND p.thread_id=$3::uuid
        AND (c.via_node_id IS NULL OR c.relay_role IN ('home','both'))`,
    [computers.store.owner, node, thread],
  );

  const panel = rows[0] ? fromBinary(ui.ThreadPanelSchema, rows[0].payload) : create(ui.ThreadPanelSchema);
  panel.stale = true;
  panel.unavailable = !rows[0];

  return panel;
}

async function rememberPanel(computers: LinkedComputers, node: string, thread: string, panel: ui.ThreadPanel) {
  await computers.store.query(
    `INSERT INTO computer_thread_panels(owner_user_id,origin_node_id,thread_id,payload)
      SELECT $1::uuid,$2,$3::uuid,$4 FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2
        AND (via_node_id IS NULL OR relay_role IN ('home','both')) FOR SHARE
      ON CONFLICT(owner_user_id,origin_node_id,thread_id) DO UPDATE SET payload=excluded.payload`,
    [computers.store.owner, node, thread, toBinary(ui.ThreadPanelSchema, panel)],
  );
}

/** Only verified home responses are cached. Unlink removes them by FK; denied reads revoke them. */
export function linkedThreadPanel(core: GatewayCore, routed: Record<string, Handler>): Partial<UiHandlers> {
  return {
    getThreadPanel: async (request, context) => {
      const ref = splitId(request.threadId);

      if (!ref.node)
        return linkedMessage(ui.ThreadPanelSchema, await unary(routed["getThreadPanel"]!, request, context));
      const node = await peerOf(core, ref.node);
      const computers = core.computers!;
      const store = computers.store;
      const params = [store.owner, node, ref.id];

      const saved = () => cachedThreadPanel(computers, node, ref.id);

      if (!computers.capabilities(node).includes(REMOTE_THREAD_PANEL)) return saved();

      if (!computers.reachable().includes(node)) return saved();

      try {
        const panel = linkedMessage(ui.ThreadPanelSchema, await unary(routed["getThreadPanel"]!, request, context));
        await rememberPanel(computers, node, ref.id, panel);

        return panel;
      } catch (error) {
        if (
          error instanceof ConnectError &&
          ([Code.Unavailable, Code.DeadlineExceeded, Code.Unimplemented].includes(error.code) ||
            (error.code === Code.FailedPrecondition && !computers.canCall(node)))
        )
          return saved();
        await store.query(
          "DELETE FROM computer_thread_panels WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid",
          params,
        );
        throw error;
      }
    },
    setThreadConnectorGrant: async (request, context) => {
      const panel = linkedMessage(
        ui.ThreadPanelSchema,
        await unary(routed["setThreadConnectorGrant"]!, request, context),
      );

      const ref = splitId(request.threadId);

      if (ref.node) await rememberPanel(core.computers!, await peerOf(core, ref.node), ref.id, panel);

      return panel;
    },
  };
}
