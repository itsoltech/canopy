import { toJson, type JsonValue } from "@bufbuild/protobuf";
import { InputAttachmentSchema } from "@canopy/contracts";
import type { AttachmentLimits } from "@canopy/domain";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { AttachmentRejected, prepareAttachment } from "../attachments/prepare.ts";
import type { BotTurn } from "../bots/types.ts";
import type { CoreRuntime } from "../core/core-context.ts";
import {
  bindBotSlackAttachment,
  bindThreadSlackAttachment,
  lockSlackBotConversation,
  slackInputAttachment,
} from "../core/slack-attachment-store.ts";
import { allowedInboundSlackFile } from "../messengers/conversation-access.ts";
import { downloadSlackFile } from "../messengers/slack-files.ts";
import { SlackMessengerError, type SlackTransport } from "../messengers/slack-http.ts";
import { GatewayStore } from "../store/store.ts";
import { ConnectorFailure, type AccountRow, type ExecutionSource } from "./records.ts";

function failure(text: string): JsonValue {
  return { isError: true, content: [{ type: "text", text }] };
}

export function canDownloadSlackOnWorker(sql: SqlClient.SqlClient, workerId: string) {
  return sql`SELECT id FROM workers WHERE id=${workerId}::uuid AND revoked_at IS NULL AND archived_at IS NULL
    AND capabilities->>'agentToolAttachments'='true' AND coalesce(capabilities->>'attachmentsRoot','')<>''`.pipe(
    Effect.map((rows) => rows.length > 0),
  );
}

function downloadScope(source: ExecutionSource, accountId: string, fileId: string) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    if (source.threadId && source.workerId) {
      if (!(yield* canDownloadSlackOnWorker(sql, source.workerId)))
        return yield* Effect.fail(new ConnectorFailure("Update this worker to download Slack files."));

      return undefined;
    }

    if (!source.botId || !source.turnId || !source.botLease)
      return yield* Effect.fail(new ConnectorFailure("This Slack download requires an active bot turn."));

    const bot = (yield* sql<BotTurn & { supported: boolean; files: boolean }>`
      SELECT t.*, coalesce(w.capabilities->>'agentToolAttachments'='true',false) AS supported,
        b.configuration->>'files' IS DISTINCT FROM 'false' AS files
      FROM bot_turns t JOIN bots b ON b.id=t.bot_id JOIN bot_harness_turns h ON h.turn_id=t.id AND h.bot_id=b.id
      JOIN workers w ON w.id=h.worker_id WHERE t.id=${source.turnId}::uuid AND b.id=${source.botId}::uuid
        AND b.owner_user_id=${source.userId}::uuid AND b.deleted_at IS NULL AND b.archived_at IS NULL AND b.moved_to IS NULL
        AND t.status='running' AND t.lease_token=${source.botLease}::uuid AND t.lease_until>now() AND h.outcome IS NULL
        AND w.revoked_at IS NULL AND w.archived_at IS NULL`)[0];

    if (!bot) return yield* Effect.fail(new ConnectorFailure("This Slack download requires an active bot turn."));

    if (!bot.files) return yield* Effect.fail(new ConnectorFailure("Files are disabled for this bot."));

    if (!bot.supported) return yield* Effect.fail(new ConnectorFailure("Update this worker to download Slack files."));

    if (
      bot.conversation_id &&
      !(yield* allowedInboundSlackFile(sql, bot.bot_id, bot.conversation_id, accountId, fileId))
    )
      return yield* Effect.fail(new ConnectorFailure("This Slack file was not shared in the current conversation."));

    return bot;
  });
}

function assertDownloadAccess(source: ExecutionSource, account: AccountRow, fileId: string, turn?: BotTurn) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const store = yield* GatewayStore;
    const locked = yield* store.connectors.owned(source.userId, account.id, true);
    const current = yield* store.connectors.authorize(source);

    if (BigInt(locked.revision) !== BigInt(account.revision) || current.id !== account.id)
      return yield* Effect.fail(new ConnectorFailure("Slack access changed. Try again with a connected account."));

    if (turn) yield* lockSlackBotConversation(sql, turn);
    yield* downloadScope(source, account.id, fileId);
  });
}

function downloadError(error: Error | undefined): string {
  if (error instanceof ConnectorFailure || error instanceof AttachmentRejected) return error.message;

  if (error instanceof SlackMessengerError) {
    if (error.code === "missing_scope") return "Reconnect Slack with the Files: Read permission.";

    if (error.code === "file_too_large") return "This Slack file exceeds the Canopy attachment size limit.";

    if (error.kind === "retryable") return "Slack could not deliver the file. Try again later.";
  }

  return "Slack could not provide this file. Check that the connected Slack user can open it.";
}

export async function slackDownloadScope(
  runtime: CoreRuntime,
  source: ExecutionSource,
  account: AccountRow,
  fileId: string,
) {
  return runtime.runPromise(downloadScope(source, account.id, fileId));
}

export async function downloadConnectorSlackFile(input: {
  runtime: CoreRuntime;
  source: ExecutionSource;
  account: AccountRow;
  fileId: string;
  limits: AttachmentLimits;
  token: string;
  signal: AbortSignal;
  transport?: SlackTransport | undefined;
}): Promise<JsonValue> {
  const { runtime, source, account, fileId, limits, token, signal, transport } = input;

  try {
    const turn = await slackDownloadScope(runtime, source, account, fileId);
    const maxBytes = Math.min(limits.maxFileBytes, limits.maxMessageBytes);
    const file = await downloadSlackFile({ fileId, token, maxBytes, signal, ...(transport && { transport }) });
    const prepared = await prepareAttachment(file.name, file.data, { ...limits, maxFileBytes: maxBytes });
    const authorize = assertDownloadAccess(source, account, fileId, turn);

    signal.throwIfAborted();

    const attachment = turn
      ? slackInputAttachment(await bindBotSlackAttachment(runtime, source.userId, turn, fileId, prepared, authorize))
      : await bindThreadSlackAttachment(runtime, source, prepared, authorize);

    const text = attachment.path
      ? `Downloaded ${JSON.stringify(attachment.name)} from Slack to ${attachment.path}`
      : `Downloaded ${JSON.stringify(attachment.name)} from Slack. Use attachment_ids: ["${attachment.attachmentId}"] to forward this file.`;

    return { content: [{ type: "text", text }], canopy_attachment: toJson(InputAttachmentSchema, attachment) };
  } catch (error) {
    signal.throwIfAborted();

    return failure(downloadError(error instanceof Error ? error : undefined));
  }
}
