<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** A dialog's (or a form's) buttons: stacked with the primary on top on phones, in a row on the right from `sm`. */
  let { class: className, children }: { class?: ClassValue; children: Snippet } = $props();
</script>

<div class={["flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className]}>{@render children()}</div>
