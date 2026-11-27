<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";

  /** One disclosure contract for agents, queue and questions. Keep drafts mounted and
   * remove folded controls from focus/navigation. The outline belongs outside this clip.
   * It opens over the thread (`data-feed-overlay`, footer-edge.ts): no row moves with it. */
  let {
    id,
    open,
    children,
    class: className,
  }: { id: string; open: boolean; children: Snippet; class?: ClassValue } = $props();
</script>

<div
  {id}
  class={["t-acc-panel t-composer-disclosure", className]}
  data-open={open || undefined}
  inert={!open}
  data-feed-overlay
>
  <div>
    <div
      class="max-h-[20dvh] scroll-stable overflow-y-auto overscroll-contain border-t border-zinc-950/5 dark:border-white/10"
    >
      {@render children()}
    </div>
  </div>
</div>
