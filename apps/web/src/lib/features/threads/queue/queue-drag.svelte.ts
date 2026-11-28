import { tick } from "svelte";
import { motionPreferences } from "#lib/shared/ui/motion-preferences.svelte.ts";
import { duration } from "#lib/shared/ui/motion.ts";

/** A row's place in the list when the gesture measured it (`offsetTop`, which no translate changes). */
interface Slot {
  id: string;
  top: number;
  height: number;
}

/** What a row of the list is doing while a row is dragged (QueueRow styles each). */
export type DragPhase = "held" | "settling" | "shifted";

/**
 * Dragging a queue row by its handle (mouse, pen or finger; the handle has `touch-action: none`). The list keeps
 * its order while the gesture lasts: the held row lifts and follows the pointer 1:1 (within the list), and the rows
 * it passes slide aside by its height (`offset`), so the gap it lands in is always visible. Released, it settles
 * into that gap (--duration-fast); only then does `ondrop` reorder the list, and every translate is cleared in the
 * same update, so the reorder itself is never seen. A cancelled gesture eases every row back.
 *
 *   <button onpointerdown={(event) => drag.start(event, turn.id)} class="touch-none">…</button>
 */
export class QueueDrag {
  /** The row being dragged or settling. */
  id = $state<string | undefined>(undefined);
  /** Whether it follows the pointer or eases into its slot. */
  settling = $state(false);
  /** Translate of each row from its slot, px. */
  #offsets = $state.raw<ReadonlyMap<string, number>>(new Map());
  /** The update that reorders the list after a drop, whose glides must not play. */
  #landing = false;
  readonly #list: () => HTMLElement | undefined;
  readonly #ondrop: (id: string, index: number) => void;
  #stop: (() => void) | undefined;
  #land: (() => void) | undefined;
  #measure: (() => void) | undefined;

  constructor(options: { list: () => HTMLElement | undefined; ondrop: (id: string, index: number) => void }) {
    this.#list = options.list;
    this.#ondrop = options.ondrop;
  }

  /** Rows are placed by the gesture, not by the list's glide (`animate:`), from the press to the reorder. */
  get still(): boolean {
    return this.id !== undefined || this.#landing;
  }

  phase(id: string): DragPhase | undefined {
    if (this.id === undefined) return undefined;

    if (id !== this.id) return "shifted";

    return this.settling ? "settling" : "held";
  }

  offset(id: string): number {
    return this.#offsets.get(id) ?? 0;
  }

  /** The rows changed under the gesture (one started, a new one arrived): measure them again. */
  refresh(): void {
    this.#measure?.();
  }

  /** The panel or its queue was replaced: release the gesture without reordering. */
  dispose(): void {
    this.#stop?.();
    this.#land = undefined;
    this.#clear();
  }

  start(event: PointerEvent, id: string): void {
    const list = this.#list();

    if (!list || event.button !== 0 || (this.id && !this.settling)) return;
    event.preventDefault();
    // Grabbed again while the last drop settles: that drop lands first, so its reorder cannot undo this gesture.
    this.#land?.();
    const slots = measure(list);
    const own = slots.find((s) => s.id === id);

    if (!own) return;
    this.id = id;
    this.settling = false;
    this.#offsets = new Map();

    let pointerY = event.clientY;
    let rows = slots;
    let row = own;
    // Where in the row the pointer took it (in the list's content, so a scroll keeps the row under the pointer).
    const grab = pointerY - list.getBoundingClientRect().top - row.top;
    let index = rows.indexOf(row);

    const place = () => {
      // Kept between the first slot and the last, so the row is never dragged out of the list and clipped.
      const first = rows[0]?.top ?? row.top;
      const last = rows.at(-1);
      const bottom = last ? last.top + last.height - row.height : row.top;
      const top = Math.min(Math.max(pointerY - list.getBoundingClientRect().top - grab, first), bottom);
      const others = rows.filter((s) => s !== row);
      index = others.filter((s) => s.top + s.height / 2 < top + row.height / 2).length;
      const offsets = layout(rows, row, index, gap(list));
      offsets.set(id, top - row.top);
      this.#offsets = offsets;
    };

    this.#measure = () => {
      if (this.settling) return;
      rows = measure(list);
      const found = rows.find((s) => s.id === id);

      if (found) {
        row = found;
        place();
      } else {
        this.dispose();
      }
    };

    // On the window, not with pointer capture: a re-render of the row would release the capture.
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      pointerY = next.clientY;
      place();
    };

    const release = (last: PointerEvent, drop: boolean) => {
      if (last.pointerId !== event.pointerId) return;
      this.#stop?.();
      const to = drop ? index : rows.indexOf(row);
      this.#settle(id, layout(rows, row, to, gap(list)), to === rows.indexOf(row) ? undefined : to);
    };

    const end = (last: PointerEvent) => release(last, true);
    const cancel = (last: PointerEvent) => release(last, false);

    this.#stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      this.#stop = undefined;
      this.#measure = undefined;
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
  }

  /** Eases the rows to `offsets`, then reorders (`to`) and clears every translate in one update. */
  #settle(id: string, offsets: Map<string, number>, to: number | undefined): void {
    this.settling = true;
    this.#offsets = offsets;
    const timer = setTimeout(() => this.#land?.(), motionPreferences.reduced ? 0 : duration("fast"));

    this.#land = () => {
      clearTimeout(timer);
      this.#land = undefined;
      this.#landing = true;

      if (to !== undefined) this.#ondrop(id, to);
      this.#clear();
      void tick().then(() => (this.#landing = false));
    };
  }

  #clear(): void {
    this.id = undefined;
    this.settling = false;
    this.#offsets = new Map();
  }
}

function measure(list: HTMLElement): Slot[] {
  return [...list.querySelectorAll<HTMLElement>("[data-queue-row]")].flatMap((row) => {
    const id = row.dataset.queueRow;

    return id ? [{ id, top: row.offsetTop, height: row.offsetHeight }] : [];
  });
}

function gap(list: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(list).rowGap) || 0;
}

/** How far each row moves from its slot when `row` is placed at `index` (rows may differ in height). */
function layout(rows: readonly Slot[], row: Slot, index: number, space: number): Map<string, number> {
  const order = rows.filter((s) => s !== row);
  order.splice(index, 0, row);
  const offsets = new Map<string, number>();
  let top = rows[0]?.top ?? 0;

  for (const slot of order) {
    offsets.set(slot.id, top - slot.top);
    top += slot.height + space;
  }

  return offsets;
}
