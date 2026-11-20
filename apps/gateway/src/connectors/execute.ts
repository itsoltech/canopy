import type { JsonValue } from "@bufbuild/protobuf";
import type { ConnectorTool } from "@canopy/contracts";
import type { AttachmentLimits, JsonObject } from "@canopy/domain";
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
import { downloadConnectorSlackFile, slackDownloadScope } from "./slack-download.ts";
import {
  SLACK_DOWNLOAD_ACTION,
  SLACK_DOWNLOAD_SUFFIX,
  slackDownloadFileId,
  slackDownloadName,
  slackDownloadTool,
  supportsSlackDownload,
} from "./slack-download-tool.ts";

interface ExecutionContext extends PermissionContext {
  messengerTransport: SlackTransport | undefined;
  attachmentLimits(): Promise<AttachmentLimits>;
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
  legacyFingerprint: string,
  signal: AbortSignal,
): Promise<JsonValue> {
  const { runtime, run } = context;
  const nativeDownload = supportsSlackDownload(account) && toolName === slackDownloadName(account);

  if (!nativeDownload && toolName.endsWith(SLACK_DOWNLOAD_SUFFIX))
    throw new ConnectorFailure("Connector tool is unavailable");
  const fileId = nativeDownload ? slackDownloadFileId(args) : undefined;

  if (nativeDownload && !fileId) return failure("Use a Slack file ID that starts with F.");
  const old = await run((s) => s.execution(callId));

  if (old) {
    if (old.fingerprint !== fingerprint && old.fingerprint !== legacyFingerprint)
      throw new ConnectorFailure("Connector call identity mismatch");

    if (fileId) {
      if (source.threadId) await checkConnectorTurn(runtime, source, true);
      await slackDownloadScope(runtime, source, account, fileId);
    }

    return old.result ?? failure("Outcome unknown after disconnect. Do not repeat a write without user confirmation.");
  }

  // Fresh annotations are authoritative for remote tools, never the worker's descriptor.
  const nativePost = account.connector_type === "slack" && toolName === slackPostName(account);

  const tool = nativeDownload
    ? slackDownloadTool(account)
    : nativePost
      ? slackPostTool(account)
      : (await context.catalog(source.userId, source.accountId)).find((t) => t.name === toolName);

  if (!tool || (!nativeDownload && tool.remoteName === SLACK_DOWNLOAD_ACTION))
    throw new ConnectorFailure("Connector tool is unavailable");

  if (nativePost && !slackPostChannel(args))
    return failure(
      "Slack needs a conversation ID, a message of at most 4,000 characters and a valid parent timestamp if replying.",
    );

  if (source.botId && source.readOnlyOnly && !tool.readOnly)
    throw new ConnectorFailure("The connector tool now requires approval. Ask the user before retrying.");

  const binding = source.threadId ? await connectorPermission(context, source, callId, tool, args, signal) : undefined;

  const dispatch = async () => {
    if (source.threadId) await checkConnectorTurn(runtime, source, tool.readOnly, !!binding);
    const current = await run((s) => s.authorize(source));
    const prepared = await prepareCall(context, source, current, tool, args, callId, signal, fileId);
    const claimed = await run((s) => s.claimExecution(callId, source, tool.remoteName, fingerprint, binding));

    if (!claimed) throw new ConnectorFailure("Connector call already started; outcome unknown. Do not repeat writes.");

    if (prepared.checkAccess) await prepared.checkAccess();

    if (source.threadId) await checkConnectorTurn(runtime, source, tool.readOnly, !!binding);
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
  fileId: string | undefined,
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

  if (fileId) {
    const token = connection.value.tokens?.access_token;

    if (!token) return { send: async () => failure("Reconnect the Slack account to download this file.") };

    return {
      send: async () =>
        downloadConnectorSlackFile({
          runtime: context.runtime,
          source,
          account: current,
          fileId,
          limits: await context.attachmentLimits(),
          token,
          signal,
          transport: context.messengerTransport,
        }),
    };
  }

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
