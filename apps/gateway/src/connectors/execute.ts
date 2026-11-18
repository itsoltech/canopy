import type { JsonValue } from "@bufbuild/protobuf";
import type { ConnectorTool } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { withTurnPermissionMutation } from "../core/turn-permission-state.ts";
import { mcpCall } from "../bots/mcp.ts";
import type { McpConnection } from "../bots/types.ts";
import type { SlackTransport } from "../messengers/slack-http.ts";
import { connectorPermission, failed, type PermissionContext } from "./calls.ts";
import { redactConnector } from "./oauth.ts";
import {
  prepareSlackPost,
  SLACK_POST_ACTION,
  slackPostChannel,
  slackPostName,
  slackPostTool,
} from "./slack-post-tool.ts";
import { ConnectorFailure, type AccountRow, type Credentials, type ExecutionSource } from "./store.ts";
import { checkConnectorTurn } from "./turn-permissions.ts";

interface ExecutionContext extends PermissionContext {
  messengerTransport: SlackTransport | undefined;
  catalog(user: string, account: string): Promise<ConnectorTool[]>;
  connection(user: string, account: string): Promise<{ row: AccountRow; value: Credentials; server: McpConnection }>;
}

function failure(text: string): JsonValue {
  return { isError: true, content: [{ type: "text", text }] };
}

export async function executeConnector(
  context: ExecutionContext,
  source: ExecutionSource,
  account: AccountRow,
  callId: string,
  toolName: string,
  args: JsonObject,
  fingerprint: string,
  signal: AbortSignal,
): Promise<JsonValue> {
  const { runtime, run } = context;
  const old = await run((s) => s.execution(callId));

  if (old) {
    if (old.fingerprint !== fingerprint) throw new ConnectorFailure("Connector call identity mismatch");

    return old.result ?? failure("Outcome unknown after disconnect. Do not repeat a write without user confirmation.");
  }

  // Fresh annotations are authoritative for remote tools, never the worker's descriptor.
  const nativePost = account.connector_type === "slack" && toolName === slackPostName(account);

  const tool = nativePost
    ? slackPostTool(account)
    : (await context.catalog(source.userId, source.accountId)).find((t) => t.name === toolName);

  if (!tool) throw new ConnectorFailure("Connector tool is unavailable");

  if (nativePost && !slackPostChannel(args))
    return failure(
      "Slack needs a conversation ID, a message of at most 4,000 characters and a valid parent timestamp if replying.",
    );

  if (source.botId && source.readOnlyOnly && !tool.readOnly)
    throw new ConnectorFailure("The connector tool now requires approval. Ask the user before retrying.");

  if (source.threadId) await connectorPermission(context, source, callId, tool, args, signal);

  const dispatch = async () => {
    if (source.threadId) await checkConnectorTurn(runtime, source, tool.readOnly);
    const current = await run((s) => s.authorize(source));
    const prepared = await prepareCall(context, source, current, tool, args, callId, signal);
    const claimed = await run((s) => s.claimExecution(callId, source, tool.remoteName, fingerprint));

    if (!claimed) throw new ConnectorFailure("Connector call already started; outcome unknown. Do not repeat writes.");

    if (prepared.checkAccess) await prepared.checkAccess();

    if (source.threadId) await checkConnectorTurn(runtime, source, tool.readOnly);
    signal.throwIfAborted();

    return { completion: prepared.send() };
  };

  const started = source.threadId
    ? await withTurnPermissionMutation(runtime, source.threadId, dispatch)
    : await dispatch();

  let result: JsonValue;

  try {
    result = await started.completion;
  } catch {
    result = failure(
      "Connector call interrupted or failed; outcome may be unknown. Do not automatically retry writes.",
    );
  }

  await run((s) => s.finishExecution(callId, source, tool.remoteName, result, failed(result)));

  return result;
}

async function prepareCall(
  context: ExecutionContext,
  source: ExecutionSource,
  current: AccountRow,
  tool: ConnectorTool,
  args: JsonObject,
  callId: string,
  signal: AbortSignal,
): Promise<{ send(): Promise<JsonValue>; checkAccess?(): Promise<void> }> {
  if (tool.remoteName === SLACK_POST_ACTION) {
    const sender = await context.run((s) => s.slackMessagingSender(current));

    if (!sender)
      return { send: async () => failure("Slack messaging is disconnected. Connect it in Settings → Connectors.") };

    const send = await prepareSlackPost(
      context.runtime,
      source.userId,
      sender.id,
      args,
      callId,
      signal,
      context.messengerTransport,
    );

    return {
      send,
      checkAccess: async () => {
        const authorized = await context.run((s) => s.authorize(source));
        const active = await context.run((s) => s.slackMessagingSender(authorized));

        if (active?.id !== sender.id || BigInt(active.revision) !== BigInt(sender.revision))
          throw new ConnectorFailure("Slack messaging changed. Check the connected account and send again.");
      },
    };
  }

  const connection = await context.connection(source.userId, source.accountId);

  if (BigInt(current.revision) !== BigInt(connection.row.revision))
    throw new ConnectorFailure("Connector changed; try again");

  return {
    send: async () => {
      const response = await mcpCall(
        connection.server,
        { name: tool.name, description: tool.description, parameters: {}, source: "mcp", remoteName: tool.remoteName },
        args,
        signal,
      );

      return JSON.parse(redactConnector(JSON.stringify(response), connection.value));
    },
  };
}
