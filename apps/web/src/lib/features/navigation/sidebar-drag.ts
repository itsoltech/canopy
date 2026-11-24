import type { Attachment } from "svelte/attachments";
import type { SidebarOrder, MoveDirection } from "./sidebar-order.svelte.ts";
import { SidebarDragPreview, threadRow } from "./sidebar-drag-preview.ts";

const directions = new Map<string, MoveDirection>([
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["Home", "top"],
  ["End", "bottom"],
]);

function moveByKeyboard(event: KeyboardEvent, list: HTMLElement, order: SidebarOrder) {
  if (!event.altKey || !order.custom || !(event.target instanceof Element)) return;
  const direction = directions.get(event.key);
  const row = threadRow(list, event.target);
  const thread = row && order.overview.threads.get(row.id);

  if (!direction || !thread) return;
  event.preventDefault();
  void order.move(thread, direction);
}

interface Drag {
  row: NonNullable<ReturnType<typeof threadRow>>;
  pointer: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  preview?: SidebarDragPreview;
}

class SidebarGesture {
  readonly scroll: HTMLElement;
  readonly listeners = new AbortController();
  drag: Drag | undefined;
  settling: SidebarDragPreview | undefined;
  frame = 0;
  suppressClick = false;

  constructor(
    readonly list: HTMLElement,
    readonly order: SidebarOrder,
  ) {
    this.scroll = list.closest<HTMLElement>("nav") ?? list;
    const { signal } = this.listeners;
    list.addEventListener("pointerdown", this.down, { signal });
    list.addEventListener("lostpointercapture", this.cancelPointer, { signal });
    list.addEventListener("dragstart", this.preventNative, { signal });
    list.addEventListener("selectstart", this.preventNative, { signal });
    list.addEventListener("click", this.click, { signal, capture: true });
    list.addEventListener("keydown", (event) => moveByKeyboard(event, list, order), { signal });
    window.addEventListener("keydown", this.escape, { signal, capture: true });
    window.addEventListener("blur", this.cancel, { signal });
    window.addEventListener("pointermove", this.move, { signal, passive: false });
    window.addEventListener("pointercancel", this.cancelPointer, { signal });
    window.addEventListener("pointerup", this.up, { signal });
    this.scroll.addEventListener("scroll", this.requestPaint, { signal, passive: true });
  }

  private down = (event: PointerEvent) => {
    if (this.drag || event.button !== 0 || event.pointerType !== "mouse" || !(event.target instanceof Element)) return;
    this.suppressClick = false;

    if (event.target.closest("button, input, [role=menu]")) return;
    const row = threadRow(this.list, event.target);
    const thread = row && this.order.overview.threads.get(row.id);

    if (!row || !thread || !this.order.draggable(thread)) return;
    this.settling?.remove();
    this.settling = undefined;
    this.drag = {
      row,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
    };
  };

  private move = (event: PointerEvent) => {
    const drag = this.drag;

    if (!drag || event.pointerId !== drag.pointer) return;

    if (!(event.buttons & 1)) {
      this.cancel();

      return;
    }

    drag.x = event.clientX;
    drag.y = event.clientY;

    if (!drag.preview) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
      this.list.setPointerCapture(drag.pointer);
      this.order.dragging = drag.row.id;
      this.list.dataset["sidebarDragging"] = "";
      drag.preview = new SidebarDragPreview(this.list, this.scroll, this.order, drag.row, drag.startX, drag.startY);
    }

    event.preventDefault();
    this.requestPaint();
  };

  private requestPaint = () => {
    if (!this.drag?.preview || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const drag = this.drag;

      if (drag?.preview?.paint(drag.x, drag.y, true)) this.requestPaint();
    });
  };

  private up = (event: PointerEvent) => {
    const drag = this.drag;

    if (!drag || event.pointerId !== drag.pointer) return;
    drag.preview?.paint(event.clientX, event.clientY, false);
    this.finish(true);
  };

  private finish(commit: boolean) {
    const drag = this.drag;

    if (!drag) return;
    this.drag = undefined;
    cancelAnimationFrame(this.frame);
    this.frame = 0;

    if (this.list.hasPointerCapture(drag.pointer)) this.list.releasePointerCapture(drag.pointer);
    const preview = drag.preview;

    if (!preview) return;
    this.suppressClick = true;
    const { slot, zone } = preview;
    this.order.dragging = "";
    this.order.pinTarget = false;
    this.list.removeAttribute("data-sidebar-dragging");

    const move =
      commit && (zone || slot?.valid)
        ? this.order.drop(drag.row.id, slot?.row.id ?? "", slot?.before ?? true, !!zone)
        : undefined;

    this.settling = preview;
    void preview.settle(move).finally(() => {
      if (this.settling === preview) this.settling = undefined;
    });
  }

  private cancel = () => this.finish(false);

  private cancelPointer = (event: PointerEvent) => {
    if (event.pointerId === this.drag?.pointer) this.cancel();
  };

  private escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !this.drag) return;

    if (this.drag.preview) {
      event.preventDefault();
      event.stopPropagation();
    }

    this.cancel();
  };

  private preventNative = (event: Event) => {
    if (this.drag) event.preventDefault();
  };

  private click = (event: MouseEvent) => {
    if (!this.suppressClick || event.detail === 0) return;
    this.suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  dispose() {
    this.listeners.abort();
    this.cancel();
    this.settling?.remove();
  }
}

/** Pointer frames touch only the preview. The keyed list reflows when the order changes. */
export function sidebarDrag(order: SidebarOrder): Attachment<HTMLElement> {
  return (list) => {
    const gesture = new SidebarGesture(list, order);

    return () => gesture.dispose();
  };
}
