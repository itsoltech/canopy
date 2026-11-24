<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import FieldError from "#lib/shared/ui/FieldError.svelte";
  import { clampNumber } from "#lib/shared/ui/number.ts";
  import Slider from "#lib/shared/ui/Slider.svelte";

  let {
    file,
    saving,
    error,
    oncancel,
    onsave,
  }: {
    file: File;
    saving: boolean;
    error: string | undefined;
    oncancel: () => void;
    onsave: (image: HTMLImageElement, x: number, y: number, size: number) => void;
  } = $props();

  const zoomSteps = Array.from({ length: 9 }, (_, i) => {
    const percent = 100 + 25 * i;

    return { value: String(percent), label: `${percent}%` };
  });

  let image = $state<HTMLImageElement>();
  let loadError = $state<string>();
  const width = $derived(image?.naturalWidth ?? 0);
  const height = $derived(image?.naturalHeight ?? 0);
  let zoom = $state("100");
  const size = $derived((Math.min(width, height) * 100) / Number(zoom));
  let center = $state<{ x: number; y: number }>();
  let drag: { id: number; x: number; y: number; left: number; top: number; scale: number; moved: boolean } | undefined;
  const left = $derived(clampNumber((center?.x ?? width / 2) - size / 2, 0, width - size));
  const top = $derived(clampNumber((center?.y ?? height / 2) - size / 2, 0, height - size));
  const disabled = $derived(saving || !image);

  $effect(() => {
    const url = URL.createObjectURL(file);
    const source = new Image();
    let active = true;
    source.src = url;
    void source.decode().then(
      () => {
        if (active) image = source;
      },
      () => {
        if (active) loadError = "Could not open this image. Choose another file.";
      },
    );

    return () => {
      active = false;
      URL.revokeObjectURL(url);
    };
  });

  function position(x: number, y: number) {
    center = {
      x: clampNumber(x, 0, width - size) + size / 2,
      y: clampNumber(y, 0, height - size) + size / 2,
    };
  }

  function start(event: PointerEvent & { currentTarget: HTMLElement }) {
    if (disabled || event.button !== 0 || drag) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    target.focus({ preventScroll: true });
    drag = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left,
      top,
      scale: size / target.getBoundingClientRect().width,
      moved: false,
    };
  }

  function move(event: PointerEvent) {
    if (disabled || drag?.id !== event.pointerId) return;
    const x = event.clientX - drag.x;
    const y = event.clientY - drag.y;

    if (!drag.moved && Math.hypot(x, y) < 5) return;
    drag.moved = true;
    position(drag.left - x * drag.scale, drag.top - y * drag.scale);
  }

  function finish(event: PointerEvent & { currentTarget: HTMLElement }) {
    if (disabled || drag?.id !== event.pointerId || drag.moved) return;
    const { x, y, width, height } = event.currentTarget.getBoundingClientRect();
    const scale = size / width;
    position(left + (event.clientX - x - width / 2) * scale, top + (event.clientY - y - height / 2) * scale);
  }

  function end(event: PointerEvent) {
    if (drag?.id === event.pointerId) drag = undefined;
  }

  function moveWithKeys(event: KeyboardEvent) {
    if (disabled) return;
    const step = size * (event.shiftKey ? 0.2 : 0.04);
    const x = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
    const y = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;

    if (!x && !y) return;
    event.preventDefault();
    position(left - x, top - y);
  }
</script>

{#if image}
  <div class="mx-auto flex w-full max-w-72 flex-col gap-3">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions (Dragging, tapping, and the arrow keys reposition the crop.) -->
    <div
      role="application"
      aria-label="Crop preview. Use the arrow keys to move the image."
      aria-disabled={disabled}
      tabindex={disabled ? -1 : 0}
      onkeydown={moveWithKeys}
      onpointerdown={start}
      onpointermove={move}
      onpointerup={finish}
      onlostpointercapture={end}
      class={[
        "relative aspect-square touch-none overflow-hidden rounded-lg bg-panel ring-1 ring-divider focus-ring",
        !disabled && "cursor-grab active:cursor-grabbing",
      ]}
    >
      <img
        src={image.src}
        alt=""
        draggable="false"
        class="pointer-events-none absolute max-w-none select-none"
        style:left={`${(-left * 100) / size}%`}
        style:top={`${(-top * 100) / size}%`}
        style:width={`${(width * 100) / size}%`}
        style:height={`${(height * 100) / size}%`}
      />
    </div>
    <div class="grid grid-cols-[auto_1fr_auto] items-center gap-3">
      <span class="text-sm/6 font-medium">Zoom</span>
      <Slider
        label="Zoom"
        variant="pill"
        steps={zoomSteps}
        value={zoom}
        {disabled}
        onchange={(next) => {
          center = { x: left + size / 2, y: top + size / 2 };
          zoom = next;
        }}
      />
      <span class="text-right text-sm/6 text-muted tabular-nums" aria-hidden="true">{zoom}%</span>
    </div>
  </div>
{:else if !loadError}
  <p class="text-sm/6 text-muted" role="status">Opening image…</p>
{/if}

<FieldError message={loadError ?? error} class="mt-3" />
<DialogActions class="mt-5">
  <Button disabled={saving} onclick={oncancel}>{loadError ? "Close" : "Cancel"}</Button>
  {#if !loadError}
    <Button
      variant="primary"
      loading={saving}
      {disabled}
      onclick={() => {
        if (image) onsave(image, left, top, size);
      }}>Save image</Button
    >
  {/if}
</DialogActions>
