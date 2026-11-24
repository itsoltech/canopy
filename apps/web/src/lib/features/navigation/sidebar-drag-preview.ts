import { tick } from "svelte";
import { prefersReducedMotion } from "svelte/motion";
import { duration } from "#lib/shared/ui/motion.ts";
import type { SidebarOrder } from "./sidebar-order.svelte.ts";

/** An expanded entry also contains its children's links. Only its own card can take part in a drag. */
export function threadRow(list: HTMLElement, element: Element | null) {
  const entry = element?.closest<HTMLElement>("li[data-thread-id]");

  if (!entry || !list.contains(entry) || entry.inert) return;
  const card = entry.querySelector<HTMLElement>(".sidebar-row");

  if (!card || !element || (element !== entry && !entry.firstElementChild?.contains(element))) return;

  return { entry, card, id: entry.dataset["threadId"] ?? "" };
}

type Row = NonNullable<ReturnType<typeof threadRow>>;

interface Slot {
  row: Row;
  before: boolean;
  valid: boolean;
}

function contains(rect: DOMRect | undefined, x: number, y: number) {
  return rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function dragGhost(card: HTMLElement) {
  const ghost = document.createElement("div");
  ghost.className = "sidebar-drag-ghost density-chrome sidebar-scale";
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.width = `${card.getBoundingClientRect().width}px`;
  ghost.append(card.cloneNode(true));

  for (const element of ghost.querySelectorAll("[id]")) element.removeAttribute("id");

  return ghost;
}

export class SidebarDragPreview {
  readonly ghost: HTMLElement;
  readonly indicator = document.createElement("div");
  readonly origin: DOMRect;
  readonly grabY: number;
  private readonly dialog: HTMLDialogElement | null;
  slot: Slot | undefined;
  zone: DOMRect | undefined;
  private landing: HTMLElement | undefined;

  constructor(
    readonly list: HTMLElement,
    readonly scroll: HTMLElement,
    readonly order: SidebarOrder,
    readonly source: Row,
    readonly startX: number,
    startY: number,
  ) {
    this.origin = source.card.getBoundingClientRect();
    this.grabY = startY - this.origin.top;
    this.ghost = dragGhost(source.card);
    this.ghost.style.setProperty("--grab-point", `${startX - this.origin.left}px ${this.grabY}px`);
    this.indicator.className = "sidebar-drop-indicator";
    this.indicator.setAttribute("aria-hidden", "true");
    this.dialog = list.closest<HTMLDialogElement>("dialog[open]");
    (this.dialog ?? document.body).append(this.ghost, this.indicator);
    this.alignToViewport();
    source.entry.dataset["dragSource"] = "";
    this.place(this.origin.left, this.origin.top);
  }

  /** The drawer establishes a containing block; its top can include the desktop title bar. */
  private alignToViewport() {
    if (!this.dialog) return;
    const box = this.dialog.getBoundingClientRect();

    for (const element of [this.ghost, this.indicator]) {
      element.style.left = `${this.dialog.scrollLeft - this.dialog.clientLeft - box.left}px`;
      element.style.top = `${this.dialog.scrollTop - this.dialog.clientTop - box.top}px`;
    }
  }

  private place(x: number, y: number) {
    this.ghost.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  private setSlot(row: Row | undefined, before: boolean) {
    const previous = this.slot;

    if (previous && previous.row.entry === row?.entry && previous.before === before) return;
    previous?.row.entry.removeAttribute("data-drop-edge");
    this.slot = row ? { row, before, valid: this.order.canDrop(this.source.id, row.id, before) } : undefined;
    const slot = this.slot;
    let action = "";

    if (slot?.valid) {
      const pins = this.order.settings.sidebar.pinnedThreadIds;
      const pin = pins.includes(slot.row.id);

      if (pin !== pins.includes(this.source.id)) action = pin ? "Pin thread" : "Unpin thread";
      slot.row.entry.dataset["dropEdge"] = this.order.custom ? (before ? "before" : "after") : "section";
    }

    this.ghost.dataset["action"] = action;
  }

  /** The marker and card move independently. Hit testing always uses the unshifted list entry. */
  paint(x: number, y: number, autoScroll: boolean) {
    this.alignToViewport();
    const viewport = this.scroll.getBoundingClientRect();
    const hit = contains(viewport, x, y) ? document.elementFromPoint(x, y) : null;
    const inside = !!hit && this.scroll.contains(hit);
    const zone = inside ? this.scroll.querySelector("[data-sidebar-pin-zone]")?.getBoundingClientRect() : undefined;
    this.zone = contains(zone, x, y) ? zone : undefined;
    this.order.pinTarget = !!this.zone;
    const row = inside && !this.zone ? threadRow(this.list, hit) : undefined;
    const box = row?.entry.getBoundingClientRect();
    const before = !!box && y < box.top + box.height / 2;
    this.setSlot(row, before);

    const showLine = this.order.custom && !!this.slot?.valid && !!box;

    if (showLine && box) {
      this.indicator.style.width = `${box.width}px`;
      this.indicator.style.transform = `translate(${box.left}px, ${before ? box.top : box.bottom}px)`;

      // Place a newly visible marker at this edge before enabling its travel between slots.
      if (!this.indicator.hasAttribute("data-visible")) this.indicator.getBoundingClientRect();
    }

    this.indicator.toggleAttribute("data-visible", showLine);

    const top = y - this.grabY;
    const dx = x - this.startX;
    this.place(this.origin.left + (this.order.custom ? dx : Math.max(-12, Math.min(12, dx))), top);

    // In Custom the card stays in the hand, even when the pointer crosses a row or the pin zone.
    const dock = !this.order.custom && this.zone;
    this.ghost.toggleAttribute("data-docked", Boolean(dock));
    this.ghost.style.setProperty("--dock-offset", dock ? `${dock.bottom - top}px` : "0px");

    if (this.order.custom && this.zone)
      this.ghost.dataset["action"] = this.order.settings.sidebar.pinnedThreadIds.includes(this.source.id)
        ? "Move to top"
        : "Pin thread";

    if (!inside || !autoScroll || this.zone) return false;
    const previous = this.scroll.scrollTop;

    if (y < (zone?.bottom ?? viewport.top) + 44) this.scroll.scrollTop -= 10;
    else if (y > viewport.bottom - 44) this.scroll.scrollTop += 10;

    return previous !== this.scroll.scrollTop;
  }

  clearTarget() {
    this.setSlot(undefined, false);
    this.indicator.remove();
  }

  private destination() {
    if (this.zone) return this.zone;

    if (!this.slot?.valid) return this.origin;
    const { row, before } = this.slot;
    const card = row.card.getBoundingClientRect();

    if (!this.order.custom) return card;
    const entry = row.entry.getBoundingClientRect();
    const movingDown = this.source.entry.getBoundingClientRect().top < entry.top;
    const top = (before ? entry.top : entry.bottom) - (movingDown ? this.origin.height : 0);

    return new DOMRect(card.left, top, card.width, this.origin.height);
  }

  /** Allow a quick save to supply the actual slot. A slow save still settles at the requested edge. */
  async settle(operation?: Promise<void>) {
    const fallback = operation ? this.destination() : this.origin;
    this.clearTarget();

    if (prefersReducedMotion.current) {
      this.remove();

      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const saved =
        !operation ||
        (await Promise.race([
          operation.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), duration("micro"));
          }),
        ]));

      await tick();

      if (!this.ghost.isConnected) return;
      this.landing =
        this.list.querySelector<HTMLElement>(`li[data-thread-id="${CSS.escape(this.source.id)}"]:not([inert])`) ??
        undefined;

      // The keyed row's FLIP transform is suppressed while the ghost represents it.
      if (this.landing) this.landing.dataset["dragSource"] = "landing";
      const actual = saved && this.landing?.querySelector(".sidebar-row")?.getBoundingClientRect();
      const box = actual || fallback;
      const viewport = this.scroll.getBoundingClientRect();
      this.ghost.dataset["settling"] = "";
      this.ghost.removeAttribute("data-docked");
      this.ghost.style.setProperty("--dock-offset", "0px");
      this.ghost.style.width = `${box.width}px`;
      this.place(box.left, Math.max(viewport.top - box.height, Math.min(viewport.bottom, box.top)));
      await Promise.allSettled(this.ghost.getAnimations().map((animation) => animation.finished));
    } finally {
      clearTimeout(timer);
      this.remove();
    }
  }

  remove() {
    if (!this.ghost.isConnected) return;
    this.clearTarget();
    this.source.entry.removeAttribute("data-drag-source");
    this.landing?.removeAttribute("data-drag-source");
    this.ghost.remove();
  }
}
