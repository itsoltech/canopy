import { getContext, setContext, untrack } from "svelte";
import type { Attachment } from "svelte/attachments";
import { pastedFiles, UNREACHABLE_FILES } from "./clipboard.ts";
import { filesOf } from "./draft.svelte.ts";
import { isWorkspaceFileDrag, workspaceFileDrag } from "#lib/features/workspace/file-drag.ts";

/** A visible composer: `files` attach uploads, `workspace` inserts mentions from its thread's Files tree. */
export interface FileTarget {
  readonly root: HTMLElement;
  files(files: File[], how: "paste" | "drop"): void;
  notice(text: string): void;
  readonly workspace?: { readonly threadId: string; mention(path: string): void } | undefined;
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
 * A workspace file drag instead adds the same FILE mention as `@`, only to a visible composer of its source thread.
 */
export class FileIntake {
  dragging = $state(false);
  referencing = $state(false);
  // Pending file-tab drops observe registration; events still resolve the visible target when they arrive.
  #targets = $state.raw<FileTarget[]>([]);

  get target(): FileTarget | undefined {
    return this.#targets.findLast(({ root }) => root.checkVisibility() && !root.closest("[inert]"));
  }

  register(target: FileTarget): () => void {
    // Registration runs in a composer's effect; changing the registry must not subscribe that effect to it.
    untrack(() => (this.#targets = [...this.#targets, target]));

    return () => {
      untrack(() => (this.#targets = this.#targets.filter((t) => t !== target)));
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
      this.referencing = false;
    };

    const takes = (event: DragEvent) => !internal && carriesFiles(event) && this.target !== undefined;

    const ondragover = (event: DragEvent) => {
      if (isWorkspaceFileDrag(event.dataTransfer)) {
        const target = this.target?.workspace;
        const file = target && workspaceFileDrag(event.dataTransfer, target.threadId);
        event.preventDefault();

        if (event.dataTransfer) event.dataTransfer.dropEffect = file ? "copy" : "none";

        if (!file) return stop();
        clearTimeout(hide);
        hide = setTimeout(stop, HOVER_GRACE_MS);
        this.referencing = true;
        this.dragging = true;

        return;
      }

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

      if (isWorkspaceFileDrag(event.dataTransfer)) {
        if (event.defaultPrevented) return;
        event.preventDefault();
        const workspace = target?.workspace;
        const file = workspace && workspaceFileDrag(event.dataTransfer, workspace.threadId, true);

        if (file) workspace?.mention(file.path);

        return;
      }

      if (event.defaultPrevented || !target || !takes(event)) return;
      event.preventDefault();
      target.files(filesOf(event.dataTransfer), "drop");
    };

    const ondragstart = () => (internal = true);

    const ondragend = () => {
      internal = false;
      stop();
    };

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
