import type { Attachment } from "svelte/attachments";

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

/**
 * Opens a context menu on an element: right click, the Menu key or Shift+F10 (all fire
 * `contextmenu`), and a long press on touch screens (iOS does not fire `contextmenu`). The click
 * that ends a long press does not activate the element.
 */
export function contextMenu(open: () => void): Attachment<HTMLElement> {
  return (node) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number } | undefined;
    let fired = false;

    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
      start = undefined;
    };

    const oncontextmenu = (event: MouseEvent) => {
      event.preventDefault();
      cancel();
      open();
    };

    const onpointerdown = (event: PointerEvent) => {
      fired = false;

      if (event.pointerType === "mouse") return;
      start = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => {
        fired = true;
        cancel();
        open();
      }, LONG_PRESS_MS);
    };

    const onpointermove = (event: PointerEvent) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel();
    };

    const onclick = (event: MouseEvent) => {
      if (!fired) return;
      fired = false;
      event.preventDefault();
      event.stopPropagation();
    };

    node.addEventListener("contextmenu", oncontextmenu);
    node.addEventListener("pointerdown", onpointerdown);
    node.addEventListener("pointermove", onpointermove);
    node.addEventListener("pointerup", cancel);
    node.addEventListener("pointercancel", cancel);
    node.addEventListener("click", onclick, true);

    return () => {
      cancel();
      node.removeEventListener("contextmenu", oncontextmenu);
      node.removeEventListener("pointerdown", onpointerdown);
      node.removeEventListener("pointermove", onpointermove);
      node.removeEventListener("pointerup", cancel);
      node.removeEventListener("pointercancel", cancel);
      node.removeEventListener("click", onclick, true);
    };
  };
}
