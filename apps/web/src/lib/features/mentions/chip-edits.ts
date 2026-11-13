import {
  caretAfter,
  caretAtPoint,
  chipBeforeCaret,
  ensureCaret,
  rangeIn,
  restoreCaret,
  selectNode,
  textBeforeCaret,
} from "./caret.ts";
import { MentionKind, type Mention } from "@canopy/contracts";
import {
  CHIPS_TYPE,
  chipsFromClipboard,
  chipsToClipboard,
  elementOf,
  serialize,
  type EditorControls,
  type EditorValue,
} from "./editor.ts";
import type { MentionData } from "./kinds.ts";
import { citationHtml } from "#lib/features/quotes/inline.ts";

/**
 * Chips put in and taken out of the mention editor by the composer (MentionEditor's `editor`; attachments:
 * docs/ui-api.md, "Załączniki w tekście"). Every change goes through `execCommand`, so Undo and Redo bring a chip
 * back or take it again; `sync` reads the model back after each one.
 */
export class ChipEdits {
  /** Where the caret was when the field lost focus: chips added from the "+" menu go there. */
  #last: Range | undefined;

  constructor(
    private readonly root: () => HTMLElement | undefined,
    private readonly html: (mention: MentionData) => string,
    private readonly sync: () => void,
    private readonly render: (value: EditorValue) => string,
  ) {}

