import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { AgentToolCall, AgentToolResult } from "@canopy/contracts";
import { PROJECT_SECRET_NAME_PATTERN } from "@canopy/domain";
import { Option, Schema } from "effect";
import type { WorkerConnection } from "../worker-link/index.ts";
import { failure, ok } from "./agent-bus-context.ts";
import { coreRun } from "./core-broadcast.ts";
import { coreState, describeError } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { loginAuthorized } from "./automation-permissions.ts";

/** Worker-internal: Agent Browser asks for a login lease. Harnesses cannot call this tool name. */
export const LEASE_PROJECT_LOGIN = "lease_project_login";

const Arguments = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(PROJECT_SECRET_NAME_PATTERN)),
      origin: Schema.String.check(Schema.isMaxLength(2048)),
      authorization: Schema.String.check(Schema.isMaxLength(128)),
    }),
  ),
);

export async function leaseProjectLogin(
  core: GatewayCore,
  call: AgentToolCall,
  connection: WorkerConnection,
): Promise<AgentToolResult> {
  if (call.cancelled) return failure(call.callId, "Cancelled");

  if (call.botId || call.connectorAccountId) return failure(call.callId, "Project logins belong to threads.");
  const args = Arguments(call.argumentsJson);

  if (Option.isNone(args)) return failure(call.callId, "Invalid login request");
  const origin = URL.parse(args.value.origin);

  if (!origin || origin.origin !== args.value.origin || !["http:", "https:"].includes(origin.protocol))
    return failure(call.callId, "Open an http or https page before entering a login.");

  try {
    const thread = await coreRun(core, (store) => store.thread(call.threadId));

    if (thread.owner_user_id !== core[coreState].options.userId || thread.worker_id !== connection.workerId)
      return failure(call.callId, "Thread not found");

    const authorized = () => loginAuthorized(core, connection, call, args.value.authorization, args.value.name);

    if (!authorized())
      return failure(call.callId, "Enter a project login only from an allowed Agent Browser login action.");

    const result = await core.secrets.leaseLogin(
      {
        callId: call.callId,
        threadId: call.threadId,
        turnId: call.turnId,
        itemId: call.itemId,
        ...(call.expiresAt && { expiresAt: timestampDate(call.expiresAt) }),
      },
      args.value.name,
      args.value.origin,
      connection,
      { id: args.value.authorization, live: authorized },
    );

    return ok(call.callId, result);
  } catch (cause) {
    return failure(call.callId, describeError(cause));
  }
}
