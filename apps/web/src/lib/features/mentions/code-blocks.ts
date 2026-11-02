import { flushSync, mount, unmount } from "svelte";
import CodeBlockField from "./CodeBlockField.svelte";
import { blockOf } from "./editor.ts";

/**
 * The code blocks of one editor: a `CodeBlockField` mounted into each block element of its DOM. Block elements come
 * and go through the browser (typed fence, paste, Undo / Redo of either, a delete), so after every edit `refresh`
 * mounts the ones without a field. A field whose element left the DOM stays mounted: Undo puts the same element
 * back, with its textarea and that textarea's own undo steps. The element's data attributes stay current with the
 * field (they are what serialization reads), so a copy of the element (a browser that moved it as markup) mounts
 * with the same code.
 */
export interface BlockHost {
  /** The language changed (the code reports itself through the input event). */
  changed(): void;
  exit(block: HTMLElement, side: "before" | "after"): boolean;
  remove(block: HTMLElement): void;
}

/** What a mounted field exports. */
type Field = { focus(where: "start" | "end"): void };

const ANCHOR = () => document.createTextNode("\u200b");

export class CodeBlocks {
  readonly #fields = new Map<HTMLElement, Field>();
  readonly #host: BlockHost;

  constructor(host: BlockHost) {
    this.#host = host;
  }

  /**
   * Mounts a field into every block of `root` without one; returns a block just typed, to focus. A block first in the
   * editor or right after another gets an invisible line before it (a zero-width space, which serialization drops):
   * the browser can neither delete a non-editable element nor put the caret above it without one.
   */
  refresh(root: HTMLElement): HTMLElement | undefined {
    let fresh: HTMLElement | undefined;
    for (const block of root.querySelectorAll<HTMLElement>('[data-block="code"]')) {
      const prev = block.previousSibling;
      if (block.parentNode === root && (!prev || (prev instanceof HTMLElement && blockOf(prev)))) block.before(ANCHOR());
      if (this.#fields.has(block)) continue;
      const data = blockOf(block);
      if (!data) continue;
      const isFresh = block.hasAttribute("data-fresh");
      block.removeAttribute("data-fresh");
      if (isFresh) fresh = block;
      block.replaceChildren();
      const field = mount(CodeBlockField, {
        target: block,
        props: {
          code: data.code,
          lang: data.lang,
          fresh: isFresh,
          oncode: (code: string) => (block.dataset["code"] = code),
          onlang: (lang: string) => {
            block.dataset["lang"] = lang;
            this.#host.changed();
          },
          onexit: (side: "before" | "after") => this.#host.exit(block, side),
          onremove: () => this.#host.remove(block),
        },
      }) as Field;
      this.#fields.set(block, field);
    }
    // The fields' elements exist before anyone focuses them.
    if (fresh) flushSync();
    return fresh;
  }

  focus(block: HTMLElement, where: "start" | "end"): void {
    this.#fields.get(block)?.focus(where);
  }

  /** Unmounts every field (the content is rendered anew, or the editor goes). */
  clear(): void {
    for (const field of this.#fields.values()) void unmount(field);
    this.#fields.clear();
  }
}
