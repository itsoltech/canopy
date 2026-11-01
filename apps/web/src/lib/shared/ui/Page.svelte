<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Scrolling page body with the app's content width and gutters. */
  let { class: className, children }: { class?: ClassValue; children: Snippet } = $props();
</script>

<div class="h-full overflow-y-auto">
  <div class={["mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8 lg:py-10", className]}>
    {@render children()}
  </div>
</div>
