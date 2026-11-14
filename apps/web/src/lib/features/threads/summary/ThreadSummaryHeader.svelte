<script lang="ts">
  import Icon from "#lib/shared/ui/Icon.svelte";

  /**
   * The open card's header is one toggle, symmetric with the collapsed pill: a click anywhere on it collapses the
   * docked card or closes the popover (heading + button, as in a disclosure; no nested controls). A press that
   * ends as a drag or a text selection does not toggle.
   */
  let { pinned, controls, onclose }: { pinned: boolean; controls: string; onclose: () => void } = $props();

  let start: { x: number; y: number } | undefined;

  function click(event: MouseEvent) {
    const moved = start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4;
    start = undefined;

    // Keyboard activation has no pointer press (detail 0) and always toggles.
    if (event.detail > 0 && (moved || !getSelection()?.isCollapsed)) return;
    onclose();
  }
</script>

<h2 class="density-chrome shrink-0 border-b border-zinc-950/5 dark:border-white/8">
  <button
    type="button"
    aria-expanded="true"
    aria-controls={controls}
    aria-label={pinned ? "Collapse thread details" : "Close thread details"}
    data-summary-collapse
    class="group/summary-head flex h-9 w-full items-center justify-between gap-2 rounded-t-xl pr-2.5 pl-3 text-left text-sm/5 text-zinc-500 focus-ring -outline-offset-2 transition-colors duration-(--duration-fast) hover:bg-zinc-950/3 hover:text-zinc-700 active:bg-zinc-950/6 motion-reduce:transition-none sm:text-xs/5 dark:text-zinc-400 dark:hover:bg-white/4 dark:hover:text-zinc-200 dark:active:bg-white/7"
    onpointerdown={(event) => (start = { x: event.clientX, y: event.clientY })}
    onclick={click}
  >
    <span class="truncate">Thread details</span>
    <Icon
      name={pinned ? "chevron-down" : "x-mark"}
      size="sm"
      class={["shrink-0 opacity-70 group-hover/summary-head:opacity-100", pinned && "rotate-180"]}
    />
  </button>
</h2>
