import { ownerModuleEnabled, moduleDisabledMessage } from "../store/module-access.ts";
import { Effect } from "effect";
import type { CoreRuntime } from "../core/core-context.ts";
import { readTurnPermissions } from "../core/turn-permission-state.ts";
import { GatewayStore } from "../store/store.ts";
import { ConnectorFailure, type ExecutionSource } from "./store.ts";

export function connectorTurn(runtime: CoreRuntime, source: ExecutionSource) {
  const { threadId, turnId } = source;

  if (!threadId || !turnId) throw new ConnectorFailure("Connector call requires the active turn");

  return readTurnPermissions(runtime, threadId, turnId, () =>
    runtime.runPromise(
      GatewayStore.use((s) =>
        Effect.gen(function* () {
          if (!(yield* ownerModuleEnabled(source.userId, "threads")))
            return yield* Effect.fail(new ConnectorFailure(moduleDisabledMessage("threads")));
          const thread = yield* s.thread(threadId);
          const turn = yield* s.runningTurn(threadId);

          if (
            thread.owner_user_id !== source.userId ||
            thread.archived_at ||
            thread.rewind_pending_id ||
            !turn ||
            turn.id !== turnId ||
            turn.rewind_id
          )
            return yield* Effect.fail(new ConnectorFailure("Connector call requires the active turn"));

          return { mode: turn.permission_mode || thread.settings.permissionMode || "ASK", turnId: turn.id };
        }),
      ),
    ),
  );
}

/** An earlier approval cannot override a mode restriction applied while the call was waiting. */
export async function checkConnectorTurn(
  runtime: CoreRuntime,
  source: ExecutionSource,
  readOnly: boolean,
): Promise<void> {
  const current = await connectorTurn(runtime, source);

  if (!readOnly && current.mode === "READ_ONLY")
    throw new ConnectorFailure("Read-only threads cannot call connector tools that may write");
}
