<script lang="ts">
  import { onDestroy } from "svelte";

  type ResizeEdge = "left" | "right" | "top" | "bottom";

  type ResizeState = {
    edge: ResizeEdge;
    startX: number;
    startY: number;
    width: number;
    height: number;
    scaleX: number;
    scaleY: number;
    lastSentAt: number;
  };

  let {
    browser,
    enabled,
    width,
    height,
    viewport,
    onresize,
  }: {
    browser: boolean;
    enabled: boolean;
    width: number;
    height: number;
    viewport?: HTMLDivElement;
    onresize: (width: number, height: number) => void;
  } = $props();

  let resizing = $state<ResizeState>();

  onDestroy(stopResize);

  function resizeValue(value: number): number {
    return Math.max(1, Math.min(8192, Math.round(value)));
  }

  function resizeDimensions(state: ResizeState, clientX: number, clientY: number) {
    const deltaX = (clientX - state.startX) / state.scaleX;
    const deltaY = (clientY - state.startY) / state.scaleY;

    return {
      width: resizeValue(state.width + (state.edge === "right" ? deltaX : state.edge === "left" ? -deltaX : 0)),
      height: resizeValue(state.height + (state.edge === "bottom" ? deltaY : state.edge === "top" ? -deltaY : 0)),
    };
  }

  function beginResize(event: PointerEvent, edge: ResizeEdge): void {
    if (!enabled || !browser || !width || !height || !viewport) return;
    event.preventDefault();
    event.stopPropagation();

    const box = viewport.getBoundingClientRect();
    resizing = {
      edge,
      startX: event.clientX,
      startY: event.clientY,
      width,
      height,
      scaleX: box.width / width || 1,
      scaleY: box.height / height || 1,
      lastSentAt: 0,
    };
    window.addEventListener("pointermove", resizeMove);
    window.addEventListener("pointerup", resizeEnd, { once: true });
    window.addEventListener("pointercancel", resizeCancel, { once: true });
  }

  function resizeMove(event: PointerEvent): void {
    const state = resizing;

    if (!state) return;
    event.preventDefault();
    const dimensions = resizeDimensions(state, event.clientX, event.clientY);
    const now = Date.now();

    if (now - state.lastSentAt >= 120) {
      state.lastSentAt = now;
      onresize(dimensions.width, dimensions.height);
    }
  }

  function resizeEnd(event: PointerEvent): void {
    const state = resizing;

    if (!state) return;
    const dimensions = resizeDimensions(state, event.clientX, event.clientY);
    stopResize();
    onresize(dimensions.width, dimensions.height);
  }

  function resizeCancel(): void {
    stopResize();
  }

  function stopResize(): void {
    resizing = undefined;

    if (typeof window === "undefined") return;
    window.removeEventListener("pointermove", resizeMove);
    window.removeEventListener("pointerup", resizeEnd);
    window.removeEventListener("pointercancel", resizeCancel);
  }

  function resizeKey(event: KeyboardEvent, edge: ResizeEdge): void {
    const step = event.shiftKey ? 64 : 16;

    const grows =
      (edge === "left" && event.key === "ArrowLeft") ||
      (edge === "right" && event.key === "ArrowRight") ||
      (edge === "top" && event.key === "ArrowUp") ||
      (edge === "bottom" && event.key === "ArrowDown");

    const shrinks =
      (edge === "left" && event.key === "ArrowRight") ||
      (edge === "right" && event.key === "ArrowLeft") ||
      (edge === "top" && event.key === "ArrowDown") ||
      (edge === "bottom" && event.key === "ArrowUp");

    if (!grows && !shrinks) return;
    event.preventDefault();
    onresize(
      resizeValue(width + (edge === "left" || edge === "right" ? (grows ? step : -step) : 0)),
      resizeValue(height + (edge === "top" || edge === "bottom" ? (grows ? step : -step) : 0)),
    );
  }
</script>

{#if browser && enabled && width && height}
  <button
    type="button"
    class="absolute top-1/2 -left-1.5 h-12 w-3 -translate-y-1/2 cursor-ew-resize rounded-full bg-brand-500/70 outline-none hover:bg-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500"
    aria-label="Resize viewport from the left edge"
    onpointerdown={(event) => beginResize(event, "left")}
    onkeydown={(event) => resizeKey(event, "left")}
  ></button>
  <button
    type="button"
    class="absolute top-1/2 -right-1.5 h-12 w-3 -translate-y-1/2 cursor-ew-resize rounded-full bg-brand-500/70 outline-none hover:bg-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500"
    aria-label="Resize viewport from the right edge"
    onpointerdown={(event) => beginResize(event, "right")}
    onkeydown={(event) => resizeKey(event, "right")}
  ></button>
  <button
    type="button"
    class="absolute -top-1.5 left-1/2 h-3 w-12 -translate-x-1/2 cursor-ns-resize rounded-full bg-brand-500/70 outline-none hover:bg-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500"
    aria-label="Resize viewport from the top edge"
    onpointerdown={(event) => beginResize(event, "top")}
    onkeydown={(event) => resizeKey(event, "top")}
  ></button>
  <button
    type="button"
    class="absolute -bottom-1.5 left-1/2 h-3 w-12 -translate-x-1/2 cursor-ns-resize rounded-full bg-brand-500/70 outline-none hover:bg-brand-500 focus-visible:ring-2 focus-visible:ring-brand-500"
    aria-label="Resize viewport from the bottom edge"
    onpointerdown={(event) => beginResize(event, "bottom")}
    onkeydown={(event) => resizeKey(event, "bottom")}
  ></button>
{/if}
