<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";

  let {
    icon,
    label,
    children,
    aside,
    class: className,
  }: { icon: IconName; label: string; children: Snippet; aside?: Snippet; class?: ClassValue } = $props();
</script>

<div class={["grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1 px-2 py-2", className]}>
  <Icon name={icon} class="row-span-2 mt-0.5 shrink-0" />
  <p class="col-span-2 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">{label}</p>
  <div class="col-start-2 grid min-w-0 gap-1">{@render children()}</div>
  {#if aside}<div class="col-start-3 row-start-2 flex h-5 shrink-0 items-center">{@render aside()}</div>{/if}
</div>