  /** The chip part of the editor's controls (the root stays live: a getter). */
  controls(): Pick<EditorControls, "root" | "insertChips" | "removeChips" | "insertQuote" | "replaceQuote"> {
    const root = this.root;

    return {
      get root() {
        return root();
      },
      insertChips: (chips, point) => this.insertChips(chips, point),
      removeChips: (which) => this.removeChips(which),
      insertQuote: (quote) => {
        const node = root();

        if (!node) return;
        const focused = document.activeElement === node;
        node.focus({ preventScroll: true });

        if (!focused || !rangeIn(node)) restoreCaret(node, this.#last);
        ensureCaret(node);

        return this.insertMarked(`${marked(citationHtml(quote))}&nbsp;`);
      },
      replaceQuote: (chip, quote) => {
        const node = root();

        if (!node || !node.contains(chip)) return;
        node.focus({ preventScroll: true });
        selectNode(chip);

        if (quote) this.insertMarked(marked(citationHtml(quote)));
        else {
          document.execCommand("delete");
          this.sync();
        }
      },
    };
  }

  /** The field lost focus: keep its caret. */
  remember(): void {
    const root = this.root();
    const range = root && rangeIn(root);

    if (range) this.#last = range;
  }

  /** Keep the last editor range before transcript selection takes over. */
  track(): () => void {
    const remember = () => this.remember();
    document.addEventListener("selectionchange", remember);

    return () => document.removeEventListener("selectionchange", remember);
  }

  /** One chip (a trigger's pick) at the selection, with a space after it. */
  insertChip(mention: MentionData): void {
    this.insertMarked(`${marked(this.html(mention))}&nbsp;`);
  }

  /** Chips at the caret (`point`: where they were dropped), apart from the text before them and each other. */
  insertChips(chips: readonly MentionData[], point?: { readonly x: number; readonly y: number }): void {
    const root = this.root();

    if (!root || chips.length === 0) return;
    const focused = document.activeElement === root;
    root.focus({ preventScroll: true });

    if (point) caretAtPoint(root, point.x, point.y);
    else if (!focused) restoreCaret(root, this.#last);
    ensureCaret(root);
    const before = textBeforeCaret(root);
    const touching = before === undefined ? chipBeforeCaret(root) !== undefined : /\S$/.test(before);
    const html = chips.map((chip) => marked(this.html(chip))).join("&nbsp;");
    this.insertMarked(`${touching ? "&nbsp;" : ""}${html}&nbsp;`);
  }

  removeChips(which: (mention: MentionData) => boolean): void {
    const root = this.root();

    if (!root) return;

    for (const chip of root.querySelectorAll<HTMLElement>('[data-element="mention"]')) {
      const element = elementOf(chip);

      if (!element || !which(element.mention)) continue;
      root.focus({ preventScroll: true });
      selectNode(chip);
      document.execCommand("delete");
    }

    this.sync();
  }

  /**
   * A paste of chips copied from a composer: the ones `accept` takes, a file's badge only when the text does not
   * have it yet (a file has one badge), the rest as their text.
   */
  pasteCopied(value: EditorValue, current: readonly Mention[], accept: (mention: MentionData) => boolean): void {
    const kept = value.mentions.filter(
      (m) =>
        accept(m) &&
        !(m.kind === MentionKind.ATTACHMENT && current.some((x) => x.kind === m.kind && x.name === m.name)),
    );

    this.insertRendered(
      this.render({
        text: value.text,
        mentions: kept,
        quotes: value.quotes?.map((q) => ({ ...q, id: crypto.randomUUID() })),
      }),
    );
  }

  /** Text with its chips (rendered HTML, a paste of copied chips) at the caret. */
  insertRendered(html: string): void {
    this.insertMarked(
      html.replaceAll(
        '<span contenteditable="false" data-element',
        '<span data-inserted="" contenteditable="false" data-element',
      ),
    );
  }

  /** HTML with chips marked `data-inserted` at the caret (one undoable edit); the caret after the last one. */
  private insertMarked(html: string): HTMLElement | undefined {
    document.execCommand("insertHTML", false, html);
    // Chrome leaves the caret before inserted non-editable content: put it after the chip and its space.
    const chips = [...(this.root()?.querySelectorAll<HTMLElement>("[data-inserted]") ?? [])];

    // WebKit's insertHTML can strip contenteditable=false. Restore the chip's atomic
    // boundary before placing the caret, otherwise Backspace edits its label instead.
    for (const chip of chips) {
      chip.setAttribute("contenteditable", "false");
      chip.removeAttribute("data-inserted");
    }

    const last = chips.at(-1);

    if (last) caretAfter(last);
    this.sync();

    return last;
  }
}

const marked = (html: string) => html.replace("<span ", '<span data-inserted="" ');

/** Copy and cut: the text, and with chips the value under CHIPS_TYPE. */
export function copyValue(data: DataTransfer, value: EditorValue): void {
  data.setData("text/plain", value.text);

  if (value.mentions.length > 0 || value.quotes?.length) data.setData(CHIPS_TYPE, chipsToClipboard(value));
}

/** Chips copied from a composer, when the clipboard's text is still what was copied with them. */
export function copiedValue(data: DataTransfer | null): EditorValue | undefined {
  const copied = chipsFromClipboard(data?.getData(CHIPS_TYPE) ?? "");

  return copied && copied.text === data?.getData("text/plain").replace(/\r\n?/g, "\n") ? copied : undefined;
}

/** Copy or cut the selected editor model, including atomic citations. */
export function copySelection(event: ClipboardEvent, root: HTMLElement | undefined, sync: () => void): void {
  const current = getSelection();

  if (!root || !current || current.isCollapsed || current.rangeCount === 0 || !event.clipboardData) return;
  const range = current.getRangeAt(0);

  if (!root.contains(range.commonAncestorContainer)) return;
  event.preventDefault();
  copyValue(event.clipboardData, serialize(range.cloneContents()));

  if (event.type === "cut") {
    document.execCommand("delete");
    sync();
  }
}

/** A click that landed on a chip goes to `then` with the chip's mention and element. */
export function chipClicked(
  target: EventTarget | null,
  then: ((mention: MentionData, chip: HTMLElement) => void) | undefined,
): void {
  const chip = target instanceof Element ? target.closest<HTMLElement>('[data-element="mention"]') : null;
  const element = chip && elementOf(chip);

  if (chip && element) then?.(element.mention, chip);
}
