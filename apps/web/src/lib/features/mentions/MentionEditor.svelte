<script lang="ts">
  import type { Mention } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import {
    blockBesideCaret,
    caretAfter,
    caretAtPoint,
    caretBesideBlock,
    caretNextToBlock,
    chipBeforeCaret,
    ensureCaret,
    fenceLineAtCaret,
    selectBackFromCaret,
    selectNode,
    textBeforeCaret,
  } from "./caret.ts";
  import { CodeBlocks } from "./code-blocks.ts";
  import { activeTrigger, blockOf, iconKey, serialize, toHtml, type ActiveTrigger, type TriggerChar } from "./editor.ts";
  import { formatInlineCode, markTicks } from "./inline-code.ts";
  import { InputSession } from "./input-session.ts";
  import { INLINE_RENDERERS, type MentionData } from "./kinds.ts";
  import { blockHtml, findFences, openingFence } from "./markdown.ts";
  import MentionList from "./MentionList.svelte";
  import MentionSuggestions from "./MentionSuggestions.svelte";
  import type { MentionOption, MentionSources } from "./sources.svelte.ts";

  /**
   * The composer's text field with inline mentions (docs/ui-api.md, "Wzmianki"): a contenteditable whose model is
   * `value` (plain text) and `mentions` (ranges in it). Typing a trigger at the start of a line or after a space
   * opens the popup above the composer: "/" commands, "$" skills and plugins (Codex's convention), "@" files of
   * the thread's folder, "#" other threads. ↑↓ move, Enter or Tab insert the chip, Escape closes; a tap inserts too.
   * A chip is one unit: Backspace next to it removes it whole (and Undo brings it back).
   *
   * Live markdown (markdown.ts): a backtick span turns into inline code as its closing backtick is typed (the
   * backticks stay, muted), and an opening fence line (`` ``` `` or `` ```ts ``) with Enter turns into a code block
   * (CodeBlockField: language pill, highlighting, its own keys); a pasted or restored complete fence is a block too.
   * Both are formatting of the same text: `value` holds the backticks and fences exactly. Backspace at the start of
   * the line after a block, Delete at the end of the line before it and ArrowUp / ArrowDown next to it go into the
   * block instead of deleting or skipping it. Copy and cut put the text (fences, mention markers) on the clipboard.
   *
   * Why contenteditable and not an editor library: chips are the only rich content, so a small model over the
   * browser's own editing keeps undo, IME, spellcheck and mobile keyboards native at a few kB (ProseMirror or
   * Lexical would add 60-150 kB). Every change goes through the browser (`insertText`, `insertHTML`,
   * `insertLineBreak`), so the undo stack holds it; pasted content always arrives as plain text.
   *
   * Keys the editor does not use go to `onkeydown` (the composer's Enter to send). `onpaste` sees a paste first
   * (files go to the attachments); text pastes as plain text unless it prevented the default.
   */
  let {
    value = $bindable(""),
    mentions = $bindable([]),
    id,
    label,
    placeholder = "",
    disabled = false,
    autofocus = false,
    singleLine = false,
    sources,
    triggers = new Set<TriggerChar>(["/", "$", "@", "#"]),
    anchor,
    onkeydown: forward,
    onpaste: pasteFirst,
    editor = $bindable(),
    class: className,
  }: {
    value?: string;
    mentions?: Mention[];
    id: string;
    label: string;
    placeholder?: string;
    disabled?: boolean;
    autofocus?: boolean;
    /** Clip an unfocused draft to its first line without remounting the editor or losing undo. */
    singleLine?: boolean;
    /** Where options come from; without it the field is plain text with line breaks. */
    sources?: MentionSources | undefined;
    triggers?: ReadonlySet<TriggerChar>;
    /** The popup sits above this element (the whole composer box), as wide as it. */
    anchor?: HTMLElement | undefined;
    onkeydown?: ((event: KeyboardEvent) => void) | undefined;
    onpaste?: ((event: ClipboardEvent) => void) | undefined;
    /** Controls for the "+" menu: start a trigger at the caret, focus. */
    editor?: { insertTrigger(char: TriggerChar): void; focus(): void } | undefined;
    class?: ClassValue;
  } = $props();

  let root = $state<HTMLDivElement>();
  $effect(() => { if (singleLine && root) root.scrollTop = 0; });
  let composing = $state(false);
  const inputSession = new InputSession((format) => {
    composing = inputSession.composing;
    sync(format);
  });
  /** What the DOM holds now (to tell outside changes of value/mentions from our own). */
  let shown = { text: "", key: "" };
  /** Icons of chips inserted from the catalog, kept when the content is re-rendered. */
  const icons = new Map<string, string>();
  let trigger = $state<ActiveTrigger>();
  /** The last trigger: the closing popup keeps its words. */
  let lastChar = $state<TriggerChar>("/");
  $effect(() => {
    if (trigger) lastChar = trigger.char;
  });
  let dismissed = $state<string>();
  let active = $state(0);
  let popupOpen = $state(false);

  const mentionsKey = (list: readonly Mention[]) => list.map((m) => `${m.kind}:${m.name}:${m.start}-${m.end}`).join("|");

  const blocks = new CodeBlocks({
    changed: () => sync(false),
    exit(block, side) {
      const prev = block.previousSibling;
      if (!root || (side === "before" && (!prev || (prev instanceof HTMLElement && blockOf(prev))))) return false;
      root.focus({ preventScroll: true });
      caretBesideBlock(block, side);
      sync(false);
      return true;
    },
    remove: removeBlock,
  });
  $effect(() => () => blocks.clear());

  // An outside change (cleared after sending, a restored draft): render it.
  $effect(() => {
    const text = value;
    const key = mentionsKey(mentions);
    if (!root || (text === shown.text && key === shown.key)) return;
    blocks.clear();
    root.innerHTML = toHtml({ text, mentions }, icons);
    blocks.refresh(root);
    markTicks(root);
    shown = { text, key };
    trigger = undefined;
  });

  const results = $derived(sources?.results);
  const catalogTrigger = $derived(trigger?.char === "/" || trigger?.char === "$");
  const options = $derived(trigger && results ? results.options : []);
  const loading = $derived(catalogTrigger ? (sources?.catalogState.loading ?? false) : (results?.loading ?? false));
  const error = $derived(catalogTrigger ? sources?.catalogState.error : results?.error);
  const emptyText = $derived(
    lastChar === "/" ? "No commands match" : lastChar === "$" ? "No skills or plugins match" : lastChar === "@" ? "No files match" : "No threads match",
  );
  // Catalog lists react to the catalog arriving.
  $effect(() => {
    if (trigger && catalogTrigger && sources) {
      void sources.catalog.entries;
      sources.query(trigger.char, trigger.query);
    }
  });
  $effect(() => {
    popupOpen = Boolean(trigger && sources);
  });
  $effect(() => {
    if (!popupOpen) {
      sources?.close();
      if (trigger) dismissed = `${trigger.char}${trigger.query}`;
      trigger = undefined;
    }
  });
  $effect(() => {
    if (active >= options.length) active = Math.max(0, options.length - 1);
  });

  /** While inline code is written again (its own input events come back here). */
  let formatting = false;

  /** Reads the model back from the DOM after the browser changed it; `format`: live markdown follows the edit. */
  function sync(format = true) {
    if (!root || formatting) return;
    // Always read/query native input, including iOS insertCompositionText/replacements.
    // Keep the IME's DOM and selection untouched until it commits.
    if (format && !inputSession.composing) {
      formatting = true;
      try {
        formatInlineCode(root);
      } finally {
        formatting = false;
      }
    }
    if (!inputSession.composing) {
      const fresh = blocks.refresh(root);
      markTicks(root);
      if (fresh) blocks.focus(fresh, "start");
    }
    const next = serialize(root);
    shown = { text: next.text, key: mentionsKey(next.mentions) };
    value = next.text;
    mentions = next.mentions;
    detectTrigger();
  }

  function detectTrigger() {
    if (!sources) return;
    // Not inside inline code.
    const inCode = getSelection()?.anchorNode?.parentElement?.closest("code") != null;
    const before = root && !inCode ? textBeforeCaret(root) : undefined;
    const found = before === undefined ? undefined : activeTrigger(before, triggers);
    // Escape closed it: stays closed until the query changes.
    if (!found || dismissed === `${found.char}${found.query}`) {
      trigger = undefined;
      return;
    }
    dismissed = undefined;
    if (found.char !== trigger?.char || found.query !== trigger?.query) active = 0;
    trigger = found;
    // Catalog triggers query from the effect above (it also follows the catalog arriving).
    if (found.char === "@" || found.char === "#") sources.query(found.char, found.query);
  }

  /** Replaces the trigger and its query with the chip (and a space after it), as one undoable edit. */
  function choose(option: MentionOption) {
    // The trigger character and its query become the chip.
    if (!root || !trigger || !selectBackFromCaret(trigger.length)) return;
    if (option.data.icon) icons.set(iconKey(option.data), option.data.icon);
    insertChip(option.data);
    trigger = undefined;
    dismissed = undefined;
  }

  function insertChip(mention: MentionData) {
    const html = INLINE_RENDERERS.mention.html({ type: "mention", mention }).replace("<span ", '<span data-inserted="" ');
    document.execCommand("insertHTML", false, `${html}&nbsp;`);
    // Chrome leaves the caret before inserted non-editable content: put it after the chip and its space.
    const chip = root?.querySelector("[data-inserted]");
    if (chip) {
      // WebKit's insertHTML can strip contenteditable=false. Restore the chip's atomic
      // boundary before placing the caret, otherwise Backspace edits its label instead.
      chip.setAttribute("contenteditable", "false");
      chip.removeAttribute("data-inserted");
      caretAfter(chip);
    }
    sync();
  }

  /** Plain text at the caret: lines as text and line breaks (no markup from the clipboard); complete fences as blocks. */
  function insertPlain(text: string) {
    const normalized = text.replace(/\r\n?/g, "\n");
    if (findFences(normalized).length > 0) {
      document.execCommand("insertHTML", false, toHtml({ text: normalized.replace(/\n$/, ""), mentions: [] }));
      sync();
      return;
    }
    const lines = normalized.split("\n");
    lines.forEach((line, i) => {
      if (i > 0) document.execCommand("insertLineBreak");
      if (line) document.execCommand("insertText", false, line);
    });
    sync();
  }

  /** The fence line the caret is on becomes an empty code block (one undoable edit), the caret in it. */
  function openBlock(): boolean {
    const fence = root && fenceLineAtCaret(root);
    const opening = fence && openingFence(fence.line);
    if (!fence || !opening || !selectBackFromCaret(fence.line.length)) return false;
    // The line break that ended the line goes too: the block is its own lines.
    const range = getSelection()!.getRangeAt(0).cloneRange();
    if (fence.lineBreak instanceof Node) range.setEndAfter(fence.lineBreak);
    else if (fence.lineBreak) range.setEnd(fence.lineBreak.node, fence.lineBreak.offset);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    // A last block brings the line after it along (in the same edit, so Undo and Redo keep it): the caret has
    // somewhere to go below it.
    const end = range.endContainer;
    const last = end.nodeType === Node.TEXT_NODE ? range.endOffset === (end.textContent?.length ?? 0) && !end.nextSibling : !end.childNodes[range.endOffset];
    document.execCommand("insertHTML", false, blockHtml({ lang: opening.lang, code: "", fence: opening.fence }, true) + (last ? "<br>" : ""));
    sync(false);
    return true;
  }

  /** Takes a block out (one undoable edit); the lines around it stay apart. */
  function removeBlock(block: HTMLElement) {
    if (!root) return;
    const prev = block.previousSibling;
    const next = block.nextSibling;
    const endsLine = (node: Node | null) =>
      !node || node.nodeName === "BR" || (node instanceof HTMLElement && blockOf(node) !== undefined) || (node.nodeType === Node.TEXT_NODE && !node.textContent?.replace(/\u200b/g, ""));
    const joins =
      !endsLine(prev) && !endsLine(next) && !(prev?.textContent ?? "").endsWith("\n") && !(next?.textContent ?? "").startsWith("\n");
    root.focus({ preventScroll: true });
    selectNode(block);
    document.execCommand(joins ? "insertLineBreak" : "delete");
    sync();
  }

  /** The block's own textarea (its events reach the editor, they are not the editor's). */
  const inBlock = (target: EventTarget | null) => target instanceof HTMLTextAreaElement && root?.contains(target) === true;
  /** Anywhere in a block (its textarea, the language search). */
  const inBlockArea = (target: EventTarget | null) => target instanceof Element && target.closest('[data-block="code"]') !== null;

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing || composing) return;
    if (event.target !== root) {
      // In a block only Mod+Enter (send, queue) is the composer's; its language search keeps its keys.
      if (inBlock(event.target) && event.key === "Enter" && (event.metaKey || event.ctrlKey)) forward?.(event);
      return;
    }
    if (trigger && popupOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (options.length > 0) active = (active + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && options[active]) {
        event.preventDefault();
        choose(options[active]!);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        popupOpen = false;
        return;
      }
    }
    const plainKey = !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey;
    if (root && plainKey && (event.key === "Backspace" || event.key === "ArrowUp")) {
      // The line after a block: Backspace or ArrowUp goes into it (the browser would delete it whole or skip it).
      const block = blockBesideCaret(root, "before", event.key === "ArrowUp");
      if (block && (event.key === "Backspace" || caretNextToBlock(block, "before"))) {
        event.preventDefault();
        blocks.focus(block, "end");
        return;
      }
    }
    if (root && plainKey && (event.key === "Delete" || event.key === "ArrowDown")) {
      const block = blockBesideCaret(root, "after", event.key === "ArrowDown");
      if (block && (event.key === "Delete" || caretNextToBlock(block, "after"))) {
        event.preventDefault();
        blocks.focus(block, "start");
        return;
      }
    }
    if (event.key === "Enter" && !event.altKey && !event.metaKey && !event.ctrlKey && openBlock()) {
      event.preventDefault();
      return;
    }
    if (event.key === "Backspace" && !event.altKey && !event.metaKey && !event.ctrlKey) {
      // A chip goes whole (one undoable delete).
      const chip = root && chipBeforeCaret(root);
      if (chip) {
        event.preventDefault();
        selectNode(chip);
        document.execCommand("delete");
        sync();
        return;
      }
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      document.execCommand("insertLineBreak");
      sync();
      return;
    }
    forward?.(event);
  }

  function onbeforeinput(event: InputEvent) {
    if (inBlockArea(event.target)) return;
    // Mobile keyboards' return and formatting shortcuts: a line break, never a paragraph or bold text.
    if (event.inputType === "insertParagraph") {
      event.preventDefault();
      document.execCommand("insertLineBreak");
      sync();
    } else if (event.inputType.startsWith("format")) {
      event.preventDefault();
    }
  }

  function onpaste(event: ClipboardEvent) {
    pasteFirst?.(event);
    // A block's textarea pastes verbatim on its own.
    if (event.defaultPrevented || inBlockArea(event.target)) return;
    const text = event.clipboardData?.getData("text/plain");
    event.preventDefault();
    if (text) insertPlain(text);
  }

  /** Copy and cut from the text: what the message would say (fences of blocks, markers of chips), not their looks. */
  function oncopy(event: ClipboardEvent) {
    const current = getSelection();
    if (inBlockArea(event.target) || !root || !current || current.isCollapsed || current.rangeCount === 0 || !event.clipboardData) return;
    const range = current.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", serialize(range.cloneContents()).text);
    if (event.type === "cut") {
      document.execCommand("delete");
      sync();
    }
  }

  function ondrop(event: DragEvent) {
    if (event.defaultPrevented || event.dataTransfer?.types.includes("Files") || inBlockArea(event.target)) return;
    const text = event.dataTransfer?.getData("text/plain");
    event.preventDefault();
    if (!text) return;
    if (!root) return;
    caretAtPoint(root, event.clientX, event.clientY);
    root.focus();
    insertPlain(text);
  }

  editor = {
    focus: () => root?.focus({ preventScroll: true }),
    insertTrigger(char: TriggerChar) {
      if (!root) return;
      root.focus({ preventScroll: true });
      ensureCaret(root);
      const before = serialize(root).text;
      const needsSpace = before.length > 0 && !/\s$/.test(textBeforeCaret(root) ?? before);
      dismissed = undefined;
      document.execCommand("insertText", false, `${needsSpace ? " " : ""}${char}`);
      sync();
    },
  };

  function focusOnMount(node: HTMLDivElement) {
    if (autofocus) node.focus();
  }
