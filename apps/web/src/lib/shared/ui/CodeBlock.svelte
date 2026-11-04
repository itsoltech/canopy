<script lang="ts">
  import type { ClassValue, HTMLAttributes } from "svelte/elements";

  /**
   * Preformatted text (output, JSON, code). Scrolls inside a capped height; `tabindex` makes the
   * scroll area reachable by keyboard. Other attributes go on the `<pre>` (e.g. `data-quote-kind`).
   */
  let {
    text,
    label,
    class: className,
    ...rest
  }: { text: string; label: string; class?: ClassValue } & Omit<HTMLAttributes<HTMLPreElement>, "class"> = $props();
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<pre
  {...rest}
  class={[
    "max-h-96 code-surface rounded-lg bg-zinc-950/2.5 p-3 text-zinc-800 focus-ring dark:bg-white/5 dark:text-zinc-200",
    className,
  ]}
  tabindex="0"
  aria-label={label}>{text}</pre>
