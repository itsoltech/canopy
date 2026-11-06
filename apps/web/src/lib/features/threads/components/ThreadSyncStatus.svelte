<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  let { syncing, class: className }: { syncing: boolean; class?: ClassValue } = $props();
</script>

<p
  role="status"
  aria-atomic="true"
  class={["text-xs text-zinc-500 dark:text-zinc-400", !syncing && "invisible", className]}
>
  Syncing…
</p>
