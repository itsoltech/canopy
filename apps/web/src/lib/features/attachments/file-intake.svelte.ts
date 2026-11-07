import { getContext, setContext } from "svelte";
import type { Attachment } from "svelte/attachments";
import { pastedFiles, UNREACHABLE_FILES } from "./clipboard.ts";
import { filesOf } from "./draft.svelte.ts";

/** A composer that takes files (while `root` shows): `files` attach them, `notice` says why none could be read. */
export interface FileTarget {
  readonly root: HTMLElement;
  files(files: File[], how: "paste" | "drop"): void;
  notice(text: string): void;
}

const KEY = Symbol("file-intake");

/** How long the drop overlay outlasts a `dragleave` (the next element's `dragover` follows at once). */
const LEAVE_GRACE_MS = 120;

/** Without a `dragleave` (a drag that ends elsewhere): `dragover` repeats at least every ~350 ms while files hover. */
const HOVER_GRACE_MS = 600;

const carriesFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;

/**
 * Files dragged onto a page that does not take them would open in its place (the browser navigates to the file):
 * outside a drop target such a drop does nothing. Returns the cleanup.
 */
export function holdFileDrops(): () => void {
  const hold = (event: DragEvent) => {
    if (event.defaultPrevented || !carriesFiles(event)) return;
    event.preventDefault();

    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };

  document.addEventListener("dragover", hold);
  document.addEventListener("drop", hold);

  return () => {
    document.removeEventListener("dragover", hold);
    document.removeEventListener("drop", hold);
  };
}

const editable = (target: Element) =>
  target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') !== null;

/**
 * Files pasted anywhere in a thread window go to its composer (docs/ui-api.md, "Wklejanie i upuszczanie plików").
 * The composer registers itself; the last one registered that shows takes the files (a composer hidden behind an
 * approval or a question takes none).
 * A paste into a text field stays there: the composer's own field handles its pastes.
 * Files dragged from outside the page onto the area drop there too (`dragging` shows the overlay); a drop on the
 * composer itself places the badges where it lands. Drags that start in the page (text, images) are not files to add.
 */
export class FileIntake {
  dragging = $state(false);
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

  /** The window's area: a paste with focus in it (or nowhere) and a drop on it attach their files. */
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
      target.files(pasted.files, "paste");
    };

    // The overlay follows `dragover` and outlasts it briefly: enter and leave between children never flicker it.
    let internal = false;
    let hide: ReturnType<typeof setTimeout> | undefined;

    const stop = () => {
      clearTimeout(hide);
      this.dragging = false;
    };

    const takes = (event: DragEvent) => !internal && carriesFiles(event) && this.target !== undefined;

    const ondragover = (event: DragEvent) => {
      if (!takes(event)) return;
      event.preventDefault();

      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      clearTimeout(hide);
      hide = setTimeout(stop, HOVER_GRACE_MS);
      this.dragging = true;
    };

    const ondragleave = () => {
      clearTimeout(hide);
      hide = setTimeout(stop, LEAVE_GRACE_MS);
    };

    const ondrop = (event: DragEvent) => {
      stop();
      const target = this.target;

      if (event.defaultPrevented || !target || !takes(event)) return;
      event.preventDefault();
      target.files(filesOf(event.dataTransfer), "drop");
    };

    const ondragstart = () => (internal = true);
    const ondragend = () => (internal = false);

    document.addEventListener("paste", onpaste);
    document.addEventListener("dragstart", ondragstart);
    document.addEventListener("dragend", ondragend);
    node.addEventListener("dragenter", ondragover);
    node.addEventListener("dragover", ondragover);
    node.addEventListener("dragleave", ondragleave);
    node.addEventListener("drop", ondrop);

    return () => {
      stop();
      document.removeEventListener("paste", onpaste);
      document.removeEventListener("dragstart", ondragstart);
      document.removeEventListener("dragend", ondragend);
      node.removeEventListener("dragenter", ondragover);
      node.removeEventListener("dragover", ondragover);
      node.removeEventListener("dragleave", ondragleave);
      node.removeEventListener("drop", ondrop);
    };
  };
}

export const provideFileIntake = (intake: FileIntake) => setContext(KEY, intake);
export const useFileIntake = (): FileIntake | undefined => getContext<FileIntake | undefined>(KEY);
