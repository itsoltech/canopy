<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  /**
   * Handle of a queue row: the queue icon, the grip while the row (`group/row`) is hovered or has focus, always
   * on touch. Dragging it reorders (`ondragstart`; no touch scrolling on it), ↑/↓ on it move the row (the row
   * handles them, Alt+↑/↓ anywhere in it). `element` lets the row put the focus back after a move.
   */
  let {
    label,
    element = $bindable(),
    ondragstart,
    class: className,
  }: { label: string; element?: HTMLButtonElement | undefined; ondragstart: (event: PointerEvent) => void; class?: ClassValue } = $props();
</script>

<button
  bind:this={element}
  type="button"
  class={[
    "relative grid size-9 shrink-0 cursor-grab touch-none place-items-center rounded-lg fill-zinc-400 focus-ring hover:bg-zinc-950/5 hover:fill-zinc-700 sm:size-7 dark:fill-zinc-500 dark:hover:bg-white/10 dark:hover:fill-zinc-200",
    className,
  ]}
  aria-label="Reorder: {label}"
  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
  onpointerdown={ondragstart}
  {@attach tooltip("Drag to reorder, or Alt+↑/↓")}
>
  <Icon name="queue-list" class="col-start-1 row-start-1 fill-inherit pointer-coarse:opacity-0 group-focus-within/row:opacity-0 pointer-fine:group-hover/row:opacity-0" />
  <Icon name="bars-2" class="col-start-1 row-start-1 fill-inherit opacity-0 pointer-coarse:opacity-100 group-focus-within/row:opacity-100 pointer-fine:group-hover/row:opacity-100" />
  <TouchTarget />
</button>
