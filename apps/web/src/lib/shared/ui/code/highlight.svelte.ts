import { IncrementalHighlight, type HighlightedLine, type LineTokenizer } from "./incremental.ts";
import type { LanguageId } from "./languages.ts";
import { updateNotice } from "#lib/shared/updates.svelte.ts";

/** Main-thread time one slice of highlighting may take before it yields (ms). */
const SLICE_MS = 6;
/** Longer code stays plain (it would take seconds of slices, and nobody reads it coloured). */
const MAX_LINES = 5000;
const MAX_CHARS = 300_000;

const yieldToMain = (): Promise<void> => {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Syntax highlighting of a code text that may still be growing, for rendering line by line. Until the
 * grammar loads (the highlighter is its own chunk, loaded on the first block that needs it) and for lines
 * not reached yet, `lines` has no entry and the line renders plain in the same place. Work runs in slices
 * of `SLICE_MS` between frames; a text that grew continues from the last unchanged line
 * (`IncrementalHighlight`). Server rendering and unknown languages stay plain.
 *
 * Create it during component initialisation (it owns an effect).
 */
export class Highlight {
  /** Highlighted lines of the current text, from the first; compare `text` before using one. */
  lines: readonly HighlightedLine[] = $state.raw([]);

  constructor(text: () => string, lang: () => LanguageId | undefined) {
    let work = new IncrementalHighlight();
    let workLang: LanguageId | undefined;
    $effect(() => {
      const id = lang();
      const value = text();
      if (id !== workLang) {
        work = new IncrementalHighlight();
        workLang = id;
        this.lines = [];
      }
      if (!id || value.length > MAX_CHARS) return;
      const source = value.split("\n");
      if (source.length > MAX_LINES) return;
      if (work.retain(source)) this.lines = [...work.lines];
      const current = work;
      let stopped = false;
      void (async () => {
        let tokenize: LineTokenizer;
        try {
          tokenize = await (await import("./highlighter.ts")).tokenizer(id);
        } catch (cause) {
          updateNotice.detect(false, cause);
          return; // The chunk did not load (offline, a new deploy): the block stays plain.
        }
        while (!stopped) {
          const deadline = performance.now() + SLICE_MS;
          const before = current.lines.length;
          const done = current.advance(source, tokenize, () => performance.now() < deadline);
          if (current.lines.length !== before) this.lines = [...current.lines];
          if (done) return;
          await yieldToMain();
        }
      })();
      return () => {
        stopped = true;
      };
    });
  }
}
