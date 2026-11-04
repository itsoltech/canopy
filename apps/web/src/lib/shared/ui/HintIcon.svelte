<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import { tooltip } from "./tooltip.ts";

  /** Contextual help stays next to its control. Warnings announce changes to their reason. */
  let {
    text,
    label,
    warning = false,
    class: className,
  }: {
    text: string;
    label: string;
    warning?: boolean;
    class?: ClassValue;
  } = $props();
</script>

<span class={["flex shrink-0 items-center", className]}>
  {#if warning}<span class="sr-only" role="status" aria-atomic="true">{text}</span>{/if}
  <button
    type="button"
    aria-label={label}
    class={[
      "grid size-8 shrink-0 place-items-center rounded-md focus-ring pointer-coarse:size-11",
      warning ? "text-amber-700 dark:text-amber-400" : "text-zinc-500 dark:text-zinc-400",
    ]}
    {@attach tooltip(text, { touch: "tap" })}
  >
    <Icon name={warning ? "exclamation-triangle" : "information-circle"} tone="inherit" class="size-3.5" />
  </button>
</span>
