import type { ui } from "@canopy/contracts";
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

  constructor(readonly target: FileTarget) {}

  get dirty(): boolean {
    return this.editing && this.draft !== this.text;
  }

  get editable(): boolean {
    const file = this.file;

    return Boolean(file && !file.binary && !file.truncated && file.size <= BigInt(EDIT_LIMIT_BYTES));
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = "";

    try {
      const file = await readFile(this.target.threadId, this.target.path);
      this.file = file;
      this.text = decoder.decode(file.content);
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
      const saved = await writeFile(this.target.threadId, this.target.path, this.draft, file.sha256);
      this.file = { ...saved, content: file.content };
      this.text = this.draft;

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
      await deleteFile(this.target.threadId, this.target.path, file.sha256);

      return true;
    } catch (cause) {
      this.error = message(cause, "Could not delete the file.");

      return false;
    } finally {
      this.busy = false;
    }
  }
}
