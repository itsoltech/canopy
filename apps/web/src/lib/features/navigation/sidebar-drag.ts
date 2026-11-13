import type { Attachment } from "svelte/attachments";
import type { SidebarOrder, MoveDirection } from "./sidebar-order.svelte.ts";

interface Drag {
  id: string;
  pointer: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  offset: number;
  source: HTMLElement;
  ghost?: HTMLElement;
  target: string;
  before: boolean;
  valid: boolean;
}

function dragGhost(source: HTMLElement) {
  const box = source.getBoundingClientRect();
  const ghost = document.createElement("div");
  ghost.className = "sidebar-drag-ghost density-chrome sidebar-scale";
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${box.width}px`;
  ghost.style.left = `${box.left}px`;
  ghost.append(source.cloneNode(true));

  for (const element of ghost.querySelectorAll("[id]")) element.removeAttribute("id");
  document.body.append(ghost);

  return ghost;
}

function paintDrag(
  list: HTMLElement,
  scroll: HTMLElement,
  current: Drag,
  order: SidebarOrder,
  indicator: HTMLElement | undefined,
) {
  const viewport = scroll.getBoundingClientRect();

  const inside =
    current.x >= viewport.left &&
    current.x <= viewport.right &&
    current.y >= viewport.top &&
    current.y <= viewport.bottom;

  const delta = !inside ? 0 : current.y < viewport.top + 44 ? -1 : current.y > viewport.bottom - 44 ? 1 : 0;

  if (delta) scroll.scrollTop += delta * 12;

  const hit = inside
    ? document.elementFromPoint(current.x, current.y)?.closest<HTMLElement>("[data-thread-id]")
    : undefined;

  const pin = inside && current.y < viewport.top + 44;
  order.pinTarget = pin;
  const target = hit && list.contains(hit) ? (hit.dataset["threadId"] ?? "") : "";
  const box = hit?.getBoundingClientRect();
  const before = !!box && current.y < box.top + box.height / 2;

  if (target !== current.target || before !== current.before) {
    current.target = target;
    current.before = before;
    current.valid = order.canDrop(current.id, target, before);
  }

  if (indicator) {
    indicator.hidden = pin || !current.valid || !box;

    if (box) {
      indicator.style.width = `${box.width}px`;
      indicator.style.transform = `translate(${box.left}px, ${before ? box.top : box.bottom}px)`;
    }
  }

  if (current.ghost) {
    current.ghost.style.transform = `translateY(${current.y - current.offset}px)`;
    current.ghost.style.opacity = pin ? "0" : "";
  }
}

const directions = new Map<string, MoveDirection>([
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["Home", "top"],
  ["End", "bottom"],
]);

function moveByKeyboard(event: KeyboardEvent, order: SidebarOrder) {
  if (!event.altKey || !order.custom || !(event.target instanceof Element)) return;
  const direction = directions.get(event.key);
  const id = event.target.closest<HTMLElement>("[data-thread-id]")?.dataset["threadId"];
  const thread = id && order.overview.threads.get(id);

  if (!direction || !thread) return;
  event.preventDefault();
  void order.move(thread, direction);
}

/** Pointer frames only move a ghost/indicator. The keyed Svelte list reflows once, after the move is committed. */
export function sidebarDrag(order: SidebarOrder): Attachment<HTMLElement> {
  return (list) => {
    const scroll = list.closest<HTMLElement>("nav") ?? list;
    let drag: Drag | undefined;
    let frame = 0;
    let suppressClick = false;
    let indicator: HTMLElement | undefined;

    function clear() {
      cancelAnimationFrame(frame);
      drag?.ghost?.remove();
      drag?.source.removeAttribute("data-drag-source");

      if (drag && list.hasPointerCapture(drag.pointer)) list.releasePointerCapture(drag.pointer);
      indicator?.remove();
      indicator = undefined;
      drag = undefined;
      order.dragging = false;
      order.pinTarget = false;
    }

    function begin(current: Drag) {
      current.ghost = dragGhost(current.source);
      current.source.dataset["dragSource"] = "";
      indicator = document.createElement("div");
      indicator.className = "sidebar-drop-indicator";
      indicator.setAttribute("aria-hidden", "true");
      document.body.append(indicator);
      list.setPointerCapture(current.pointer);
      order.dragging = true;
    }

    function paint() {
      const current = drag;

      if (!current?.ghost) return;
      paintDrag(list, scroll, current, order, indicator);
      frame = requestAnimationFrame(paint);
    }

    function down(event: PointerEvent) {
      suppressClick = false;

      if (!order.custom || event.button !== 0 || event.pointerType !== "mouse" || !(event.target instanceof Element))
        return;

      if (event.target.closest("button, input, [role=menu]")) return;
      const source = event.target.closest<HTMLElement>("[data-thread-id]");
      const id = source?.dataset["threadId"];
      const thread = id && order.overview.threads.get(id);

      if (!source || !id || !thread || !order.available(thread)) return;
      drag = {
        id,
        source,
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        offset: event.clientY - source.getBoundingClientRect().top,
        target: "",
        before: true,
        valid: false,
      };
    }

    function move(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointer) return;
      drag.x = event.clientX;
      drag.y = event.clientY;

      if (!drag.ghost && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 6) {
        begin(drag);
        frame = requestAnimationFrame(paint);
      }

      if (drag.ghost) event.preventDefault();
    }

    function up(event: PointerEvent) {
      if (!drag || event.pointerId !== drag.pointer) return;
      const current = drag;
      const active = !!current.ghost;
      current.x = event.clientX;
      current.y = event.clientY;

      if (active) paintDrag(list, scroll, current, order, indicator);
      const pin = order.pinTarget;
      suppressClick = active;
      clear();

      if (active) void order.drop(current.id, current.target, current.before, pin);
    }

    function click(event: MouseEvent) {
      if (!suppressClick) return;
      suppressClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function keyboard(event: KeyboardEvent) {
      if (event.key === "Escape" && drag?.ghost) {
        event.preventDefault();
        clear();

        return;
      }

      moveByKeyboard(event, order);
    }

    list.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", clear);
    window.addEventListener("blur", clear);
    list.addEventListener("click", click, true);
    list.addEventListener("keydown", keyboard);

    const preventNative = (event: DragEvent) => {
      if (drag) event.preventDefault();
    };

    list.addEventListener("dragstart", preventNative);

    return () => {
      clear();
      list.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", clear);
      window.removeEventListener("blur", clear);
      list.removeEventListener("click", click, true);
      list.removeEventListener("keydown", keyboard);
      list.removeEventListener("dragstart", preventNative);
    };
  };
}
