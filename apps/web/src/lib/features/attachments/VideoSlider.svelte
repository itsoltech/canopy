<script lang="ts">
  let {
    label,
    value,
    max,
    step,
    changed,
    buffered = 0,
    format,
    previewTime,
  }: {
    label: string;
    value: number;
    max: number;
    step: number;
    changed: (value: number) => void;
    buffered?: number;
    format: (value: number) => string;
    previewTime?: boolean;
  } = $props();

  let hoverAt = $state<number>();
  let focused = $state(false);
  let pressed = $state(false);
  const ratio = $derived(max > 0 ? Math.min(1, value / max) : 0);
  const preview = $derived(hoverAt ?? (focused ? ratio : undefined));

  function pointerRatio(event: PointerEvent & { currentTarget: HTMLElement }) {
    const rect = event.currentTarget.getBoundingClientRect();

    return Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width)));
  }

  function pointerDown(event: PointerEvent & { currentTarget: HTMLElement }) {
    if (!max || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    pressed = true;
    const at = pointerRatio(event);
    hoverAt = at;
    changed(at * max);
  }

  function pointerMove(event: PointerEvent & { currentTarget: HTMLElement }) {
    if (!max) return;
    const at = pointerRatio(event);
    hoverAt = at;

    if (event.currentTarget.hasPointerCapture(event.pointerId)) changed(at * max);
  }

  function keydown(event: KeyboardEvent) {
    if (!max) return;
    let next: number;

    switch (event.key) {
      case "ArrowLeft":
      case "ArrowDown":
        next = value - step;
        break;
      case "ArrowRight":
      case "ArrowUp":
        next = value + step;
        break;
      case "PageDown":
        next = value - max / 10;
        break;
      case "PageUp":
        next = value + max / 10;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = max;
        break;
      default:
        return;
    }

    event.preventDefault();
    event.stopPropagation();
    changed(Math.max(0, Math.min(max, next)));
  }
</script>

<div class="video-slider-wrap">
  <div
    class="video-slider"
    role="slider"
    tabindex={max ? 0 : -1}
    aria-label={label}
    aria-disabled={max ? undefined : true}
    aria-valuemin={0}
    aria-valuemax={max}
    aria-valuenow={Math.min(value, max)}
    aria-valuetext={previewTime ? `${format(value)} of ${format(max)}` : format(value)}
    data-pressed={pressed || undefined}
    style:--played="{ratio * 100}%"
    style:--buffered="{Math.max(ratio, max ? Math.min(1, buffered / max) : 0) * 100}%"
    onpointerdown={pointerDown}
    onpointermove={pointerMove}
    onpointerleave={() => (hoverAt = undefined)}
    onpointerup={(event) => {
      if (event.pointerType !== "mouse") hoverAt = undefined;
    }}
    onlostpointercapture={() => (pressed = false)}
    onpointercancel={() => (hoverAt = undefined)}
    onfocus={(event) => (focused = event.currentTarget.matches(":focus-visible"))}
    onblur={() => (focused = false)}
    onkeydown={keydown}
  >
    <span class="video-slider-thumb" aria-hidden="true"></span>
  </div>
  {#if previewTime}
    <span
      class="video-slider-preview"
      data-visible={preview !== undefined && max > 0}
      style:--at="{(preview ?? 0) * 100}%"
      aria-hidden="true">{format((preview ?? 0) * max)}</span
    >
  {/if}
</div>
