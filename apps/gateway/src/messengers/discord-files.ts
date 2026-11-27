import type { DiscordBody } from "./discord-http.ts";
import { splitMessage } from "./provider.ts";
import type { OutboundFile, OutboundMessage } from "./types.ts";

/** Discord accepts at most ten files in one message. */
const filesPerMessage = 10;

export interface DiscordMessage {
  content: string;
  files: readonly OutboundFile[];
}

/** Splits a reply into messages: text parts first, files attached to the last part within the upload limit. */
export function discordMessages(message: OutboundMessage, partLength: number, maxBytes: number): DiscordMessage[] {
  const messages: DiscordMessage[] = splitMessage(message.text, partLength).map((content) => ({ content, files: [] }));
  let current = messages.pop() ?? { content: "", files: [] };
  let bytes = 0;

  for (const file of message.files ?? []) {
    if (current.files.length && (current.files.length === filesPerMessage || bytes + file.data.byteLength > maxBytes)) {
      messages.push(current);
      current = { content: "", files: [] };
      bytes = 0;
    }

    current = { ...current, files: [...current.files, file] };
    bytes += file.data.byteLength;
  }

  if (current.content || current.files.length) messages.push(current);

  return messages;
}

/** A multipart body: the JSON payload plus files referenced by their attachment index. */
export function discordForm(fields: DiscordBody, files: readonly OutboundFile[]) {
  const form = new FormData();
  const attachments = files.map((file, id) => ({ id, filename: file.name }));
  form.set("payload_json", JSON.stringify({ ...fields, attachments }));

  for (const [index, file] of files.entries())
    form.set(`files[${index}]`, new File([new Uint8Array(file.data)], file.name, { type: file.mimeType }));

  return form;
}
