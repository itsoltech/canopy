<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { clampSize, keySize, type ResizeChange } from "./resize-handle.ts";

  /**
   * Resize handle on the edge of a panel (WAI-ARIA window splitter): a thin hit area (wider under a
   * finger) with a line that shows on hover, focus and while dragging. A drag follows the pointer (mouse,
   * pen, touch; pointer capture, one update per frame); arrows step (Shift further), Home / End jump to
   * `min` / `max`, Enter or a double-click go back to `reset`, Escape cancels a drag. The handle sizes
   * nothing itself: `onresize` reports the size live while dragging, `onchange` once a change is done
   * (save it there). Place it in a `relative` box on the panel's edge.
   *
   *   <ResizeHandle label="Resize sidebar" value={width} min={220} max={560} reset={288} onresize={…} onchange={…} />
   */
  let {
    value,
    min,
    max,
    reset,
    label,
    grows = "right",
    collapsible = false,
    controls,
    dragging = $bindable(false),
    onresize,
    onchange,
    class: className,
  }: {
    /** The panel's size now, px. */
    value: number;
    min: number;
    max: number;
    reset: number;
    label: string;
    /** The direction a drag makes the panel larger: "right" for a panel on the left. */
    grows?: "right" | "left";
    /** Dragging past half the minimum collapses the panel. */
    collapsible?: boolean;
    /** Id of the panel. */
    controls?: string | undefined;
    dragging?: boolean;
    onresize?: ((size: number, collapsed: boolean) => void) | undefined;
    onchange?: ((change: ResizeChange) => void) | undefined;
    class?: ClassValue;
  } = $props();

  let drag: { id: number; x: number; size: number; last: number; collapsed: boolean; handle: HTMLElement } | undefined;
  let frame = 0;
  const range = $derived({ min, max, reset });

  interface Size {
    size: number;
    collapsed: boolean;
  }

  function sizeAt(x: number): Size {
    if (!drag) return { size: value, collapsed: false };
    const raw = drag.size + (grows === "right" ? x - drag.x : drag.x - x);

    if (collapsible && raw < min / 2) return { size: drag.size, collapsed: true };

    return { size: clampSize(raw, range), collapsed: false };
  }

  function follow(x: number) {
    if (!drag) return;
    const next = sizeAt(x);
    drag.last = next.size;
    drag.collapsed = next.collapsed;
    drag.handle.setAttribute("aria-valuenow", String(next.size));
    drag.handle.setAttribute("aria-valuetext", `${next.size} pixels`);
    onresize?.(next.size, next.collapsed);
  }

  function end(commit: boolean, x?: number) {
    if (!drag) return;
    cancelAnimationFrame(frame);
    frame = 0;

    if (commit && x !== undefined) follow(x);
    const { size, last, collapsed, handle } = drag;
    drag = undefined;
    dragging = false;
    delete document.documentElement.dataset["resizing"];

    if (!commit) {
      handle.setAttribute("aria-valuenow", String(size));
      handle.setAttribute("aria-valuetext", `${size} pixels`);
      onresize?.(size, false);
    } else if (last !== size || collapsed) onchange?.({ size: last, collapsed, reason: "drag" });
  }

  function onpointerdown(event: PointerEvent & { currentTarget: HTMLElement }) {
    if (event.button !== 0 || event.detail > 1) return;
    event.preventDefault(); // no text selection, no focus jump
    event.currentTarget.setPointerCapture(event.pointerId);
    drag = {
      id: event.pointerId,
      x: event.clientX,
      size: value,
      last: value,
      collapsed: false,
      handle: event.currentTarget,
    };
    dragging = true;
    // Keeps the cursor and stops text selection anywhere on the page while dragging (layout.css).
    document.documentElement.dataset["resizing"] = "x";
  }

  function onpointermove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    const x = event.clientX;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      follow(x);
    });
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === "Escape" && drag) {
      event.preventDefault();
      end(false);

      return;
    }

    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const next = keySize(event.key, event.shiftKey, value, range, grows === "right" ? "ArrowRight" : "ArrowLeft");

    if (next === undefined) return;
    event.preventDefault();

    if (next === "reset") onchange?.({ size: reset, collapsed: false, reason: "reset" });
    else if (next !== value) onchange?.({ size: next, collapsed: false, reason: "key" });
  }

  $effect(() => () => end(false));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-orientation="vertical"
  aria-label={label}
  aria-controls={controls}
  aria-valuenow={value}
  aria-valuemin={min}
  aria-valuemax={max}
  aria-valuetext="{value} pixels"
  tabindex="0"
  data-dragging={dragging || undefined}
  class={[
    "group absolute inset-y-0 w-2 cursor-col-resize touch-none select-none focus:outline-none pointer-coarse:w-4",
    grows === "right" ? "-right-1 pointer-coarse:-right-2" : "-left-1 pointer-coarse:-left-2",
    className,
  ]}
  {onpointerdown}
  {onpointermove}
  onpointerup={(event) => event.pointerId === drag?.id && end(true, event.clientX)}
  onpointercancel={(event) => event.pointerId === drag?.id && end(true)}
  onlostpointercapture={(event) => event.pointerId === drag?.id && end(true)}
  ondblclick={() => onchange?.({ size: reset, collapsed: false, reason: "reset" })}
  {onkeydown}
>
  <span
    class="pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 group-hover:bg-zinc-950/15 group-focus-visible:bg-brand-500 group-data-dragging:bg-brand-500 dark:group-hover:bg-white/20"
  ></span>
</div>
