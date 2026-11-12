<script lang="ts">
  import type { HTMLAnchorAttributes } from "svelte/elements";

  /** Inline content stays selectable; ending a selection must not follow or activate its link. */
  let {
    children,
    href,
    onactivate,
    element = $bindable<HTMLAnchorElement>(),
    class: className,
    ...rest
  }: HTMLAnchorAttributes & { onactivate?: () => void; element?: HTMLAnchorElement | undefined } = $props();

  let start: { x: number; y: number } | undefined;
  let dragged = false;

  function click(event: MouseEvent) {
    const moved = dragged;
    dragged = false;

    if ((event.detail > 0 && moved) || event.detail > 1 || window.getSelection()?.isCollapsed === false) {
      event.preventDefault();

      return;
    }

    if (!onactivate) return;
    event.preventDefault();

    if (event.button === 0 && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) onactivate();
  }
</script>

<a
  {...rest}
  bind:this={element}
  {href}
  role={href ? undefined : "link"}
  tabindex={href ? undefined : 0}
  draggable="false"
  class={["cursor-pointer select-text", className]}
  onpointerdown={(event) => {
    start = { x: event.clientX, y: event.clientY };
    dragged = false;
  }}
  onpointermove={(event) => {
    if (start && event.buttons && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3) dragged = true;
  }}
  onclick={click}
  onkeydown={(event) => {
    if (!href && event.key === "Enter") {
      event.preventDefault();
      onactivate?.();
    }
  }}>{@render children?.()}</a
>
