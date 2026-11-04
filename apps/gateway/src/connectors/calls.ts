import { create, type JsonValue } from "@bufbuild/protobuf";
import {
  AgentToolResultSchema,
  InteractionKind,
  InteractionRequestSchema,
  type AgentToolCall,
  type ConnectorTool,
  type ui,
} from "@canopy/contracts";
import { isJsonObject } from "../bots/json.ts";
import type { JsonObject } from "@canopy/domain";
import { Effect } from "effect";
import { GatewayStore } from "../store/store.ts";
import type { CoreRuntime } from "../core/core.ts";
import { connectorType } from "./catalog.ts";
import { ConnectorFailure, type ConnectorStore, type ExecutionSource } from "./store.ts";
import { redactConnector } from "./oauth.ts";

/** MCP tool results report failure in-band. */
export const failed = (result: JsonValue) => isJsonObject(result) && Boolean(result["isError"]);

export interface PermissionContext {
  runtime: CoreRuntime;
  run<A, E>(use: (store: ConnectorStore) => Effect.Effect<A, E, never>): Promise<A>;
  interaction(interaction: ui.Interaction): Promise<void>;
  stopped(): boolean;
}

/**
 * A thread's connector call that may write: allowed by its permission mode, or asked as a permission interaction
 * and awaited until the user answers, the turn ends or the gateway stops.
 */
export async function connectorPermission(
  context: PermissionContext,
  source: ExecutionSource,
  callId: string,
  tool: ConnectorTool,
  args: JsonObject,
  signal: AbortSignal,
): Promise<void> {
  const facts = await context.runtime.runPromise(
    GatewayStore.use((s) =>
      Effect.gen(function* () {
        const thread = yield* s.thread(source.threadId!);
        const turn = yield* s.runningTurn(thread.id);

        if (!turn || source.turnId !== turn.id)
          return yield* Effect.fail(new ConnectorFailure("Connector call requires the active turn"));

        return { mode: turn.permission_mode || thread.settings.permissionMode || "ASK", turnId: turn.id };
      }),
    ),
  );

  if (tool.readOnly) return;

  if (facts.mode === "READ_ONLY")
    throw new ConnectorFailure("Read-only threads cannot call connector tools that may write");

  if (facts.mode === "FULL_AUTO") return;

  const credentials = await context.run((s) =>
    s.owned(source.userId, source.accountId).pipe(Effect.flatMap(s.credentials)),
  );

  const interaction = await context.runtime.runPromise(
    GatewayStore.use((s) =>
      s.recordInteraction(
        create(InteractionRequestSchema, {
          requestId: callId,
          threadId: source.threadId!,
          turnId: facts.turnId,
          itemId: callId,
          kind: InteractionKind.PERMISSION,
          toolName: tool.name,
          requestJson: redactConnector(
            JSON.stringify({
              tool_name: `${connectorType(tool.connectorType)?.name} · ${tool.accountName} · ${tool.remoteName}`,
              description: "Allow this connector action?",
              connector_account_id: tool.accountId,
              input: args,
            }),
            credentials,
          ),
        }),
      ),
    ),
  );

  await context.interaction(interaction);

  for (;;) {
    signal.throwIfAborted();

    if (context.stopped()) throw new ConnectorFailure("Gateway stopped");
    const answer = await context.runtime.runPromise(GatewayStore.use((s) => s.interactionAnswer(callId)));

    if (answer) {
      if (!answer.answer.allow || answer.answer.cancelled)
        throw new ConnectorFailure("The user declined this connector action. Do not retry it.");

      return;
    }

    const running = await context.runtime.runPromise(GatewayStore.use((s) => s.runningTurn(source.threadId!)));

    if (running?.id !== facts.turnId) throw new ConnectorFailure("The turn ended before connector approval");
    await Bun.sleep(250);
  }
}

/** A connector call from an agent thread (agent bus): checked against the thread's worker, answered in-band. */
export async function handleConnectorCall(
  context: Pick<PermissionContext, "runtime" | "run"> & {
    call(
      source: ExecutionSource,
      callId: string,
      toolName: string,
      args: JsonObject,
      signal: AbortSignal,
    ): Promise<JsonValue>;
  },
  request: AgentToolCall,
  workerId: string,
) {
  let source: ExecutionSource | undefined;

  try {
    if (!request.connectorAccountId || request.argumentsJson.length > 100_000)
      throw new ConnectorFailure("Invalid connector call");
    const thread = await context.runtime.runPromise(GatewayStore.use((s) => s.thread(request.threadId)));

    if (thread.worker_id !== workerId) throw new ConnectorFailure("Connector access denied");
    source = {
      userId: thread.owner_user_id,
      accountId: request.connectorAccountId,
      workerId,
      threadId: thread.id,
      turnId: request.turnId,
    };
    const args: JsonValue = JSON.parse(request.argumentsJson);

    if (!isJsonObject(args)) throw new ConnectorFailure("Invalid connector arguments");

    const result = await context.call(source, request.callId, request.toolName, args, AbortSignal.timeout(300_000));
    const isError = failed(result);

    return create(AgentToolResultSchema, {
      callId: request.callId,
      isError,
      content: JSON.stringify(result),
      resultJson: JSON.stringify(result),
    });
  } catch {
    if (source) await context.run((s) => s.audit(source!, request.toolName, "denied_or_failed")).catch(() => undefined);

    const message =
      "Connector call refused or failed. Check account access, connection status, permission mode and approval. No automatic write retry.";

    return create(AgentToolResultSchema, {
      callId: request.callId,
      isError: true,
      content: message,
      resultJson: JSON.stringify({ error: message }),
    });
  }
}
