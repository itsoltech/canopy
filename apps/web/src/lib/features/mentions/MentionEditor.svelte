<script lang="ts">
  import type { Mention } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import { caretAfter, caretAtPoint, chipBeforeCaret, ensureCaret, selectBackFromCaret, selectNode, textBeforeCaret } from "./caret.ts";
  import { activeTrigger, iconKey, serialize, toHtml, type ActiveTrigger, type TriggerChar } from "./editor.ts";
  import { INLINE_RENDERERS, type MentionData } from "./kinds.ts";
  import MentionList from "./MentionList.svelte";
  import type { MentionOption, MentionSources } from "./sources.svelte.ts";

  /**
   * The composer's text field with inline mentions (docs/ui-api.md, "Wzmianki"): a contenteditable whose model is
   * `value` (plain text) and `mentions` (ranges in it). Typing a trigger at the start of a line or after a space
   * opens the popup above the composer: "/" commands, "$" skills and plugins (Codex's convention), "@" files of
   * the thread's folder, "#" other threads. ↑↓ move, Enter or Tab insert the chip, Escape closes; a tap inserts too.
   * A chip is one unit: Backspace next to it removes it whole (and Undo brings it back).
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
  let composing = $state(false);
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

  // An outside change (cleared after sending, a restored draft): render it.
  $effect(() => {
    const text = value;
    const key = mentionsKey(mentions);
    if (!root || (text === shown.text && key === shown.key)) return;
    root.innerHTML = toHtml({ text, mentions }, icons);
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

  /** Reads the model back from the DOM after the browser changed it. */
  function sync() {
    if (!root || composing) return;
    const next = serialize(root);
    shown = { text: next.text, key: mentionsKey(next.mentions) };
    value = next.text;
    mentions = next.mentions;
    detectTrigger();
  }

  function detectTrigger() {
    if (!sources) return;
    const before = root ? textBeforeCaret(root) : undefined;
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
      chip.removeAttribute("data-inserted");
      caretAfter(chip);
    }
    sync();
  }

  /** Plain text at the caret: lines as text and line breaks (no markup from the clipboard). */
  function insertPlain(text: string) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    lines.forEach((line, i) => {
      if (i > 0) document.execCommand("insertLineBreak");
      if (line) document.execCommand("insertText", false, line);
    });
    sync();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing || composing) return;
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
    if (event.defaultPrevented) return;
    const text = event.clipboardData?.getData("text/plain");
    event.preventDefault();
    if (text) insertPlain(text);
  }

  function ondrop(event: DragEvent) {
    if (event.defaultPrevented || event.dataTransfer?.types.includes("Files")) return;
    const text = event.dataTransfer?.getData("text/plain");
    event.preventDefault();
    if (!text) return;
    if (!root) return;
    caretAtPoint(root, event.clientX, event.clientY);
    root.focus();
    insertPlain(text);
  }

  editor = {
    focus: () => root?.focus(),
    insertTrigger(char: TriggerChar) {
      if (!root) return;
      root.focus();
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
<div class="grid grid-cols-1">
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
    class={["col-start-1 row-start-1 max-h-72 min-h-16 overflow-y-auto break-words whitespace-pre-wrap text-zinc-950 outline-none dark:text-white [&_.mention-chip]:mx-px", className]}
    oninput={sync}
    {onkeydown}
    {onbeforeinput}
    {onpaste}
    {ondrop}
    onkeyup={(event) => {
      if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") detectTrigger();
    }}
    onclick={detectTrigger}
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => {
      composing = false;
      sync();
    }}
    onblur={() => (popupOpen = false)}
    {@attach focusOnMount}
  ></div>
</div>

{#if sources && anchor}
  <Popover bind:open={popupOpen} label="{label}: suggestions" {anchor} role="none" focusOnOpen={false} placement="top-start" class="w-(--float-anchor-width) max-w-[calc(100vw-1rem)]">
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
  </Popover>
{/if}
