<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";

  /** Nothing here yet: what this place is for and, optionally, the action that fills it. */
  let {
    icon,
    title,
    description,
    class: className,
    action,
  }: { icon?: IconName; title: string; description?: string; class?: ClassValue; action?: Snippet } = $props();
</script>

<div class={["flex flex-col items-center rounded-xl border border-dashed border-zinc-950/15 px-6 py-10 text-center dark:border-white/15", className]}>
  {#if icon}<Icon name={icon} class="fill-zinc-400 dark:fill-zinc-500" />{/if}
  <p class="mt-3 text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">{title}</p>
  {#if description}<p class="mt-1 max-w-[50ch] text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">{description}</p>{/if}
  {#if action}<div class="mt-4">{@render action()}</div>{/if}
</div>
