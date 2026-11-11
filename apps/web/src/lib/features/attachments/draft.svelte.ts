import { create } from "@bufbuild/protobuf";
import { MentionKind, MentionSchema, ui, type Mention } from "@canopy/contracts";
import { DEFAULT_ATTACHMENT_LIMITS, extensionOf, formatSize, type AttachmentLimits } from "@canopy/domain";
import { isJsonObject, isString, type JsonValue } from "#lib/shared/json.ts";
import { decode } from "#lib/shared/wire.ts";

/**
 * The files a message is about to carry (docs/ui-api.md, "Załączniki"). Each file uploads as soon as it is added
 * (POST api/attachments, with progress), so sending only names the uploaded ids. The checks here (size, count,
 * total, programs) only save a round trip and say why at once; the gateway decides (it types files by content).
 *
 * In a composer with a text field each file is a badge in the text (docs/ui-api.md, "Załączniki w tekście"): the
 * badge is an ATTACHMENT mention named by the file's `key`. `place` follows the badges the text holds: a file whose
 * badge is gone stays here, out of the message, so Undo can bring the badge and the file back together. Without
 * `placing` (a composer with no badges) every file goes.
 */

export type DraftStatus = "uploading" | "ready" | "failed";

export interface DraftFile {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  /** The browser says it is an image: a local preview while it uploads. */
  readonly image: boolean;
  /** Object URL of the local file (images only); revoked on removal. */
  readonly localUrl: string | undefined;
  status: DraftStatus;
  /** 0..1 while uploading. */
  progress: number;
  error: string | undefined;
  /** What the gateway made of it. */
  attachment: ui.Attachment | undefined;
  contextScope?: string | undefined;
}

/** Native programs: refused by the gateway anyway, said here before the upload. */
const PROGRAMS: ReadonlySet<string> = new Set([
  "exe",
  "dll",
  "msi",
  "com",
  "scr",
  "sys",
  "so",
  "dylib",
  "app",
  "msix",
  "appx",
]);

export function limitsOf(limits: ui.AttachmentLimits | undefined): AttachmentLimits {
  if (!limits || limits.maxFileBytes === 0n) return DEFAULT_ATTACHMENT_LIMITS;

  return {
    maxFileBytes: Number(limits.maxFileBytes),
    maxMessageBytes: Number(limits.maxMessageBytes),
    maxFiles: limits.maxFiles,
  };
}

const uploadFailure = (status: number): string =>
  status === 413 ? "The file is too large." : `Upload failed (${status}).`;

export class AttachmentDraft {
  files = $state<DraftFile[]>([]);
  /** Keys of the files with a badge in the text; undefined: the composer has no badges, every file goes. */
  placed = $state<ReadonlySet<string> | undefined>(undefined);
  /** Why the last added files were not taken (shown until the next change). */
  notice = $state<string | undefined>(undefined);
  readonly #limits: () => AttachmentLimits;
  readonly #uploads = new Map<string, XMLHttpRequest>();

  constructor(
    limits: () => AttachmentLimits = () => DEFAULT_ATTACHMENT_LIMITS,
    readonly options: { botId?: string; imagesOnly?: boolean; onUploaded?: () => void } = {},
  ) {
    this.#limits = limits;
  }

  /** The files that go with the message (with their badge, in a composer that places them). */
  get attached(): DraftFile[] {
    const placed = this.placed;

    return placed ? this.files.filter((f) => placed.has(f.key)) : this.files;
  }

  get uploading(): boolean {
    return this.attached.some((f) => f.status === "uploading");
  }

  get failed(): boolean {
    return this.attached.some((f) => f.status === "failed");
  }

  /** Ids to send: every file uploaded, none failed or still on its way. */
  get ids(): string[] {
    return this.attached.flatMap((f) => (f.attachment ? [f.attachment.id] : []));
  }

  get ready(): boolean {
    return this.attached.length > 0 && !this.uploading && !this.failed;
  }

  file(key: string): DraftFile | undefined {
    return this.files.find((f) => f.key === key);
  }

  /** Accept a context file prepared by the gateway through the same draft and limits as uploads. */
  accept(attachment: ui.Attachment, contextScope?: string): DraftFile {
    const limits = this.#limits();

    if (
      this.attached.length >= limits.maxFiles ||
      Number(attachment.sizeBytes) > limits.maxFileBytes ||
      this.attached.reduce((sum, f) => sum + f.size, 0) + Number(attachment.sizeBytes) > limits.maxMessageBytes
    )
      throw new Error("Remove an attachment before adding this context.");

    if (
      attachment.name.startsWith("github-pr-") &&
      this.attached.filter((f) => f.name.startsWith("github-pr-")).length >= 3
    )
      throw new Error("Attach up to 3 pull request contexts.");

    const file: DraftFile = {
      key: crypto.randomUUID(),
      contextScope,
      name: attachment.name,
      size: Number(attachment.sizeBytes),
      image: false,
      localUrl: undefined,
      status: "ready",
      progress: 1,
      error: undefined,
      attachment,
    };

    this.files = [...this.files, file];

    return file;
  }

