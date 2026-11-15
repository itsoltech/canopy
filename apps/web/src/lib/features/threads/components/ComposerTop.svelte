<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** One overlap, shared by the queue, questions and future status strips. Panels themselves never offset each other. */
  let {
    children,
    decision = false,
    class: className,
  }: { children: Snippet; decision?: boolean; class?: ClassValue } = $props();
</script>

<div
  data-composer-panels
  class={[
    "grid min-h-0 grid-cols-1 bg-white ring-1 ring-zinc-950/10 dark:bg-zinc-950 dark:ring-white/10",
    decision ? "overflow-hidden rounded-2xl" : "rounded-t-2xl pb-4",
    className,
  ]}
>
  <!-- Each panel owns its reading area; disclosure headers stay outside scrolling and its gutter. -->
  <div class="min-h-0 rounded-t-2xl">
    <div class="divide-y divide-zinc-950/10 dark:divide-white/10">{@render children()}</div>
  </div>
</div>
