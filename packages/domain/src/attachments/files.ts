/**
 * Attachments of a message (docs/ui-api.md, "Załączniki"; docs/protocol.md, "Załączniki"): the name a file keeps,
 * where it lives on the worker, the limits, and the platform note that tells the agent about it.
 */

export type AttachmentKind = "image" | "file";

export interface AttachmentLimits {
  readonly maxFileBytes: number;
  readonly maxMessageBytes: number;
  readonly maxFiles: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFileBytes: 20 * 1024 ** 2,
  maxMessageBytes: 50 * 1024 ** 2,
  maxFiles: 10,
};

/** Longest name kept (characters); the extension survives shortening. */
const MAX_NAME = 120;

/**
 * The file name without directories, control characters or characters some systems refuse; never empty, never
 * "." or "..". The same name is used on the worker (inside the attachment's own directory) and in the UI.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "";

  let clean = base
    .normalize("NFC")
    // oxlint-disable-next-line no-control-regex -- the sanitizer strips C0/C1 control characters from file names on purpose.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");

  if ([...clean].length > MAX_NAME) {
    const dot = clean.lastIndexOf(".");
    const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
    clean =
      Array.from(clean.slice(0, clean.length - ext.length))
        .slice(0, MAX_NAME - ext.length)
        .join("")
        .trimEnd() + ext;
  }

  // Windows device names stay files only with something in front.
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(clean)) clean = `_${clean}`;

  return clean || "attachment";
}

/** The name with another extension (an image converted to JPEG or PNG). */
export function withExtension(name: string, ext: string): string {
  const dot = name.lastIndexOf(".");

  return `${dot > 0 ? name.slice(0, dot) : name}.${ext}`;
}

/**
 * Where an attachment lives on its worker: `<root>/<thread_id>/<attachment_id>/<name>` (separators of the worker's
 * OS). The root is the worker's (Hello.attachments_root), outside any repository, so files never show up in git.
 */
export function attachmentPath(root: string, os: string, threadId: string, attachmentId: string, name: string): string {
  const sep = os === "win32" || os === "windows" ? "\\" : "/";
  const base = root.endsWith(sep) && root.length > 1 ? root.slice(0, -1) : root;

  return [base, threadId, attachmentId, safeFileName(name)].join(sep);
}

export function formatSize(bytes: number | bigint): string {
  const value = Number(bytes);

  if (value < 1024) return `${value} B`;

  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;

  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}

export interface NotedAttachment {
  readonly name: string;
  readonly path: string;
  readonly mimeType: string;
  readonly sizeBytes: number | bigint;
  readonly kind: AttachmentKind;
  readonly width?: number;
  readonly height?: number;
}

/**
 * The platform note before the user's text: one line per file with its absolute path, type, size and (images) its
 * dimensions. No empty line inside: the UI separates the note from the message at the first empty line
 * (turn-origin.ts, "Full text the agent received"). The agent decides what to do with the files. `numbered`: the
 * user placed files in the text; each line says "Attachment N", the number of its "[Attachment N: name]" marker.
 */
export function attachmentsNote(attachments: readonly NotedAttachment[], numbered = false): string {
  const count = attachments.length === 1 ? "a file" : `${attachments.length} files`;
  const images = attachments.some((a) => a.kind === "image");

  const lines = attachments.map((a, i) => {
    const details = [
      a.mimeType,
      formatSize(a.sizeBytes),
      a.kind === "image" && a.width && a.height ? `${a.width}×${a.height} px` : "",
    ]
      .filter(Boolean)
      .join(", ");

    return `- ${numbered ? `Attachment ${i + 1}: ` : ""}${a.path} (${details})`;
  });

  return [
    `[canopy] The user attached ${count} to this message, saved on this machine.${numbered ? " Each [Attachment N: name] in the message marks where the user put that file." : ""} Read ${attachments.length === 1 ? "it" : "them"} as needed${images ? "; view_image shows you an image" : ""}:`,
    ...lines,
  ].join("\n");
}

/** What the model gets: the note, an empty line, the message (or just the note). */
export function withAttachmentsNote(note: string, message: string): string {
  return message.trim() ? `${note}\n\n${message}` : note;
}