  /** The badges the text holds now (keys of ATTACHMENT mentions). */
  place(mentions: readonly Mention[]): void {
    const keys = new Set(mentions.flatMap((m) => (m.kind === MentionKind.ATTACHMENT ? [m.name] : [])));
    const current = this.placed;

    if (current && current.size === keys.size && [...keys].every((k) => current.has(k))) return;
    this.placed = keys;
    this.notice = undefined;
  }

  /** The mentions to send: each badge names its uploaded file's id; a badge of a file not here goes. */
  wire(mentions: readonly Mention[]): Mention[] {
    return mentions.flatMap((m) => {
      if (m.kind !== MentionKind.ATTACHMENT) return [m];
      const id = this.file(m.name)?.attachment?.id;

      return id ? [create(MentionSchema, { ...m, name: id })] : [];
    });
  }

  /** Why the message cannot go with its files yet (undefined: it can). */
  get blocker(): string | undefined {
    if (this.uploading) return "Wait for the files to upload.";

    if (this.failed) return "Remove the files that could not be attached.";

    return undefined;
  }

  /** Takes the files within the limits (says why not for the rest); returns the ones taken. */
  add(list: Iterable<File>): DraftFile[] {
    const limits = this.#limits();
    const problems: string[] = [];
    const added: DraftFile[] = [];

    for (const file of list) {
      const name =
        file.name ||
        (file.type.startsWith("image/") ? `pasted-image.${file.type.split("/")[1] ?? "png"}` : "attachment");

      const going = [...this.attached, ...added];
      const total = going.reduce((sum, f) => sum + f.size, 0) + file.size;

      if (
        this.options.imagesOnly &&
        !/^image\/(png|jpeg|gif|webp)$/.test(file.type) &&
        !(!file.type && /\.(png|jpe?g|gif|webp)$/i.test(name))
      )
        problems.push("Attach a PNG, JPEG, GIF or WebP image.");
      else if (going.length >= limits.maxFiles) problems.push(`Up to ${limits.maxFiles} files go with one message.`);
      else if (file.size === 0) problems.push(`${name} is empty.`);
      else if (file.size > limits.maxFileBytes)
        problems.push(`${name} is ${formatSize(file.size)}; files can be up to ${formatSize(limits.maxFileBytes)}.`);
      else if (total > limits.maxMessageBytes)
        problems.push(`Together the files would be over ${formatSize(limits.maxMessageBytes)}.`);
      else if (PROGRAMS.has(extensionOf(name))) problems.push(`${name} is a program; programs cannot be attached.`);
      else {
        added.push(this.#start(file, name));
        continue;
      }
    }

    this.notice = problems.length > 0 ? [...new Set(problems)].join(" ") : undefined;

    return added;
  }

  /** After sending: the files went with the message (the chat shows them from now on). */
  clear(): void {
    for (const file of this.files) if (file.localUrl) URL.revokeObjectURL(file.localUrl);

    for (const upload of this.#uploads.values()) upload.abort();
    this.#uploads.clear();
    this.files = [];
    this.notice = undefined;
  }

  #start(file: File, name: string): DraftFile {
    const key = crypto.randomUUID();
    const image = /^image\/(png|jpeg|gif|webp)$/.test(file.type);

    // What the badge needs at once (the reactive copy in `files` follows the upload).
    const added: DraftFile = {
      key,
      name,
      size: file.size,
      image,
      localUrl: image ? URL.createObjectURL(file) : undefined,
      status: "uploading",
      progress: 0,
      error: undefined,
      attachment: undefined,
    };

    this.files.push(added);
    const entry = () => this.files.find((f) => f.key === key);
    const request = new XMLHttpRequest();
    this.#uploads.set(key, request);
    request.open("POST", "/api/attachments");
    request.setRequestHeader("x-file-name", encodeURIComponent(name));

    if (this.options.botId) request.setRequestHeader("x-bot-id", this.options.botId);
    request.setRequestHeader("x-requested-with", "canopy");
    request.setRequestHeader("content-type", "application/octet-stream");
    request.responseType = "json";
    request.upload.onprogress = (event) => {
      const draft = entry();

      if (draft && event.lengthComputable) draft.progress = event.loaded / event.total;
    };

    request.onload = () => {
      this.#uploads.delete(key);
      const draft = entry();

      if (!draft) return;

      if (request.status >= 200 && request.status < 300) {
        draft.attachment = decode(ui.AttachmentSchema, request.response);
        draft.progress = 1;
        draft.status = "ready";
        this.options.onUploaded?.();
      } else {
        // `responseType` is "json": the body as JSON, or null.
        const response: JsonValue = request.response;
        const message = isJsonObject(response) ? response["message"] : undefined;
        draft.status = "failed";
        draft.error = isString(message) ? message : uploadFailure(request.status);
      }
    };

    request.onerror = () => {
      this.#uploads.delete(key);
      const draft = entry();

      if (draft) Object.assign(draft, { status: "failed", error: "Upload failed: the connection was lost." });
    };

    request.send(file);

    return added;
  }
}

/** Files from a drop or paste (images pasted from the clipboard, e.g. screenshots, come as files too). */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];

  if (data.files.length > 0) return [...data.files];

  return [...data.items].flatMap((item) =>
    item.kind === "file" ? [item.getAsFile()].filter((f): f is File => f !== null) : [],
  );
}
