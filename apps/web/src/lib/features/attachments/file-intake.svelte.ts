import { getContext, setContext } from "svelte";
import type { Attachment } from "svelte/attachments";
import { pastedFiles, UNREACHABLE_FILES } from "./clipboard.ts";

/** A composer that takes files (while `root` shows): `files` attach them, `notice` says why none could be read. */
export interface FileTarget {
  readonly root: HTMLElement;
  files(files: File[]): void;
  notice(text: string): void;
}

const KEY = Symbol("file-intake");

const editable = (target: Element) =>
  target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;

/**
 * Files pasted anywhere in a thread window go to its composer (docs/ui-api.md, "Wklejanie i upuszczanie plików").
 * The composer registers itself; the last one registered that shows takes the files (a composer hidden behind an
 * approval or a question takes none).
 * A paste into a text field stays there: the composer's own field handles its pastes.
 */
export class FileIntake {
  // Read when a paste comes, never rendered: a plain list (composers register from their effects).
  #targets: FileTarget[] = [];

  get target(): FileTarget | undefined {
    return this.#targets.findLast(({ root }) => root.checkVisibility() && !root.closest("[inert]"));
  }

  register(target: FileTarget): () => void {
    this.#targets.push(target);

    return () => {
      this.#targets = this.#targets.filter((t) => t !== target);
    };
  }

  /** The window's area: a paste with focus in it (or nowhere) attaches its files. */
  readonly zone: Attachment<HTMLElement> = (node) => {
    const onpaste = (event: ClipboardEvent) => {
      const target = this.target;
      const at = event.target;

      if (event.defaultPrevented || !target || !(at instanceof Element)) return;

      if (!(node.contains(at) || at === document.body || at === document.documentElement) || editable(at)) return;
      const pasted = pastedFiles(event.clipboardData);

      if (pasted.unreachable) target.notice(UNREACHABLE_FILES);

      if (pasted.files.length === 0) return;
      event.preventDefault();
      target.files(pasted.files);
    };

    document.addEventListener("paste", onpaste);

    return () => document.removeEventListener("paste", onpaste);
  };
}

export const provideFileIntake = (intake: FileIntake) => setContext(KEY, intake);
export const useFileIntake = (): FileIntake | undefined => getContext<FileIntake | undefined>(KEY);
