import type { Attachment } from "svelte/attachments";

/** How an element's text fits its box: its full text while the box cuts it off, and its one-line width. */
export interface TextFit {
  /** The full text while an ellipsis or a line clamp cuts it off, else `undefined`. */
  readonly clipped: string | undefined;
  /** The width of the text on one line, in px, however the box wraps or cuts it. */
  readonly natural: number;
}

let canvas: CanvasRenderingContext2D | null | undefined;
const pending = new Map<HTMLElement, (fit: TextFit) => void>();
let frame = 0;

function flush() {
  frame = 0;

  // Read every row before publishing anything that may change DOM or invalidate style.
  const measured = Array.from(pending, ([node, publish]) => ({
    publish,
    fit: {
      clipped:
        node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight
          ? node.textContent.trim()
          : undefined,
      natural: naturalWidth(node),
    },
  }));

  pending.clear();

  for (const { publish, fit } of measured) publish(fit);
}

function naturalWidth(node: HTMLElement): number {
  canvas ??= document.createElement("canvas").getContext("2d");

  if (!canvas) return 0;
  const style = getComputedStyle(node);
  canvas.font = style.font;
  canvas.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;

  return Math.ceil(canvas.measureText(node.textContent.trim()).width);
}

/** Reports how an element's text fits (`TextFit`); again whenever its size, text or fonts change. */
export function clipped(onchange: (fit: TextFit) => void): Attachment<HTMLElement> {
  return (node) => {
    let mounted = true;

    const measure = () => {
      if (!mounted) return;

      pending.set(node, onchange);
      frame ||= requestAnimationFrame(flush);
    };

    const resized = new ResizeObserver(measure);
    const edited = new MutationObserver(measure);
    resized.observe(node);
    edited.observe(node, { characterData: true, childList: true, subtree: true });
    void document.fonts.ready.then(() => node.isConnected && measure());

    return () => {
      mounted = false;
      resized.disconnect();
      edited.disconnect();
      pending.delete(node);

      if (pending.size) return;
      cancelAnimationFrame(frame);
      frame = 0;
    };
  };
}
