import { isMessage, type DescMethod, type Message } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Code, ConnectError } from "@connectrpc/connect";
import { THREAD_AUDIENCE_ERROR } from "../core/bot-thread-audience.ts";
import { relayCallback } from "./relay.ts";
import { AGENT_MEMORY_AUDIENCE } from "./capabilities.ts";
import type { Connection } from "./runtime-context.ts";
import type { ComputerStore } from "./store.ts";

/** Check the authenticated inbound connection on every leg. An updated relay has already checked its own caller. */
export function requireAgentOrigin(connection: Connection, method: DescMethod, request: Message) {
  if (connection.capabilities?.has(AGENT_MEMORY_AUDIENCE)) return;

  const agentCall = method.name === "CallAgentBus" && !relayCallback(method, request);

  const botAccess =
    (isMessage(request, ui.GetOverviewRequestSchema) ||
      isMessage(request, ui.GetThreadRequestSchema) ||
      isMessage(request, ui.WatchThreadRequestSchema) ||
      isMessage(request, ui.ListThreadsRequestSchema) ||
      isMessage(request, ui.AnswerInteractionRequestSchema)) &&
    request.botThreadAccess;

  if (agentCall || botAccess)
    throw new ConnectError(
      "Update Canopy on the sending computer and any relay to use linked agents with this computer.",
      Code.FailedPrecondition,
    );
}

/** The bot route carries an interaction id. Only the destination can resolve the actual thread. */
export async function requireLinkedAnswerAudience(store: ComputerStore, request: Message) {
  if (!isMessage(request, ui.AnswerInteractionRequestSchema) || !request.botThreadAccess) return;

  const allowed = await store.query(
    `SELECT 1 FROM interaction_requests i JOIN threads t ON t.id=i.thread_id
     WHERE i.id=$1::uuid AND t.owner_user_id=$2::uuid AND t.memory_audience='' AND t.deleted_at IS NULL AND t.moved_to IS NULL`,
    [request.requestId, store.owner],
  );

  if (!allowed.length) throw new ConnectError(THREAD_AUDIENCE_ERROR, Code.PermissionDenied);
}
