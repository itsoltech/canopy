import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import type { GatewayCore } from "../core/core.ts";
import { sendDiagnosticsInvalidation } from "./invalidation.ts";

export async function diagnosticsGrants(core: GatewayCore) {
  const store = core.computers?.store;

  if (!store) return create(ui.DiagnosticsGrantsSchema);

  const rows = await store.query<{ origin_computer_id: string }>(
    "SELECT origin_computer_id FROM diagnostics_grants WHERE owner_user_id=$1::uuid ORDER BY origin_computer_id",
    [store.owner],
  );

  return create(ui.DiagnosticsGrantsSchema, {
    grants: rows.map((row) => ({ originComputerId: row.origin_computer_id })),
  });
}

export async function setDiagnosticsGrant(core: GatewayCore, request: ui.DiagnosticsGrantRequest) {
  const store = core.computers?.store;
  const peer = await store?.computer(request.originComputerId);

  if (!store || !peer?.via_node_id || !["origin", "both"].includes(peer.relay_role))
    throw new ConnectError("Choose a computer shared through a relay", Code.InvalidArgument);
  await store.query(
    request.enabled
      ? `WITH changed AS (INSERT INTO diagnostics_grants(owner_user_id,origin_computer_id,via_node_id)
         VALUES($1::uuid,$2,$3) ON CONFLICT DO NOTHING RETURNING origin_computer_id)
         INSERT INTO audit_log(id,actor_user_id,action,target_type,details)
         SELECT gen_random_uuid(),$1::uuid,'diagnostics.grant','computer',jsonb_build_object('enabled',true,'origin',$2::text) FROM changed`
      : `WITH changed AS (DELETE FROM diagnostics_grants WHERE owner_user_id=$1::uuid AND origin_computer_id=$2
         RETURNING origin_computer_id)
         INSERT INTO audit_log(id,actor_user_id,action,target_type,details)
         SELECT gen_random_uuid(),$1::uuid,'diagnostics.grant','computer',jsonb_build_object('enabled',false,'origin',$2::text) FROM changed`,
    request.enabled ? [store.owner, peer.node_id, peer.via_node_id] : [store.owner, peer.node_id],
  );

  if (!request.enabled && core.computers)
    sendDiagnosticsInvalidation(core.computers, peer.via_node_id, {
      targetNodeId: peer.node_id,
      homeNodeId: core.computers.hello().nodeId,
    });

  return diagnosticsGrants(core);
}
