import type { Attachment } from "svelte/attachments";

const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

/**
 * Tap-and-hold on touch screens (pen and finger; a mouse has hover instead): `onpress` after holding
 * still for a moment. The click that ends a long press does not activate the element (a link stays put),
 * and the system's own long-press menu gives way to it; a plain tap and a scroll behave as before.
 */
export function longPress(onpress: () => void): Attachment<HTMLElement> {
  return (node) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let start: { x: number; y: number } | undefined;
    let fired = false;

    const cancel = () => {
      clearTimeout(timer);
      timer = undefined;
      start = undefined;
    };

    const onpointerdown = (event: PointerEvent) => {
      fired = false;

      if (event.pointerType === "mouse") return;
      start = { x: event.clientX, y: event.clientY };
      timer = setTimeout(() => {
        fired = true;
        cancel();
        onpress();
      }, LONG_PRESS_MS);
    };

    const onpointermove = (event: PointerEvent) => {
      if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel();
    };

    const oncontextmenu = (event: Event) => {
      if (fired || start) event.preventDefault();
    };

    const onclick = (event: MouseEvent) => {
      if (!fired) return;
      fired = false;
      event.preventDefault();
      event.stopPropagation();
    };

    node.addEventListener("pointerdown", onpointerdown);
    node.addEventListener("pointermove", onpointermove);
    node.addEventListener("pointerup", cancel);
    node.addEventListener("pointercancel", cancel);
    node.addEventListener("contextmenu", oncontextmenu);
    node.addEventListener("click", onclick, true);

    return () => {
      cancel();
      node.removeEventListener("pointerdown", onpointerdown);
      node.removeEventListener("pointermove", onpointermove);
      node.removeEventListener("pointerup", cancel);
      node.removeEventListener("pointercancel", cancel);
      node.removeEventListener("contextmenu", oncontextmenu);
      node.removeEventListener("click", onclick, true);
    };
  };
}