</script>

<!-- The placeholder shares the text's grid cell and padding (`class`), so it sits exactly where typing starts. -->
{#if sources}
  <MentionSuggestions bind:open={popupOpen} {anchor} label="{label}: suggestions">
    <MentionList
      id="{id}-popup"
      label={lastChar === "@" ? "Files" : lastChar === "#" ? "Threads" : lastChar === "/" ? "Commands" : "Skills and plugins"}
      {options}
      {active}
      {loading}
      {error}
      empty={emptyText}
      onchoose={choose}
      onactive={(index) => (active = index)}
    />
  </MentionSuggestions>
{/if}
<div class="grid min-w-0 grid-cols-1">
  {#if !value && !composing && placeholder}
    <p aria-hidden="true" class={["pointer-events-none col-start-1 row-start-1 truncate text-zinc-400 select-none dark:text-zinc-500", className]}>{placeholder}</p>
  {/if}
  <div
    bind:this={root}
    {id}
    role="textbox"
    aria-label={label}
    aria-multiline="true"
    aria-placeholder={placeholder || undefined}
    aria-disabled={disabled || undefined}
    aria-autocomplete={sources ? "list" : undefined}
    aria-controls={sources ? `${id}-popup-list` : undefined}
    aria-activedescendant={popupOpen && options.length > 0 ? `${id}-popup-option-${active}` : undefined}
    contenteditable={disabled ? "false" : "true"}
    spellcheck="true"
    tabindex={disabled ? -1 : 0}
    class={["t-composer-input col-start-1 row-start-1 min-w-0 break-words whitespace-pre-wrap text-zinc-950 outline-none dark:text-white [&_.mention-chip]:mx-px", className]}
    data-single-line={singleLine || undefined}
    onpointerdown={(event) => {
      // A sticky footer's normal-flow position is at the end of the thread. Native focus would
      // scroll there before expanding; focus synchronously (also opens iOS's keyboard) without
      // scrolling, then let the pointer's default action place the caret normally.
      if (!disabled && !(event.target as Element).closest("button, input, textarea")) root?.focus({ preventScroll: true });
    }}
    oninput={(event) => {
      if (!inBlockArea(event.target) || inBlock(event.target)) {
        inputSession.input(event instanceof InputEvent ? event : { isComposing: false, inputType: "" });
      }
    }}
    {onkeydown}
    {onbeforeinput}
    {onpaste}
    {ondrop}
    {oncopy}
    oncut={oncopy}
    onkeyup={(event) => {
      if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") detectTrigger();
    }}
    onclick={detectTrigger}
    oncompositionstart={() => { inputSession.start(); composing = true; }}
    oncompositionend={() => inputSession.end()}
    onfocus={() => { inputSession.reset(); composing = false; }}
    onblur={() => {
      inputSession.reset();
      composing = false;
      popupOpen = false;
    }}
    {@attach focusOnMount}
  ></div>
</div>

<style>
  /* The backticks around inline code (inline-code.ts `markTicks`). */
  :global(::highlight(composer-code-tick)) {
    color: var(--color-zinc-400);
  }
  :global(.dark ::highlight(composer-code-tick)) {
    color: var(--color-zinc-500);
  }
</style>
