<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** The surface of settings: one rounded card on the page (a group's rows, one worker). */
  let { class: className, children }: { class?: ClassValue; children: Snippet } = $props();
</script>

<div
  class={[
    "settings-group-body overflow-hidden rounded-2xl bg-white ring-1 ring-zinc-950/10 dark:bg-zinc-950 dark:ring-white/10",
    className,
  ]}
>
  {@render children()}
</div>
