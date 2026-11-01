import type { Attachment } from "svelte/attachments";

/**
 * Drag handle of a bottom sheet: pulling it down moves the sheet with the finger (`--sheet-drag` on the
 * sheet, `data-dragging` turns its transition off), letting go past a quarter of its height or with a
 * flick closes it (`onclose`), otherwise it springs back on its open transition.
 *
 *   <div {@attach sheetDrag(() => (open = false))}><span class="…handle bar…"></span></div>
 */
export function sheetDrag(onclose: () => void): Attachment<HTMLElement> {
  return (handle) => {
    let start: { y: number; time: number; id: number } | undefined;
    let sheet: HTMLElement | null = null;
    let offset = 0;

    const reset = () => {
      sheet?.style.removeProperty("--sheet-drag");
      delete sheet?.dataset.dragging;
      start = undefined;
      offset = 0;
    };
    const onpointerdown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      sheet = handle.closest<HTMLElement>("[data-sheet]");
      if (!sheet) return;
      handle.setPointerCapture(event.pointerId);
      start = { y: event.clientY, time: event.timeStamp, id: event.pointerId };
      sheet.dataset.dragging = "";
    };
    const onpointermove = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id || !sheet) return;
      offset = Math.max(0, event.clientY - start.y);
      sheet.style.setProperty("--sheet-drag", `${offset}px`);
    };
    const onpointerup = (event: PointerEvent) => {
      if (!start || event.pointerId !== start.id || !sheet) return;
      const speed = offset / Math.max(event.timeStamp - start.time, 1);
      const dismiss = offset > sheet.offsetHeight / 4 || (offset > 24 && speed > 0.5);
      reset();
      if (dismiss) onclose();
    };

    handle.addEventListener("pointerdown", onpointerdown);
    handle.addEventListener("pointermove", onpointermove);
    handle.addEventListener("pointerup", onpointerup);
    handle.addEventListener("pointercancel", reset);
    return () => {
      reset();
      handle.removeEventListener("pointerdown", onpointerdown);
      handle.removeEventListener("pointermove", onpointermove);
      handle.removeEventListener("pointerup", onpointerup);
      handle.removeEventListener("pointercancel", reset);
    };
  };
}
