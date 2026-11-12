import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { REMOTE_THREAD_PANEL, splitId } from "@canopy/domain/computers";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { linkedMessage } from "../computers/remote.ts";
import { peerOf } from "./routed-home.ts";
import { unary, type Handler } from "./routed-context.ts";
import type { UiHandlers } from "./ui-service.ts";

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

      const saved = async () => {
        const rows = await store.query<{ payload: Uint8Array }>(
          "SELECT payload FROM computer_thread_panels WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid",
          params,
        );

        return create(ui.ThreadPanelSchema, {
          ...(rows[0] && fromBinary(ui.ThreadPanelSchema, rows[0].payload)),
          stale: true,
          unavailable: !rows[0],
        });
      };

      if (!computers.capabilities(node).includes(REMOTE_THREAD_PANEL)) return saved();

      if (!computers.reachable().includes(node)) return saved();

      try {
        const panel = linkedMessage(ui.ThreadPanelSchema, await unary(routed["getThreadPanel"]!, request, context));
        // Keep home-independent ids in storage; a future project alias can be resolved by a fresh read.
        const cached = clone(ui.ThreadPanelSchema, panel);
        await store.query(
          `INSERT INTO computer_thread_panels(owner_user_id,origin_node_id,thread_id,payload)
          SELECT $1::uuid,$2,$3::uuid,$4 FROM computer_peers WHERE owner_user_id=$1::uuid AND node_id=$2
            AND (via_node_id IS NULL OR relay_role IN ('home','both')) FOR SHARE
          ON CONFLICT(owner_user_id,origin_node_id,thread_id) DO UPDATE SET payload=excluded.payload`,
          [...params, toBinary(ui.ThreadPanelSchema, cached)],
        );

        return panel;
      } catch (error) {
        if (
          error instanceof ConnectError &&
          [Code.Unavailable, Code.DeadlineExceeded, Code.Unimplemented].includes(error.code)
        )
          return saved();
        await store.query(
          "DELETE FROM computer_thread_panels WHERE owner_user_id=$1::uuid AND origin_node_id=$2 AND thread_id=$3::uuid",
          params,
        );
        throw error;
      }
    },
  };
}
