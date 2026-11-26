import { ipcRenderer } from "electron";

function composerEditor(event: MouseEvent) {
  const target = event.target;

  if (!(target instanceof Element) || !target.closest("[data-composer-editor]")) return undefined;
  const editor = target.closest("[contenteditable], textarea");

  return editor instanceof HTMLElement && editor.matches(":read-write") ? editor : undefined;
}

function captureFocus(editor: HTMLElement) {
  if (editor instanceof HTMLTextAreaElement) {
    const { selectionStart, selectionEnd, selectionDirection } = editor;

    return () => {
      if (!editor.isConnected || !editor.matches(":read-write")) return false;
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(selectionStart, selectionEnd, selectionDirection);

      return document.activeElement === editor;
    };
  }

  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : undefined;
  const backward = selection?.direction === "backward";

  return () => {
    if (!editor.isConnected || !editor.matches(":read-write")) return false;
    editor.focus({ preventScroll: true });

    if (selection && range && editor.contains(range.startContainer) && editor.contains(range.endContainer)) {
      const { startContainer, startOffset, endContainer, endOffset } = range;

      if (backward) selection.setBaseAndExtent(endContainer, endOffset, startContainer, startOffset);
      else selection.setBaseAndExtent(startContainer, startOffset, endContainer, endOffset);
    }

    return document.activeElement === editor;
  };
}

/** This stays in the isolated preload. The application page gets no menu or edit IPC. */
export function trackComposerContext() {
  let invocation: MouseEvent | undefined;
  let current: { id: number; focus: () => boolean } | undefined;

  window.addEventListener(
    "contextmenu",
    (event) => {
      if (event.isTrusted) invocation = event;
    },
    true,
  );

  const forgetInvocation = (event: Event) => {
    if (!event.isTrusted) return;
    invocation = undefined;
    current = undefined;
  };

  window.addEventListener("pointerdown", forgetInvocation, true);
  window.addEventListener("keydown", forgetInvocation, true);

  ipcRenderer.on("canopy:composer-menu-probe", (_event, id: number) => {
    const input = invocation;
    invocation = undefined;

    const editor =
      input && !input.defaultPrevented && performance.now() - input.timeStamp <= 500
        ? composerEditor(input)
        : undefined;

    current = editor ? { id, focus: captureFocus(editor) } : undefined;
    ipcRenderer.send("canopy:composer-menu-probed", id, Boolean(current));
  });

  ipcRenderer.on("canopy:composer-menu-focus", (_event, id: number) => {
    if (current?.id !== id) return;
    const { focus } = current;
    current = undefined;
    ipcRenderer.send("canopy:composer-menu-focused", id, focus());
  });
}
