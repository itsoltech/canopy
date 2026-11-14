<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  let { children, class: className }: { children: Snippet; class?: ClassValue } = $props();
</script>

<div class={["flex min-h-8 items-center gap-x-2 text-sm/5 sm:min-h-7 sm:text-xs/5", className]}>
  <div class="t-quiet t-quiet-touch flex min-w-0 items-center">
    {@render children()}
  </div>
</div>
