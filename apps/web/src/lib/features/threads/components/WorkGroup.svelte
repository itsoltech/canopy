<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let {
    label,
    open,
    running,
    ontoggle,
    class: className,
  }: { label: string; open: boolean; running: boolean; ontoggle: () => void; class?: ClassValue } = $props();
</script>

<div class={className}>
  <button
    type="button"
    class="flex w-full min-w-0 items-start gap-2 rounded-md py-2.5 text-left text-base/6 text-zinc-600 focus-ring hover:text-zinc-950 sm:py-1 sm:text-sm/6 dark:text-zinc-400 dark:hover:text-zinc-100"
    aria-expanded={open}
    onclick={ontoggle}
  >
    <span class="flex h-lh shrink-0 items-center"
      ><Icon
        name="chevron-right"
        class={["t-acc-chevron fill-zinc-400 dark:fill-zinc-500", open && "rotate-90"]}
      /></span
    >
    <span class={["min-w-0 truncate", running && "shimmer"]}>{label}</span>
  </button>
</div>
