<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";

  /**
   * Native `<details>`: keyboard and screen-reader support without script. The summary is a full-width
   * row with a rotating chevron; `open` is bindable so callers can expand on events (e.g. a failure).
   */
  let {
    open = $bindable(false),
    class: className,
    summaryClass,
    summary,
    children,
  }: { open?: boolean; class?: ClassValue; summaryClass?: ClassValue; summary: Snippet; children: Snippet } = $props();
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
