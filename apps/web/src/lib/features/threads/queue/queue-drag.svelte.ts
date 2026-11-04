import { tick } from "svelte";

/**
 * Dragging a queue row by its handle (mouse, pen or finger; the handle has `touch-action: none`). The row
 * follows the pointer (`offset`, a translate from its slot); when its middle passes a neighbour's, `onmove`
 * puts it in that slot (the neighbours glide aside, `animate:` in the list) and the offset is taken from the new
 * slot, so the row stays under the pointer. Rows are measured by `offsetTop`, which the glides' transforms do not
 * change. Releasing ends the drag (`ondrop`); the row eases back into its slot.
 *
 *   <button onpointerdown={(event) => drag.start(event, turn.id)} class="touch-none">…</button>
 */
export class QueueDrag {
  /** The row being dragged. */
  id = $state<string | undefined>(undefined);
  /** Its translate from its slot, px. */
  offset = $state(0);
  readonly #list: () => HTMLElement | undefined;
  readonly #onmove: (id: string, index: number) => void;
  readonly #ondrop: (id: string) => void;

  constructor(options: {
    list: () => HTMLElement | undefined;
    onmove: (id: string, index: number) => void;
    ondrop: (id: string) => void;
  }) {
    this.#list = options.list;
    this.#onmove = options.onmove;
    this.#ondrop = options.ondrop;
  }

  start(event: PointerEvent, id: string): void {
    const list = this.#list();
    const handle = event.currentTarget as HTMLElement;
    const row = handle.closest<HTMLElement>("[data-queue-row]");

    if (!list || !row || event.button !== 0 || this.id) return;
    event.preventDefault();
    this.id = id;
    this.offset = 0;
    // Where in the row the pointer took it, so the row does not jump to the pointer.
    const grab = event.clientY - row.getBoundingClientRect().top;
    let pointerY = event.clientY;

    const rows = () => [...list.querySelectorAll<HTMLElement>("[data-queue-row]")];

    const place = () => {
      const top = pointerY - list.getBoundingClientRect().top - grab;
      this.offset = top - row.offsetTop;

      return top + row.offsetHeight / 2;
    };

    // On the window, not with pointer capture: moving the row in the DOM would release the capture.
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      pointerY = next.clientY;
      const middle = place();
      const others = rows().filter((r) => r !== row);
      const index = others.filter((r) => r.offsetTop + r.offsetHeight / 2 < middle).length;

      if (index !== rows().indexOf(row)) {
        this.#onmove(id, index);
        void tick().then(place);
      }
    };

    const end = (last: PointerEvent) => {
      if (last.pointerId !== event.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      this.id = undefined;
      this.offset = 0;
      this.#ondrop(id);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }
}
