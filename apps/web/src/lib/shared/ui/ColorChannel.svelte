<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /** Continuous custom slider. No native range input; pointer capture and WAI-ARIA keyboard keys. */
  let {
    label,
    value,
    max = 100,
    gradient,
    onchange,
    disabled = false,
    class: className,
  }: {
    label: string;
    value: number;
    max?: number;
    gradient: string;
    onchange: (value: number) => void;
    disabled?: boolean;
    class?: ClassValue;
  } = $props();

  let thumbRange: HTMLDivElement;

  function fromPointer(event: PointerEvent) {
    const bounds = thumbRange.getBoundingClientRect();
    const fraction = (event.clientX - bounds.left) / Math.max(1, bounds.width);
    onchange(Math.round(Math.max(0, Math.min(1, fraction)) * max));
  }

  function onkeydown(event: KeyboardEvent) {
    const delta = event.shiftKey ? 10 : 1;
    let next: number;

    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = max;
    else if (["ArrowRight", "ArrowUp"].includes(event.key)) next = value + delta;
    else if (["ArrowLeft", "ArrowDown"].includes(event.key)) next = value - delta;
    else if (event.key === "PageUp") next = value + 10;
    else if (event.key === "PageDown") next = value - 10;
    else return;
    event.preventDefault();

    if (!disabled) onchange(Math.max(0, Math.min(max, next)));
  }
</script>

<div class={["grid gap-1", className]}>
  <div class="flex justify-between text-sm/5 text-zinc-500 dark:text-zinc-400">
    <span>{label}</span><span class="tabular-nums">{Math.round(value)}{max === 360 ? "°" : "%"}</span>
  </div>
  <div
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={max}
    aria-valuenow={Math.round(value)}
    aria-valuetext={`${Math.round(value)}${max === 360 ? " degrees" : " percent"}`}
    aria-disabled={disabled || undefined}
    class="relative flex h-11 touch-none items-center rounded-md focus-ring"
    style:--channel-gradient={gradient}
    {onkeydown}
    onpointerdown={(event) => {
      if (disabled || event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus();
      event.currentTarget.setPointerCapture(event.pointerId);
      fromPointer(event);
    }}
    onpointermove={(event) => {
      if (!disabled && event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event);
    }}
  >
    <div
      class="h-(--track-height) w-full rounded-full bg-(image:--channel-gradient) px-[calc(var(--track-height)/2)] ring-1 ring-zinc-950/10 [--track-height:--spacing(5)] ring-inset dark:ring-white/15"
    >
      <div bind:this={thumbRange} class="relative h-full">
        <div
          class="pointer-events-none absolute top-1/2 size-6 -translate-1/2 rounded-full border-[3px] border-white shadow-sm ring-1 ring-black/25"
          style:left="{(value / max) * 100}%"
        ></div>
      </div>
    </div>
  </div>
</div>
