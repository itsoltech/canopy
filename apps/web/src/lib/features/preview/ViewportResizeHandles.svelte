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
    left: number;
    top: number;
    pointerId: number;
    handle: HTMLButtonElement;
  };

  let {
    browser,
    enabled,
    width,
    height,
    viewport,
    surface,
    onresize,
  }: {
    browser: boolean;
    enabled: boolean;
    width: number;
    height: number;
    viewport?: HTMLDivElement;
    surface?: HTMLDivElement;
    onresize: (width: number, height: number) => void;
  } = $props();

  const edges: ResizeEdge[] = ["left", "right", "top", "bottom"];

  const positions = {
    left: "top-1/2 right-full mr-0.5 h-8 w-2 -translate-y-1/2 cursor-ew-resize",
    right: "top-1/2 left-full ml-0.5 h-8 w-2 -translate-y-1/2 cursor-ew-resize",
    top: "bottom-full left-1/2 mb-0.5 h-2 w-8 -translate-x-1/2 cursor-ns-resize",
    bottom: "top-full left-1/2 mt-0.5 h-2 w-8 -translate-x-1/2 cursor-ns-resize",
  };

  const labels = {
    left: "Resize viewport from the left edge",
    right: "Resize viewport from the right edge",
    top: "Resize viewport from the top edge",
    bottom: "Resize viewport from the bottom edge",
  };

  let resizing = $state<ResizeState>();
  let draft = $state<{ width: number; height: number }>();
  let layer = $state<HTMLDivElement>();
  let position = $state<{ left: number; top: number; width: number; height: number }>();

  const outline = $derived.by(() => {
    if (!resizing || !draft) return position;

    const w = draft.width * resizing.scaleX;
    const h = draft.height * resizing.scaleY;

    return {
      width: w,
      height: h,
      left: resizing.left + (resizing.edge === "left" ? resizing.width * resizing.scaleX - w : 0),
      top: resizing.top + (resizing.edge === "top" ? resizing.height * resizing.scaleY - h : 0),
    };
  });

  $effect(() => {
    if (!enabled || !browser || width !== resizing?.width || height !== resizing?.height) stopResize();
  });

  $effect(() => {
    const target = viewport;
    const overlay = layer;
    const scroller = surface;

    if (!target || !overlay || !scroller) return;

    const measure = () => {
      const box = target.getBoundingClientRect();
      const origin = overlay.getBoundingClientRect();
      position = { left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height };
    };

    const observer = new ResizeObserver(measure);
    observer.observe(target);
    observer.observe(overlay);
    scroller.addEventListener("scroll", measure);
    measure();

    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", measure);
    };
  });

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

  function beginResize(event: PointerEvent & { currentTarget: HTMLButtonElement }, edge: ResizeEdge): void {
    if (event.button !== 0 || resizing || !enabled || !browser || !width || !height || !viewport || !layer) return;
    event.preventDefault();
    event.stopPropagation();

    const box = viewport.getBoundingClientRect();
    const origin = layer.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    draft = { width, height };
    resizing = {
      edge,
      startX: event.clientX,
      startY: event.clientY,
      width,
      height,
      scaleX: box.width / width || 1,
      scaleY: box.height / height || 1,
      left: box.left - origin.left,
      top: box.top - origin.top,
      pointerId: event.pointerId,
      handle: event.currentTarget,
    };
    window.addEventListener("pointermove", resizeMove);
    window.addEventListener("pointerup", resizeEnd);
    window.addEventListener("pointercancel", resizeCancel);
    window.addEventListener("keydown", cancelKey, true);
    window.addEventListener("blur", stopResize);
  }

  function resizeMove(event: PointerEvent): void {
    const state = resizing;

    if (!state || event.pointerId !== state.pointerId) return;
    event.preventDefault();
    draft = resizeDimensions(state, event.clientX, event.clientY);
  }

  function resizeEnd(event: PointerEvent): void {
    const state = resizing;

    if (!state || event.pointerId !== state.pointerId) return;
    const dimensions = resizeDimensions(state, event.clientX, event.clientY);
    stopResize();

    if (dimensions.width !== state.width || dimensions.height !== state.height) {
      onresize(dimensions.width, dimensions.height);
    }
  }

  function resizeCancel(event: PointerEvent): void {
    if (event.pointerId === resizing?.pointerId) stopResize();
  }

  function cancelKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    stopResize();
  }

  function stopResize(): void {
    const state = resizing;
    resizing = undefined;
    draft = undefined;

    if (state?.handle.hasPointerCapture(state.pointerId)) state.handle.releasePointerCapture(state.pointerId);

    if (typeof window === "undefined") return;
    window.removeEventListener("pointermove", resizeMove);
    window.removeEventListener("pointerup", resizeEnd);
    window.removeEventListener("pointercancel", resizeCancel);
    window.removeEventListener("keydown", cancelKey, true);
    window.removeEventListener("blur", stopResize);
  }

  function resizeKey(event: KeyboardEvent, edge: ResizeEdge): void {
    if (resizing || !enabled || !browser) return;
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
  <div bind:this={layer} class="pointer-events-none absolute inset-0 z-10" class:overflow-hidden={!resizing}>
    {#if outline}
      <div
        class="absolute"
        style:left={`${outline.left}px`}
        style:top={`${outline.top}px`}
        style:width={`${outline.width}px`}
        style:height={`${outline.height}px`}
      >
        {#if draft}
          <div class="absolute inset-0 border border-brand-500" aria-hidden="true"></div>
        {/if}
        {#each edges as edge (edge)}
          <button
            type="button"
            class={[
              "group pointer-events-auto absolute flex touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-brand-500",
              positions[edge],
            ]}
            aria-label={labels[edge]}
            onpointerdown={(event) => beginResize(event, edge)}
            onlostpointercapture={resizeCancel}
            onkeydown={(event) => resizeKey(event, edge)}
          >
            <span
              class={[
                "pointer-events-none rounded-full bg-muted/50 group-hover:bg-brand-500 group-focus-visible:bg-brand-500",
                edge === "left" || edge === "right" ? "h-6 w-0.5" : "h-0.5 w-6",
                resizing?.edge === edge && "bg-brand-500",
              ]}
            ></span>
          </button>
        {/each}
      </div>
    {/if}
    {#if draft}
      <div
        class="pointer-events-none absolute right-2 bottom-2 z-10 max-w-full rounded-md border border-divider bg-surface px-2 py-1 text-xs text-ink shadow-sm"
        role="status"
      >
        <span class="whitespace-nowrap tabular-nums">{draft.width} × {draft.height}</span>
        <span class="block text-muted">Release to apply · Esc to cancel</span>
      </div>
    {/if}
  </div>
{/if}
