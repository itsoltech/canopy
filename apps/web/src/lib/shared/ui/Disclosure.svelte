<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { untrack } from "svelte";
  import Icon from "./Icon.svelte";
  import { useRemembered } from "./memory.ts";

  /**
   * Native `<details>`: keyboard and screen-reader support without script. The summary is a full-width
   * row with a rotating chevron; `open` is bindable so callers can expand on events (e.g. a failure).
   * `remember` names it in the surrounding UI memory (rows of a virtual list): remounted, it opens as it was.
   */
  let {
    open = $bindable(false),
    remember,
    class: className,
    summaryClass,
    summary,
    children,
  }: { open?: boolean; remember?: string; class?: ClassValue; summaryClass?: ClassValue; summary: Snippet; children: Snippet } = $props();

  const memory = untrack(() => (remember ? useRemembered<boolean>(remember) : undefined));
  const saved = memory?.get();
  if (saved !== undefined) open = saved;
  $effect(() => memory?.set(open));
</script>

<details class={["group/disclosure", className]} bind:open>
  <summary class={["flex cursor-pointer list-none items-start gap-2 rounded-md focus-ring select-none", summaryClass]}>
    <span class="flex h-lh items-center">
      <Icon name="chevron-right" class="fill-zinc-400 group-open/disclosure:rotate-90 motion-safe:transition-transform dark:fill-zinc-500" />
    </span>
    <span class="min-w-0 flex-1">{@render summary()}</span>
  </summary>
  {#if open}{@render children()}{/if}
</details>
