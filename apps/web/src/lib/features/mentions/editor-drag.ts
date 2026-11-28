import { on } from "svelte/events";
import { isWorkspaceFileDrag } from "#lib/features/workspace/file-drag.ts";
import { caretAtPoint, rangeAtPoint } from "./caret.ts";
import { isChip, serialize, type EditorValue } from "./editor.ts";

const CHIP_SELECTOR = '[data-element][contenteditable="false"]';
const DRAG_TYPE = "application/x-canopy-editor-chip";

export interface DropCaret {
  readonly x: number;
  readonly y: number;
  readonly height: number;
}

/** Native drag feedback with a private payload. Only the source editor can commit the move. */
export class EditorDrag {
  #source: HTMLElement | undefined;

  constructor(
    private readonly root: () => HTMLElement | undefined,
    private readonly enabled: () => boolean,
    private readonly preview: (caret?: DropCaret) => void,
    private readonly move: (value: EditorValue, chipIndex: number) => void,
    private readonly insertPlain: (text: string) => void,
  ) {}

  readonly attach = (root: HTMLElement): (() => void) => {
    const detach = [
      on(root, "dragstart", (event) => this.start(event)),
      on(root, "dragenter", (event) => this.over(event)),
      on(root, "dragover", (event) => this.over(event)),
      on(root, "dragleave", (event) => this.leave(event)),
      on(root, "dragend", () => this.end()),
      on(root, "drop", (event) => this.drop(event), { capture: true }),
    ];

    return () => {
      for (const remove of detach) remove();
      this.end();
    };
  };

  private start(event: DragEvent): void {
    const chip = event.target instanceof Element ? event.target.closest<HTMLElement>(CHIP_SELECTOR) : null;

    if (!chip || !this.root()?.contains(chip) || !isChip(chip)) return;
    // The window's file intake tracks document dragstart/dragend pairs. A move replaces
    // the source before dragend, so this local drag must not start window-level tracking.
    event.stopPropagation();

    if (!this.enabled()) {
      event.preventDefault();

      return;
    }

    const data = event.dataTransfer;

    if (!data) return;
    this.#source = chip;
    data.effectAllowed = "move";
    data.clearData();
    data.setData(DRAG_TYPE, "move");
  }

  private over(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes(DRAG_TYPE)) return;
    const root = this.root();
    const range = root && this.destination(root, event);
    event.preventDefault();
    event.dataTransfer.dropEffect = range ? "move" : "none";
    this.preview(root && range && dropCaret(root, range, event));
  }

  private leave(event: DragEvent): void {
    if (!(event.relatedTarget instanceof Node) || !this.root()?.contains(event.relatedTarget)) this.preview();
  }

  end(): void {
    this.#source = undefined;
    this.preview();
  }

  private drop(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes(DRAG_TYPE)) {
      this.dropText(event);

      return;
    }

    const root = this.root();
    const source = this.#source;
    const range = root && this.destination(root, event);
    event.preventDefault();
    this.end();

    if (root && source && range) {
      const moved = movedValue(root, source, range);

      if (moved) this.move(moved.value, moved.chipIndex);
    }
  }

  private dropText(event: DragEvent): void {
    const data = event.dataTransfer;
    const target = event.target;

    if (event.defaultPrevented || isWorkspaceFileDrag(data) || data?.types.includes("Files")) return;

    if (target instanceof Element && target.closest('[data-block="code"]')) return;
    event.preventDefault();
    const text = data?.getData("text/plain");
    const root = this.root();

    if (!root || !text || !this.enabled()) return;
    caretAtPoint(root, event.clientX, event.clientY);
    root.focus();
    this.insertPlain(text);
  }

  private destination(root: HTMLElement, event: DragEvent): Range | undefined {
    if (event.defaultPrevented || !this.enabled() || !this.#source || !root.contains(this.#source)) return undefined;
    const target = event.target;

    if (target instanceof Element && (this.#source.contains(target) || target.closest("[data-block]")))
      return undefined;

    return rangeAtPoint(root, event.clientX, event.clientY);
  }
}

/** Move on a detached copy, then use the editor's usual HTML renderer for one native undo entry. */
function movedValue(
  root: HTMLElement,
  source: HTMLElement,
  range: Range,
): { value: EditorValue; chipIndex: number } | undefined {
  const copy = root.cloneNode(true);
  const chip = nodeInCopy(root, copy, source);
  const destination = nodeInCopy(root, copy, range.startContainer);

  if (!(copy instanceof HTMLElement) || !(chip instanceof HTMLElement) || !destination) return undefined;
  const at = document.createRange();
  at.setStart(destination, range.startOffset);
  at.collapse(true);
  chip.remove();
  at.insertNode(chip);

  if (copy.innerHTML === root.innerHTML) return undefined;
  const chipIndex = Array.from(copy.querySelectorAll(CHIP_SELECTOR)).findIndex((node) => node === chip);

  return { value: serialize(copy), chipIndex };
}

function nodeInCopy(root: Node, copy: Node, node: Node): Node | undefined {
  if (node === root) return copy;
  const parent = node.parentNode;

  if (!parent) return undefined;
  const index = Array.from(parent.childNodes).findIndex((child) => child === node);

  return nodeInCopy(root, copy, parent)?.childNodes[index];
}

/** A wrapped chip starts and ends on different lines. */
function elementEdge(element: Element, before: boolean) {
  const boxes = element.getClientRects();
  const rect = boxes.item(before ? 0 : boxes.length - 1);

  return rect ? { x: before ? rect.left : rect.right, rect } : undefined;
}

/** An element boundary (beside a chip or at the end of a line) may have no collapsed range rect. */
function caretRect(range: Range, event: DragEvent): { x: number; rect: DOMRect } | undefined {
  const chip = event.target instanceof Element && event.target.closest(CHIP_SELECTOR);

  if (chip) return elementEdge(chip, range.startContainer.childNodes[range.startOffset] === chip);

  const rect = range.getBoundingClientRect();

  if (rect.height > 0) return { x: rect.left, rect };
  const container = range.startContainer;
  const offset = range.startOffset;
  const next = container.childNodes[offset];
  const adjacent = next ?? container.childNodes[offset - 1];

  if (adjacent instanceof Element) return elementEdge(adjacent, Boolean(next));

  if (adjacent instanceof Text) {
    const edge = document.createRange();
    edge.setStart(adjacent, next ? 0 : adjacent.length);
    edge.collapse(true);
    const box = edge.getBoundingClientRect();

    return { x: box.left, rect: box };
  }

  return undefined;
}

function dropCaret(root: HTMLElement, range: Range, event: DragEvent): DropCaret | undefined {
  const caret = caretRect(range, event);
  const frame = root.parentElement?.getBoundingClientRect();
  const bounds = root.getBoundingClientRect();

  if (!caret || !frame || caret.x < bounds.left || caret.x > bounds.right) return undefined;
  const top = Math.max(caret.rect.top, bounds.top);
  const bottom = Math.min(caret.rect.bottom, bounds.bottom);

  return bottom > top ? { x: caret.x - frame.left, y: top - frame.top, height: bottom - top } : undefined;
}
