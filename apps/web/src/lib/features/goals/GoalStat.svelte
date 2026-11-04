<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** One figure of a goal's usage in a `<dl>`: label, value and optional content under it (a meter). */
  let {
    label,
    value,
    children,
    class: className,
  }: { label: string; value: Snippet; children?: Snippet; class?: ClassValue } = $props();
</script>

<div class={["grid content-start gap-0.5", className]}>
  <dt class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{label}</dt>
  <dd class="text-base/6 font-medium text-zinc-950 tabular-nums sm:text-sm/5 dark:text-white">{@render value()}</dd>
  {@render children?.()}
</div>
