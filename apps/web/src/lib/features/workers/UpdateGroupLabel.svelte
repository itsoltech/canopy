<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** A group heading inside the updates center: a section (Computers, Workers) or a computer's name. */
  let { class: className, children }: { class?: ClassValue; children: Snippet } = $props();
</script>

<h3 class={["truncate pt-2 text-xs/5 font-medium text-muted", className]}>{@render children()}</h3>
