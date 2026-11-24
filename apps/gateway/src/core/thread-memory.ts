import { timestampDate } from "@bufbuild/protobuf/wkt";
import { create } from "@bufbuild/protobuf";
import { type AgentToolCall, AgentToolResultSchema } from "@canopy/contracts";
import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";
import { executeMemoryTool } from "../memory/tools.ts";
import { callerMode, isUuid } from "../store/agent-bus-queries.ts";
import { lockedOwnerModule } from "../store/module-access.ts";
import type { ThreadRow } from "../store/rows.ts";
import type { WorkerConnection } from "../worker-link/index.ts";
import { failure } from "./agent-bus-context.ts";
import { coreState } from "./core-context.ts";
import type { GatewayCore } from "./core.ts";
import { withTurnPermissionMutation } from "./turn-permission-state.ts";

const decodeArguments = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.JsonObject));

export async function threadMemoryCall(core: GatewayCore, call: AgentToolCall, connection: WorkerConnection) {
  const refused = () => failure(call.callId, "Memory is unavailable for this turn.");

  const {
    actions,
    options: { runtime, userId, instanceId },
  } = core[coreState];

  const { workerId, registrationEpoch } = connection;
  const deadline = call.expiresAt ? timestampDate(call.expiresAt).getTime() : Infinity;
  const live = () => Date.now() < deadline && connection.isOpen && core.link.connections.get(workerId) === connection;

  if (
    !live() ||
    registrationEpoch === undefined ||
    call.cancelled ||
    call.botId ||
    call.connectorAccountId ||
    ![call.callId, call.threadId, call.turnId].every(isUuid) ||
    call.argumentsJson.length > 80_000
  )
    return refused();

  try {
    const args = decodeArguments(call.argumentsJson);

    return await withTurnPermissionMutation(runtime, call.threadId, () =>
      actions.transaction(async () => {
        const access = await actions.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;

            if (!(yield* lockedOwnerModule(sql, userId, "threads"))) return;

            const [thread] = yield* sql<ThreadRow>`SELECT t.* FROM threads t
          JOIN projects p ON p.id=t.project_id AND p.owner_user_id=t.owner_user_id
          JOIN workers w ON w.id=t.worker_id JOIN worker_connections l ON l.worker_id=w.id
          JOIN turns u ON u.thread_id=t.id AND u.id=${call.turnId}::uuid
          WHERE t.id=${call.threadId}::uuid AND t.owner_user_id=${userId}::uuid
            AND t.worker_id=${workerId}::uuid AND t.runtime='worker' AND t.memory_audience=''
            AND l.instance_id=${instanceId} AND l.epoch=${registrationEpoch}::bigint
            AND (w.owner_user_id IS NULL OR w.owner_user_id=t.owner_user_id)
            AND w.revoked_at IS NULL AND w.archived_at IS NULL AND p.kind='project' AND p.archived_at IS NULL
            AND t.deleted_at IS NULL AND t.archived_at IS NULL AND t.rewind_pending_id IS NULL AND t.moved_to IS NULL
            AND u.status='running' AND u.rewind_id IS NULL FOR SHARE OF t,u,w,l,p`;

            if (!thread) return;

            const mode = yield* callerMode(sql, call, thread);

            return { projectId: thread.project_id, canWrite: mode !== "read_only" };
          }),
        );

        if (!access || !live()) return refused();
        const { projectId, canWrite } = access;

        const result = await executeMemoryTool(
          runtime,
          {
            ownerId: userId,
            scopes: [
              { kind: "worker", projectId, workerId },
              { kind: "project", projectId },
            ],
            source: { kind: "thread", id: call.threadId, turnId: call.turnId },
            canWrite,
          },
          call.toolName,
          args,
          call.callId,
          (effect) => actions.run(effect),
        );

        const json = JSON.stringify(result);

        return create(AgentToolResultSchema, {
          callId: call.callId,
          isError: "error" in result,
          content: json,
          resultJson: json,
        });
      }),
    );
  } catch {
    return refused();
  }
}
