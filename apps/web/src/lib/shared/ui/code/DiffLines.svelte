<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import CodeTokens from "./CodeTokens.svelte";
  import { languageOfDiff, parseDiff, type DiffLineKind } from "./diff.ts";
  import { Highlight } from "./highlight.svelte.ts";
  import type { LanguageId } from "./languages.ts";

  /**
   * The lines of a unified diff: added and removed lines on green and red, hunk headers in sky. The code
   * is syntax-highlighted in `lang` (by default the language of the file the diff names), each side of
   * the change as its own text so strings and comments carry across lines; the +/- sign keeps the line's
   * tone. Plain text when it is not a diff. While `streaming`, each new line resolves in (`t-stream-line`).
   */
  let {
    diff,
    lang,
    streaming = false,
    class: className,
  }: { diff: string; lang?: LanguageId | undefined; streaming?: boolean; class?: ClassValue } = $props();

  const parsed = $derived(parseDiff(diff));
  const language = $derived(lang ?? languageOfDiff(diff));

  const next = new Highlight(
    () => parsed.next,
    () => language,
  );

  const old = new Highlight(
    () => parsed.old,
    () => language,
  );

  const background: Partial<Record<DiffLineKind, string>> = { add: "bg-emerald-500/10", del: "bg-rose-500/10" };

  const color: Record<DiffLineKind, string> = {
    add: "text-emerald-900 dark:text-emerald-200",
    del: "text-rose-900 dark:text-rose-200",
    hunk: "text-sky-700 dark:text-sky-400",
    file: "text-zinc-500 dark:text-zinc-400",
    ctx: "text-zinc-700 dark:text-zinc-300",
  };

  const sign: Partial<Record<DiffLineKind, string>> = {
    add: "text-emerald-700 dark:text-emerald-400",
    del: "text-rose-700 dark:text-rose-400",
  };
</script>

<div class={["inline-block min-w-full", className]}>
  {#each parsed.lines as line, index (index)}
    {@const found = line.at < 0 ? undefined : (line.kind === "del" ? old : next).lines[line.at]}
    {@const highlighted = line.text && found?.text === line.code ? found : undefined}
    <!-- One line each: the surface keeps whitespace. -->
    <div
      class={[
        "px-3",
        background[line.kind],
        highlighted ? "text-(--code-fg)" : color[line.kind],
        streaming && "t-stream-line",
      ]}
    >
      {#if highlighted}<span class={sign[line.kind]}>{line.text.slice(0, line.text.length - line.code.length)}</span
        ><CodeTokens tokens={highlighted.tokens} />{:else}{line.text || " "}{/if}
    </div>
  {/each}
</div>
