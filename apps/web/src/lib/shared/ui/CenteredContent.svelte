<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Centre a page's content when it fits; let it grow down and scroll in short windows. */
  let {
    children,
    bottomClass = "pb-16",
    class: className,
  }: { children: Snippet; bottomClass?: ClassValue; class?: ClassValue } = $props();
</script>

<div class="min-h-0 flex-1 overflow-y-auto">
  <div class={["flex min-h-full flex-col items-center px-4 pt-6 sm:px-6", bottomClass]}>
    <div class={["my-auto w-full shrink-0", className]}>{@render children()}</div>
  </div>
</div>
