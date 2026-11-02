import { ui } from "@open-agents/contracts";
import { DEFAULT_ATTACHMENT_LIMITS, extensionOf, formatSize, type AttachmentLimits } from "@open-agents/domain";
import { decode } from "#lib/shared/wire.ts";

/**
 * The files a message is about to carry (docs/ui-api.md, "Załączniki"). Each file uploads as soon as it is added
 * (POST api/attachments, with progress), so sending only names the uploaded ids. The checks here (size, count,
 * total, programs) only save a round trip and say why at once; the gateway decides (it types files by content).
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
}

/** Native programs: refused by the gateway anyway, said here before the upload. */
const PROGRAMS: ReadonlySet<string> = new Set(["exe", "dll", "msi", "com", "scr", "sys", "so", "dylib", "app", "msix", "appx"]);

export function limitsOf(limits: ui.AttachmentLimits | undefined): AttachmentLimits {
  if (!limits || limits.maxFileBytes === 0n) return DEFAULT_ATTACHMENT_LIMITS;
  return { maxFileBytes: Number(limits.maxFileBytes), maxMessageBytes: Number(limits.maxMessageBytes), maxFiles: limits.maxFiles };
}

export class AttachmentDraft {
  files = $state<DraftFile[]>([]);
  /** Why the last added files were not taken (shown until the next change). */
  notice = $state<string | undefined>(undefined);
  readonly #limits: () => AttachmentLimits;
  readonly #uploads = new Map<string, XMLHttpRequest>();

  constructor(limits: () => AttachmentLimits = () => DEFAULT_ATTACHMENT_LIMITS) {
    this.#limits = limits;
  }

  get uploading(): boolean {
    return this.files.some((f) => f.status === "uploading");
  }

  get failed(): boolean {
    return this.files.some((f) => f.status === "failed");
  }

  /** Ids to send: every file uploaded, none failed or still on its way. */
  get ids(): string[] {
    return this.files.flatMap((f) => (f.attachment ? [f.attachment.id] : []));
  }

  get ready(): boolean {
    return this.files.length > 0 && !this.uploading && !this.failed;
  }

  /** Why the message cannot go with its files yet (undefined: it can). */
  get blocker(): string | undefined {
    if (this.uploading) return "Wait for the files to upload.";
    if (this.failed) return "Remove the files that could not be attached.";
    return undefined;
  }

  add(list: Iterable<File>): void {
    const limits = this.#limits();
    const problems: string[] = [];
    for (const file of list) {
      const name = file.name || (file.type.startsWith("image/") ? `pasted-image.${file.type.split("/")[1] ?? "png"}` : "attachment");
      const total = this.files.reduce((sum, f) => sum + f.size, 0) + file.size;
      if (this.files.length >= limits.maxFiles) problems.push(`Up to ${limits.maxFiles} files go with one message.`);
      else if (file.size === 0) problems.push(`${name} is empty.`);
      else if (file.size > limits.maxFileBytes) problems.push(`${name} is ${formatSize(file.size)}; files can be up to ${formatSize(limits.maxFileBytes)}.`);
      else if (total > limits.maxMessageBytes) problems.push(`Together the files would be over ${formatSize(limits.maxMessageBytes)}.`);
      else if (PROGRAMS.has(extensionOf(name))) problems.push(`${name} is a program; programs cannot be attached.`);
      else {
        this.#start(file, name);
        continue;
      }
    }
    this.notice = problems.length > 0 ? [...new Set(problems)].join(" ") : undefined;
  }

  remove(key: string): void {
    this.#uploads.get(key)?.abort();
    this.#uploads.delete(key);
    const file = this.files.find((f) => f.key === key);
    if (file?.localUrl) URL.revokeObjectURL(file.localUrl);
    this.files = this.files.filter((f) => f.key !== key);
    this.notice = undefined;
  }

  /** After sending: the files went with the message (the chat shows them from now on). */
  clear(): void {
    for (const file of this.files) if (file.localUrl) URL.revokeObjectURL(file.localUrl);
    for (const upload of this.#uploads.values()) upload.abort();
    this.#uploads.clear();
    this.files = [];
    this.notice = undefined;
  }

  #start(file: File, name: string): void {
    const key = crypto.randomUUID();
    const image = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
    this.files.push({ key, name, size: file.size, image, localUrl: image ? URL.createObjectURL(file) : undefined, status: "uploading", progress: 0, error: undefined, attachment: undefined });
    const entry = () => this.files.find((f) => f.key === key);
    const request = new XMLHttpRequest();
    this.#uploads.set(key, request);
    request.open("POST", "/api/attachments");
    request.setRequestHeader("x-file-name", encodeURIComponent(name));
    request.setRequestHeader("x-requested-with", "open-agents");
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
      } else {
        const message = (request.response as { message?: unknown } | null)?.message;
        draft.status = "failed";
        draft.error = typeof message === "string" ? message : request.status === 413 ? "The file is too large." : `Upload failed (${request.status}).`;
      }
    };
    request.onerror = () => {
      this.#uploads.delete(key);
      const draft = entry();
      if (draft) Object.assign(draft, { status: "failed", error: "Upload failed: the connection was lost." });
    };
    request.send(file);
  }
}

/** Files from a drop or paste (images pasted from the clipboard, e.g. screenshots, come as files too). */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  if (data.files.length > 0) return [...data.files];
  return [...data.items].flatMap((item) => (item.kind === "file" ? [item.getAsFile()].filter((f): f is File => f !== null) : []));
}
