<script lang="ts">
  import type { ClassValue, HTMLAttributes } from "svelte/elements";
  import { OutputChunks } from "./streaming/output-chunks.ts";

  /**
   * Preformatted text (output, JSON, code). Scrolls inside a capped height; `tabindex` makes the
   * scroll area reachable by keyboard. Containment keeps streaming text layout/paint inside this surface.
   * Line-aligned chunks keep previous text layout intact; their concatenation preserves selection exactly.
   * Other attributes go on the `<pre>` (e.g. `data-quote-kind`).
   */
  let {
    text,
    label,
    class: className,
    ...rest
  }: { text: string; label: string; class?: ClassValue } & Omit<HTMLAttributes<HTMLPreElement>, "class"> = $props();

  const buffer = new OutputChunks();
  const chunks = $derived(buffer.update(text));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<pre
  {...rest}
  class={[
    "max-h-96 code-surface rounded-lg bg-zinc-950/2.5 p-3 text-zinc-800 focus-ring [contain:content] dark:bg-white/5 dark:text-zinc-200",
    className,
  ]}
  tabindex="0"
  aria-label={label}>{#each chunks as chunk, index (index)}<span class="block w-max min-w-full [contain:layout_style]"
      >{chunk}</span
    >{/each}</pre>
