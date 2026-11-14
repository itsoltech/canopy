import { duration } from "../motion.ts";
import { flushSync } from "svelte";

export interface FooterResize {
  height: number;
  duration: number;
  easing: string;
}

/** Commit end space once, then translate the content on the compositor for a following reader. */
export class FooterScroll {
  #animation: Animation | undefined;
  #height = 0;
  #held = 0;

  resize(
    content: HTMLElement | undefined,
    scroller: HTMLElement | undefined,
    change: FooterResize,
    following: boolean,
    reserve: (height: number) => void,
    write: (top: number) => void,
  ) {
    const before = content?.getBoundingClientRect().top;
    const top = scroller?.scrollTop ?? 0;
    this.cancel();
    const column = content?.parentElement;

    if (column && scroller) {
      const natural = scroller.scrollHeight - this.#held + change.height - this.#height;
      // Shrinking past a reader's offset would make the browser clamp it. Retain only that
      // minimum extent until they return to latest; the measured composer coverage stays exact.
      this.#held = following ? 0 : Math.max(0, top + scroller.clientHeight - natural);
      column.style.minHeight = this.#held ? `${top + scroller.clientHeight}px` : "";
    }

    this.#height = change.height;
    flushSync(() => reserve(change.height));

    if (!scroller || !content || before === undefined) return;
    write(following ? scroller.scrollHeight - scroller.clientHeight : top);
    const delta = before - content.getBoundingClientRect().top;

    if (following && change.duration && Math.abs(delta) > 0.5) {
      this.#animation = content.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
        duration: change.duration,
        easing: change.easing,
      });
    }
  }

  follow(content: HTMLElement | undefined, scroller: HTMLElement | undefined, write: (top: number) => void) {
    if (!this.#held || !content) return;
    this.resize(
      content,
      scroller,
      {
        height: this.#height,
        duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : duration("slow"),
        easing: getComputedStyle(content).getPropertyValue("--ease-smooth-out").trim(),
      },
      true,
      () => {},
      write,
    );
  }

  interrupt(content: HTMLElement | undefined, scroller: HTMLElement | undefined, write: (top: number) => void) {
    if (!content || !scroller || this.#animation?.playState !== "running") return;
    const before = content.getBoundingClientRect().top;
    this.cancel();
    write(scroller.scrollTop + content.getBoundingClientRect().top - before);
  }

  cancel() {
    this.#animation?.cancel();
  }

  /** Follows the composer shell: its height is the feed's end reserve, from the feed's first frame. */
  connect(
    shell: HTMLElement,
    read: () => { content: HTMLElement | undefined; scroller: HTMLElement | undefined; following: boolean },
    reserve: (height: number) => void,
    write: (top: number) => void,
  ): () => void {
    return footerMotion(
      shell,
      (change) => {
        const { content, scroller, following } = read();
        this.resize(content, scroller, change, following, reserve, write);
      },
      (height) => {
        this.#height = height;
        reserve(height);
      },
    );
  }
}

/** Natural composer changes commit once. Tray disclosures already animate their layout, so the
 * shell and reserve follow each measured frame without starting another resize animation.
 * `initial` gets the height at once, so a new feed's first frame has its backdrop and end reserve. */
export function footerMotion(
  shell: HTMLElement,
  resize: (change: FooterResize) => void,
  initial: (height: number) => void,
): () => void {
  const content = shell.firstElementChild;

  if (!(content instanceof HTMLElement)) return () => {};

  let first = true;
  let height = content.getBoundingClientRect().height;
  shell.style.height = `${height}px`;
  initial(height);
  let shellAnimation: Animation | undefined;
  let disclosing = false;
  const parts = new Map<HTMLElement, { top: number; height: number; animation?: Animation }>();

  const observer = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const next = entry.borderBoxSize[0]?.blockSize ?? content.offsetHeight;

    if (Math.abs(next - height) < 0.25) return;

    const wasDisclosing = disclosing;
    disclosing = content
      .getAnimations({ subtree: true })
      .some(
        (animation) =>
          animation instanceof CSSTransition &&
          animation.transitionProperty === "grid-template-rows" &&
          animation.effect instanceof KeyframeEffect &&
          animation.effect.target instanceof HTMLElement &&
          animation.effect.target.classList.contains("t-composer-disclosure"),
      );

    const ms =
      first || disclosing || wasDisclosing || matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 0
        : duration(content.querySelector("[data-thread-composer-slot][data-compact]") ? "medium" : "slow");

    const easing = getComputedStyle(shell).getPropertyValue("--ease-smooth-out").trim();
    const from = shell.getBoundingClientRect().height;

    const positions = [
      ...content.querySelectorAll<HTMLElement>(
        ".t-composer-surface, .t-composer-editor, .t-composer-send, .t-composer-fold > *",
      ),
    ].map((node) => {
      const previous = parts.get(node);
      const style = getComputedStyle(node);
      const offset = previous?.animation ? new DOMMatrixReadOnly(style.transform).m42 : 0;
      const rise = Number.parseFloat(style.translate.split(" ")[1] ?? "0") || 0;
      const surface = node.classList.contains("t-composer-surface");
      const box = (surface ? node.parentElement : node)?.getBoundingClientRect() ?? node.getBoundingClientRect();

      const currentHeight =
        previous?.animation?.playState === "running"
          ? node.getBoundingClientRect().height
          : (previous?.height ?? box.height);

      const top = surface ? box.top : box.top - offset - rise;

      return {
        node,
        surface,
        height: box.height,
        currentHeight,
        previous: previous ? previous.top + offset + (surface ? previous.height - currentHeight : 0) : undefined,
        top,
      };
    });

    for (const part of parts.values()) part.animation?.cancel();

    for (const node of parts.keys()) if (!content.contains(node)) parts.delete(node);
    shellAnimation?.cancel();
    height = next;
    shell.style.height = `${next}px`;
    resize({ height: next, duration: ms, easing });

    if (ms)
      shellAnimation = shell.animate([{ height: `${from}px` }, { height: `${next}px` }], { duration: ms, easing });

    for (const { node, previous, top, surface, height: partHeight, currentHeight } of positions) {
      const delta = previous === undefined ? 0 : previous - top;

      const from = surface
        ? { height: `${currentHeight}px`, transform: `translateY(${delta + currentHeight - partHeight}px)` }
        : { transform: `translateY(${delta}px)` };

      const to = surface ? { height: `${partHeight}px`, transform: "translateY(0)" } : { transform: "translateY(0)" };

      const animation =
        ms && (Math.abs(delta) > 0.5 || (surface && Math.abs(currentHeight - partHeight) > 0.5))
          ? node.animate([from, to], {
              duration: ms,
              easing,
            })
          : undefined;

      parts.set(node, { top, height: partHeight, animation });
    }

    first = false;
  });

  observer.observe(content);

  return () => {
    observer.disconnect();
    shellAnimation?.cancel();

    for (const part of parts.values()) part.animation?.cancel();
  };
}
