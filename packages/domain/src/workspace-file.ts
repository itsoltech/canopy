import { FileResolution, type ui } from "@canopy/contracts";
import type { FilePosition } from "./file-references.ts";

export const FILE_EDIT_BYTES = 400 * 1024;
export const FILE_PREVIEW_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface WorkspaceFileTarget {
  readonly threadId: string;
  readonly path: string;
  readonly itemId?: string;
  readonly local?: boolean;
  readonly position?: FilePosition;
}

export interface WorkspaceFileApi {
  read(target: WorkspaceFileTarget, path: string, hash: string, signal: AbortSignal): Promise<ui.ThreadFile>;
  write(target: WorkspaceFileTarget, path: string, text: string, hash: string): Promise<ui.ThreadFile>;
  remove(target: WorkspaceFileTarget, path: string, hash: string): Promise<void>;
}

/** A document survives tab switches. Only metadata is persisted; bytes and drafts stay in memory. */
export class WorkspaceFile {
  file: ui.ThreadFile | undefined;
  lookup: ui.ThreadFile | undefined;
  text = "";
  draft = "";
  editing = false;
  loading = false;
  busy = false;
  error = "";
  path: string;
  position: FilePosition | undefined;
  positionRevision = 0;
  readerPositionRevision = -1;
  scroll = 0;
  #read: AbortController | undefined;

  constructor(
    readonly target: WorkspaceFileTarget,
    readonly api: WorkspaceFileApi,
    readonly changed: () => void,
    readonly reserveDraft: (bytes: number) => boolean,
  ) {
    this.path = target.path;
    this.position = target.position;
  }

  get dirty(): boolean {
    return this.editing && this.draft !== this.text;
  }
  get editable(): boolean {
    return Boolean(
      this.file?.sha256 && !this.file.binary && !this.file.truncated && this.file.size <= BigInt(FILE_EDIT_BYTES),
    );
  }
  get bytes(): number {
    return this.file?.content.byteLength ?? 0;
  }
  get draftBytes(): number {
    return this.editing ? encoder.encode(this.text).byteLength + encoder.encode(this.draft).byteLength : 0;
  }

  locate(position?: FilePosition): void {
    if (!position) return;
    this.position = position;
    this.positionRevision++;
    this.changed();
  }

  async load(selected?: string): Promise<void> {
    if (this.busy || this.dirty) return;
    this.cancel();
    const read = new AbortController();
    this.#read = read;
    this.loading = true;
    this.error = "";
    this.changed();

    try {
      const file = await this.api.read(
        this.target,
        selected ?? this.path,
        selected ? "" : (this.file?.sha256 ?? ""),
        read.signal,
      );

      if (read.signal.aborted) return;

      if (file.content.byteLength > FILE_PREVIEW_BYTES)
        throw new Error("This file exceeds the preview limit. Open a smaller file.");
      this.lookup = file;
      this.file = undefined;

      if (file.resolution === FileResolution.FOUND || file.resolution === FileResolution.UNSPECIFIED) {
        this.file = file;
        this.path = file.path;
        this.text = file.binary ? "" : decoder.decode(file.content);
        this.draft = "";
        this.editing = false;
      }
    } catch (cause) {
      if (!read.signal.aborted)
        this.error = failure(cause, "Could not open the file. Check the connection, then reload.");
    } finally {
      if (this.#read === read) {
        this.#read = undefined;
        this.loading = false;
        this.changed();
      }
    }
  }

  edit(): void {
    if (!this.editable || this.loading || this.busy) return;

    if (!this.reserveDraft(this.bytes * 2)) {
      this.error = "The draft limit was reached. Save or discard another draft, then retry.";
      this.changed();

      return;
    }

    this.draft = this.text;
    this.editing = true;
    this.changed();
  }

  setDraft(text: string): void {
    if (!this.editing || this.busy) return;
    const bytes = encoder.encode(text).byteLength;

    if (bytes > FILE_EDIT_BYTES || !this.reserveDraft(this.bytes + bytes)) {
      this.error = "The draft limit was reached. Save or discard another draft, then retry.";
    } else {
      this.draft = text;
      this.error = "";
    }

    this.changed();
  }

  discard(): void {
    if (this.busy) return;
    this.draft = "";
    this.editing = false;
    this.error = "";
    this.changed();
  }

  async save(): Promise<boolean> {
    const file = this.file;

    if (!file?.sha256 || !this.dirty || this.busy) return false;
    this.busy = true;
    this.error = "";
    this.changed();

    try {
      const saved = await this.api.write(this.target, this.path, this.draft, file.sha256);
      this.file = {
        ...file,
        ...saved,
        content: encoder.encode(this.draft),
        relativePath: file.relativePath,
        computer: file.computer,
      };
      this.text = this.draft;
      this.editing = false;
      this.draft = "";

      return true;
    } catch (cause) {
      this.error = failure(cause, "Could not save the file. Check the connection, then retry.");

      return false;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  async remove(): Promise<boolean> {
    if (!this.file?.sha256 || this.busy || this.dirty) return false;
    this.busy = true;
    this.changed();

    try {
      await this.api.remove(this.target, this.path, this.file.sha256);

      return true;
    } catch (cause) {
      this.error = failure(cause, "Could not delete the file. Reload, then retry.");

      return false;
    } finally {
      this.busy = false;
      this.changed();
    }
  }

  cancel(): void {
    this.#read?.abort();
    this.#read = undefined;
    this.loading = false;
  }

  release(): void {
    if (this.editing || this.busy) return;
    this.cancel();
    this.file = undefined;
    this.lookup = undefined;
    this.text = "";
  }
}

const failure = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);
