import { sendBotAttachment } from "../../core/bot-send-attachment.ts";
import { botFileCommand } from "./workspace.ts";
import { define, object, str } from "./shared.ts";

export const outgoingFileTools = [
  define(
    "download_file",
    "Download a public HTTP/HTTPS file into this conversation workspace, up to 50 MiB and 60 seconds. No credentials or private network access. Optional filename has no folders. This does not send the file; use send_attachment after downloading.",
    object({ url: str, filename: str }, ["url"]),
    "Downloading a conversation file",
    async (ctx) => {
      // Network I/O must not hold the bot/turn row locks and block its lease heartbeat.
      const result = await botFileCommand(ctx, "download");

      return ctx.action(async () => result);
    },
  ),
  define(
    "send_attachment",
    "Send a file to the current conversation. Provide attachment_id to share an existing message attachment from this conversation, or path with a filename from its workspace. In a private Canopy conversation the optional caption appears with the file. For Slack, Telegram or Discord, the file goes with your final reply, where you can describe it. The owner's attachment limits and the provider's file size limit apply.",
    object({ path: str, attachment_id: str, caption: str }),
    "Sending an attachment",
    sendBotAttachment,
  ),
];
