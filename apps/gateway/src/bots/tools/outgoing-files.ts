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
    "Send a file from this conversation workspace as a downloadable attachment in this Canopy conversation. Use its filename as path. The owner's attachment size/type limits apply. Optional caption is user-facing. This does not send files through connector accounts; those require their granted tools.",
    object({ path: str, caption: str }, ["path"]),
    "Sending an attachment",
    sendBotAttachment,
  ),
];
