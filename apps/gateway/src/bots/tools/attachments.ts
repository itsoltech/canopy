import { conversationFiles } from "../../core/bot-files.ts";
import { define, object } from "./shared.ts";

export const attachmentTools = [
  define(
    "list_attachments",
    "List attachment IDs, filenames, media types and sizes in your current conversation. Use these IDs when forwarding attachments.",
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
