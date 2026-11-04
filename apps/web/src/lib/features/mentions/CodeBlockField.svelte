<script lang="ts">
  import { untrack } from "svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import CodeFrame from "#lib/shared/ui/code/CodeFrame.svelte";
  import CodeLines from "#lib/shared/ui/code/CodeLines.svelte";
  import LanguagePicker from "#lib/shared/ui/code/LanguagePicker.svelte";
  import { LANGUAGE_NAMES, languageOf } from "#lib/shared/ui/code/languages.ts";

  /**
   * A fenced code block inside the composer (MentionEditor mounts one into each block element, code-blocks.ts): the
   * language pill and a remove button above the code. The code is a `<textarea>` with transparent text over its own
   * highlighted copy (`CodeLines`: Shiki, lazy and incremental), so typing, IME, paste (verbatim), undo and mobile
   * keyboards are the browser's own; both wrap the same way, so the caret sits on the coloured text.
   *
   * Keys: Enter and Shift+Enter add a line (keeping its indentation), Tab / Shift+Tab indent and outdent the line or
   * the selected lines; ArrowDown on the last line, ArrowRight at the end, Enter on an empty last line or on a line of
   * just the closing fence leave the block below; ArrowUp on the first line and ArrowLeft at the start leave it above;
   * Backspace in an empty block removes it. Mod+Enter goes on to the composer (send).
   */
  let {
    code: initialCode,
    lang: initialLang,
    fresh = false,
    oncode,
    onlang,
    onexit,
    onremove,
  }: {
    code: string;
    lang: string;
    /** Just typed: it rises in. */
    fresh?: boolean;
    oncode: (code: string) => void;
    onlang: (lang: string) => void;
    /** Leave the block, the caret on the line next to it; false when there is none (nothing above). */
    onexit: (side: "before" | "after") => boolean;
    onremove: () => void;
  } = $props();

  // The textarea owns the code from here: the props are where it starts.
  let code = $state(untrack(() => initialCode));
  let lang = $state(untrack(() => initialLang));
  let area = $state<HTMLTextAreaElement>();
  const language = $derived(languageOf(lang));

  // The copy keeps a last empty line visible (a <pre> drops a trailing line break).
  const mirror = $derived(code === "" || code.endsWith("\n") ? `${code} ` : code);
  const INDENT = "  ";

  export function focus(where: "start" | "end") {
    if (!area) return;
    area.focus({ preventScroll: true });
    const at = where === "start" ? 0 : area.value.length;
    area.setSelectionRange(at, at);
    area.scrollIntoView({ block: "nearest" });
  }

  /** Replaces the selection through the browser, so Undo takes it back. */
  function insert(text: string) {
    if (!area) return;

    if (!document.execCommand("insertText", false, text))
      area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
    sync();
  }

  function sync() {
    if (!area) return;
    code = area.value;
    oncode(code);
  }

  /** Tab / Shift+Tab: the caret's line or every selected line, by two spaces (outdent also takes a tab). */
  function indent(outdent: boolean) {
    if (!area) return;
    const { selectionStart: start, selectionEnd: end, value } = area;

    if (!outdent && start === end) return insert(INDENT);
    const from = value.lastIndexOf("\n", start - 1) + 1;
    let to = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);

    if (to < 0) to = value.length;
    const lines = value.slice(from, to).split("\n");
    const next = lines.map((line) => (outdent ? line.replace(/^( {1,2}|\t)/, "") : INDENT + line)).join("\n");

    if (next === value.slice(from, to)) return;
    area.setSelectionRange(from, to);
    insert(next);

    if (start === end) {
      const removed = lines[0]!.length - next.length;
      const at = Math.max(from, start - removed);
      area.setSelectionRange(at, at);
    } else area.setSelectionRange(from, from + next.length);
  }

  /** Deletes `[from, to)` of the code through the browser. */
  function remove(from: number, to: number) {
    if (!area) return;
    area.setSelectionRange(from, to);
    document.execCommand("delete");
    sync();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.isComposing || !area) return;
    const { selectionStart: start, selectionEnd: end, value } = area;
    const mod = event.metaKey || event.ctrlKey;
    const plain = !mod && !event.altKey;

    if (event.key === "Tab" && plain) {
      event.preventDefault();
      indent(event.shiftKey);

      return;
    }

    if (event.key === "Enter" && plain) {
      // A line, never a message.
      event.stopPropagation();

      if (start !== end) return;
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const line = value.slice(lineStart, start);
      const atEnd = start === value.length;

      if (atEnd && !event.shiftKey && line === "" && value.endsWith("\n")) {
        event.preventDefault();
        remove(start - 1, start);
        onexit("after");

        return;
      }

      if (atEnd && /^`{3,}$/.test(line)) {
        // The closing fence was typed: the block ends where it started.
        event.preventDefault();
        remove(Math.max(0, lineStart - 1), start);
        onexit("after");

        return;
      }

      const indentation = /^[ \t]*/.exec(line)?.[0] ?? "";

      if (indentation) {
        event.preventDefault();
        insert(`\n${indentation}`);
      }

      return;
    }

    if (event.key === "Backspace" && plain && value === "") {
      event.preventDefault();
      onremove();

      return;
    }

    if (start !== end || event.shiftKey || !plain) return;

    if (
      (event.key === "ArrowDown" && !value.includes("\n", start)) ||
      (event.key === "ArrowRight" && start === value.length)
    ) {
      event.preventDefault();
      onexit("after");
    } else if (
      (event.key === "ArrowUp" && !value.slice(0, start).includes("\n")) ||
      (event.key === "ArrowLeft" && start === 0)
    ) {
      if (onexit("before")) event.preventDefault();
    }
  }
</script>

<!-- whitespace-normal: the editor keeps whitespace (pre-wrap), the field's own markup must not. -->
<CodeFrame class={["whitespace-normal", fresh && "t-rise"]}>
  {#snippet header()}
    <LanguagePicker
      value={lang}
      onselect={(tag) => {
        lang = tag;
        onlang(tag);
        focus("end");
      }}
      class="my-0.5 ml-1"
    />
    <IconButton icon="x-mark" label="Remove code block" size="sm" onclick={onremove} />
  {/snippet}
  <div class="grid grid-cols-1 font-mono text-[0.8125rem]/5 [tab-size:4] max-sm:text-base/6">
    <pre
      aria-hidden="true"
      class="pointer-events-none col-start-1 row-start-1 p-3 break-words whitespace-pre-wrap text-zinc-800 dark:text-zinc-200"><CodeLines
        text={mirror}
        lang={language}
      /></pre>
    <textarea
      bind:this={area}
      {@attach (node) => {
        node.value = initialCode;
      }}
      rows="1"
      aria-label={language ? `Code, ${LANGUAGE_NAMES[language]}` : "Code"}
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      class="col-start-1 row-start-1 resize-none overflow-hidden bg-transparent p-3 break-words whitespace-pre-wrap text-transparent caret-zinc-950 outline-none selection:bg-brand-500/25 dark:caret-white"
      oninput={sync}
      {onkeydown}></textarea>
  </div>
</CodeFrame>
