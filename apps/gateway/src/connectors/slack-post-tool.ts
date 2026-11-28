import { create, type JsonValue } from "@bufbuild/protobuf";
import { ConnectorToolSchema, type ConnectorTool } from "@canopy/contracts";
import type { JsonObject } from "@canopy/domain";
import { Option, Schema } from "effect";
import { MessengerStore } from "../messengers/store.ts";
import { postSlackMessage, SlackMessengerError, type SlackTransport } from "../messengers/slack.ts";
import type { CoreRuntime } from "../core/core-context.ts";
import { ConnectorFailure, type AccountRow } from "./store.ts";
import {
  SLACK_DOWNLOAD_ACTION,
  SLACK_DOWNLOAD_SUFFIX,
  slackDownloadTool,
  supportsSlackDownload,
} from "./slack-download-tool.ts";

import { githubRepositoryTools } from "./github-repository-tools.ts";

export const SLACK_POST_ACTION = "canopy.slack.post_message";

type ToolAccount = Pick<
  AccountRow,
  "id" | "name" | "connector_type" | "namespace" | "auth_kind" | "github_allow_writes"
>;

const channelPattern = /^[CDG][A-Z0-9]{1,31}$/;
const timestampPattern = /^\d{1,16}\.\d{1,16}$/;
const maxLength = 4000;

const SlackPost = Schema.Struct({
  channel: Schema.String.check(Schema.isPattern(channelPattern)),
  reply_to: Schema.optionalKey(Schema.String.check(Schema.isPattern(timestampPattern))),
  message: Schema.String.check(Schema.isMaxLength(maxLength), Schema.isPattern(/\S/)),
});

const decode = Schema.decodeUnknownSync(SlackPost, { onExcessProperty: "error" });
const decodeOption = Schema.decodeUnknownOption(SlackPost, { onExcessProperty: "error" });

export const slackPostName = (row: ToolAccount) => `${row.namespace.slice(0, 39)}__canopy_post_slack`;

export function slackPostTool(row: ToolAccount) {
  return create(ConnectorToolSchema, {
    accountId: row.id,
    accountName: row.name,
    connectorType: "slack",
    name: slackPostName(row),
    remoteName: SLACK_POST_ACTION,
    description: `Slack · ${row.name}: Post a message immediately as the Canopy Slack app. Use when the owner authorized sending to this destination, including standing instructions for follow-ups. Canopy checks approval. Use a Slack conversation ID the app can post to. When replying in a Slack thread, set reply_to to its parent message timestamp. Report success only when the tool returns a message link.`,
    inputSchemaJson: JSON.stringify({
      type: "object",
      properties: {
        channel: { type: "string", pattern: channelPattern.source, description: "Slack conversation ID" },
        reply_to: { type: "string", pattern: timestampPattern.source, description: "Parent message timestamp" },
        message: {
          type: "string",
          maxLength,
          description:
            "Message in Markdown. To deliberately mention a person, use <@USER_ID> with their Slack user ID.",
        },
      },
      required: ["channel", "message"],
      additionalProperties: false,
    }),
  });
}

export function connectorToolCatalog(
  row: ToolAccount,
  remote: readonly ConnectorTool[],
  slackPost: boolean,
  slackDownload: boolean,
) {
  if (row.connector_type === "github_repository") return githubRepositoryTools(row);

  const tools = remote.flatMap((tool) =>
    tool.remoteName === SLACK_POST_ACTION ||
    tool.remoteName === SLACK_DOWNLOAD_ACTION ||
    tool.name.endsWith(SLACK_DOWNLOAD_SUFFIX) ||
    (row.connector_type === "slack" && tool.name === slackPostName(row))
      ? []
      : [{ ...tool, accountName: row.name }],
  );

  if (slackPost && row.connector_type === "slack") tools.unshift(slackPostTool(row));

  if (slackDownload && supportsSlackDownload(row)) tools.unshift(slackDownloadTool(row));

  return tools;
}

export function slackPostChannel(args: JsonObject) {
  return Option.getOrUndefined(decodeOption(args))?.channel;
}

export async function prepareSlackPost(
  runtime: CoreRuntime,
  owner: string,
  senderId: string,
  args: JsonObject,
  callId: string,
  signal: AbortSignal,
  transport?: SlackTransport,
) {
  const input = decode(args);
  const credentials = await runtime.runPromise(MessengerStore.use((s) => s.credentials(owner, senderId, transport)));

  return async (): Promise<JsonValue> => {
    try {
      const sent = await postSlackMessage(
        credentials,
        {
          id: callId,
          channelId: input.channel,
          text: input.message,
          ...(input.reply_to && { threadId: input.reply_to }),
        },
        signal,
        transport,
      );

      if (sent.channelId !== input.channel || !timestampPattern.test(sent.messageId))
        throw new ConnectorFailure("Unexpected Slack message receipt");
      const url = `https://app.slack.com/archives/${sent.channelId}/p${sent.messageId.replace(".", "")}`;

      return { content: [{ type: "text", text: `Posted in Slack as Canopy. ${url}` }] };
    } catch (error) {
      if (!(error instanceof SlackMessengerError) || error.kind === "unknown_write") throw error;

      const text =
        error.kind === "retryable"
          ? "Slack limited requests. The message was not posted. Try again later."
          : "Slack refused the message. Check the destination and the Canopy app’s access.";

      return { isError: true, content: [{ type: "text", text }] };
    }
  };
}
