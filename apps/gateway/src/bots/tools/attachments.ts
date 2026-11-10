import { conversationFiles } from "../../core/bot-files.ts";
import { define, object } from "./shared.ts";

export const attachmentTools = [
  define(
    "list_attachments",
    "List attachment references in your current conversation. Pass ids as attachment_ids to start_thread or send_message. Never invent ids.",
    object({}),
    "Checking files",
    async ({ core, turn }) =>
      (await conversationFiles(core, turn)).map((a) => ({
        id: a.id,
        name: a.name,
        mime_type: a.mime_type,
        size_bytes: Number(a.size_bytes),
      })),
    "read",
  ),
];
