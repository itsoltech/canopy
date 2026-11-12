import { FileResolution, type ui } from "@canopy/contracts";
import { deleteFile, readFile, writeFile } from "./api.ts";
import type { FileTarget } from "./file-links.svelte.ts";

/** The BFF accepts bodies up to 512 KB; larger files open read-only. */
export const EDIT_LIMIT_BYTES = 400 * 1024;

const decoder = new TextDecoder();

const message = (cause: unknown, fallback: string) => (cause instanceof Error ? cause.message : fallback);

/**
 * One open file: its content as read, the user's draft while editing, and saving / deleting with the hash of
 * the read, so a change on disk since then is a conflict, never overwritten.
 */
export class FileViewerState {
  file = $state<ui.ThreadFile>();
  /** The content on disk as of the last read or save. */
  text = $state("");
  draft = $state("");
  editing = $state(false);
  loading = $state(false);
  busy = $state(false);
  error = $state("");
  /** Save failed because the file changed on disk: reload (discarding the draft) or keep editing. */
  conflict = $state(false);
  path = $state("");
  sha256 = $state("");
  lookup = $state<ui.ThreadFile>();

  constructor(readonly target: FileTarget) {}

  get dirty(): boolean {
    return this.editing && this.draft !== this.text;
  }

  get editable(): boolean {
    const file = this.file;

    return Boolean(file && !file.binary && !file.truncated && file.size <= BigInt(EDIT_LIMIT_BYTES));
  }

  async load(selectedPath?: string): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = "";

    if (selectedPath) {
      this.path = selectedPath;
      this.sha256 = "";
    }

    const path = this.path || this.target.path;
    const expected = this.sha256;
    this.file = undefined;
    this.lookup = undefined;

    try {
      const file = await readFile(this.target.threadId, path, this.target.itemId, expected);
      this.lookup = file;

      if (file.resolution !== FileResolution.UNSPECIFIED && file.resolution !== FileResolution.FOUND) return;
      this.file = file;
      this.path = file.path;
      this.sha256 = file.sha256;
      this.text = file.binary ? "" : decoder.decode(file.content);
      this.draft = this.text;
      this.conflict = false;
    } catch (cause) {
      this.error = message(cause, "Could not open the file.");
    } finally {
      this.loading = false;
    }
  }

  edit(): void {
    this.draft = this.text;
    this.editing = true;
  }

  discard(): void {
    this.draft = this.text;
    this.editing = false;
    this.conflict = false;
  }

  async save(): Promise<boolean> {
    const file = this.file;

    if (!file || !this.dirty || this.busy) return false;
    this.busy = true;
    this.error = "";

    try {
      const saved = await writeFile(this.target.threadId, this.path, this.draft, file.sha256);
      this.file = {
        ...file,
        ...saved,
        relativePath: file.relativePath,
        computer: file.computer,
        content: new TextEncoder().encode(this.draft),
      };
      this.text = this.draft;
      this.sha256 = saved.sha256;

      return true;
    } catch (cause) {
      this.error = message(cause, "Could not save the file.");
      this.conflict = this.error.includes("changed on disk");

      return false;
    } finally {
      this.busy = false;
    }
  }

  async remove(): Promise<boolean> {
    const file = this.file;

    if (!file || this.busy) return false;
    this.busy = true;
    this.error = "";

    try {
      await deleteFile(this.target.threadId, this.path, file.sha256);

      return true;
    } catch (cause) {
      this.error = message(cause, "Could not delete the file.");

      return false;
    } finally {
      this.busy = false;
    }
  }
}
