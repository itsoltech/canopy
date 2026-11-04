<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** One disclosure contract for agents, queue and questions. Keep drafts mounted and
   * remove folded controls from focus/navigation. The outline belongs outside this clip. */
  let {
    id,
    open,
    children,
    class: className,
  }: { id: string; open: boolean; children: Snippet; class?: ClassValue } = $props();
</script>

<div {id} class={["t-acc-panel", className]} data-open={open || undefined} inert={!open}>
  <div>{@render children()}</div>
</div>
