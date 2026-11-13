import { FileResolution, type ThreadDirectoryPage, type ThreadFilesUpdate, type ui } from "@canopy/contracts";
import type { MessageInitShape } from "@bufbuild/protobuf";
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
  watchFiles?(
    request: MessageInitShape<typeof ui.WatchThreadFilesRequestSchema>,
    signal: AbortSignal,
    receive: (update: ThreadFilesUpdate) => void,
  ): Promise<void>;
  listDirectory?(
    request: MessageInitShape<typeof ui.ListThreadDirectoryRequestSchema>,
    signal: AbortSignal,
  ): Promise<ThreadDirectoryPage>;
  read(target: WorkspaceFileTarget, path: string, hash: string, signal: AbortSignal): Promise<ui.ThreadFile>;
  write(target: WorkspaceFileTarget, path: string, text: string, hash: string): Promise<ui.ThreadFile>;
  remove(target: WorkspaceFileTarget, path: string, hash: string): Promise<void>;
}

export class WorkspaceFileConflict extends Error {}

/** A document survives tab switches. Only metadata is persisted; bytes and drafts stay in memory. */
export class WorkspaceFile {
  file: ui.ThreadFile | undefined;
  lookup: ui.ThreadFile | undefined;
  text = "";
  draft = "";
  draftRevision = 0;
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
  #refresh: AbortController | undefined;
  #refreshAgain = false;
  changedOnDisk = false;
  removedOnDisk = false;
  diskText: string | undefined;
  watchStatus = "";

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
    return this.editing
      ? encoder.encode(this.text).byteLength +
          encoder.encode(this.draft).byteLength +
          encoder.encode(this.diskText ?? "").byteLength
      : 0;
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
        this.changedOnDisk = false;
        this.removedOnDisk = false;
        this.diskText = undefined;
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
      this.draftRevision++;
      this.error = "";
    }

    this.changed();
  }

  discard(): void {
    if (this.busy) return;
    this.draft = "";
    this.editing = false;
    this.error = "";
    this.diskText = undefined;
    this.changed();
  }

  /** Revalidation never replaces a dirty base or draft; only an explicit discard can accept disk bytes. */
  async revalidate(): Promise<void> {
    if (!this.file || this.loading || this.busy) return;

    if (this.#refresh) {
      this.#refreshAgain = true;

      return;
    }

    const controller = new AbortController();
    const base = this.file;
    this.#refresh = controller;

    try {
      const file = await this.api.read(this.target, this.path, "", controller.signal);

      if (controller.signal.aborted || this.file !== base) return;
      this.watchStatus = "";
      const found = file.resolution === FileResolution.FOUND || file.resolution === FileResolution.UNSPECIFIED;

      if (found && file.sha256 === base.sha256) {
        this.changedOnDisk = false;
        this.removedOnDisk = false;
        this.diskText = undefined;
      } else if (this.dirty || !found) {
        this.changedOnDisk = true;
        this.removedOnDisk = !found;

        const text =
          found && !file.binary && !file.truncated && file.size <= BigInt(FILE_EDIT_BYTES)
            ? decoder.decode(file.content)
            : undefined;

        this.diskText =
          text !== undefined &&
          this.reserveDraft(this.bytes + encoder.encode(this.draft).byteLength + encoder.encode(text).byteLength)
            ? text
            : undefined;
      } else if (file.content.byteLength <= FILE_PREVIEW_BYTES) {
        this.file = this.lookup = file;
        this.text = file.binary ? "" : decoder.decode(file.content);

        if (this.editing) this.draft = this.text;
        this.changedOnDisk = false;
        this.diskText = undefined;
      }
    } catch {
      if (!controller.signal.aborted) this.watchStatus = "File changes are unavailable. Reconnect, then reload.";
    } finally {
      if (this.#refresh === controller) this.#refresh = undefined;

      if (!controller.signal.aborted) this.changed();

      if (!controller.signal.aborted && this.#refreshAgain) {
        this.#refreshAgain = false;
        void this.revalidate();
      }
    }
  }

  async save(): Promise<boolean> {
    const file = this.file;

    if (!file?.sha256 || !this.dirty || this.busy) return false;

    if (this.changedOnDisk) {
      this.error = "The file changed on disk. Compare or copy your changes before discarding and reloading.";
      this.changed();

      return false;
    }

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

      if (cause instanceof WorkspaceFileConflict) this.changedOnDisk = true;

      return false;
    } finally {
      this.busy = false;
      this.changed();

      if (this.changedOnDisk) void this.revalidate();
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
    this.#refresh?.abort();
    this.#refresh = undefined;
    this.#refreshAgain = false;
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
