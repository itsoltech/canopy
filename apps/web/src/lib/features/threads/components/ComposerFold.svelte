<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** Keep draft/panel state mounted while taking hidden controls out of the focus order. */
  let { open, children, class: className }: { open: boolean; children: Snippet; class?: ClassValue } = $props();
</script>

<div class={["t-composer-fold", className]} data-open={open || undefined} inert={!open}>
  <div>{@render children()}</div>
</div>
