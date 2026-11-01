<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import TouchTarget from "./TouchTarget.svelte";

  /**
   * Slider over discrete, labelled stops (WAI-ARIA slider). Arrows (and PageUp/PageDown) step,
   * Home/End jump to the ends; drag or click anywhere on the track or a label. The value is the stop's
   * `value`; screen readers hear its `label`. `name` adds a hidden input for forms.
   *
   *   <Slider label="Reasoning effort" steps={[{ value: "low", label: "Low" }, …]} bind:value={effort} />
   */
  let {
    steps,
    value = $bindable(),
    label,
    name,
    disabled = false,
    autofocus = false,
    onchange,
    class: className,
  }: {
    steps: readonly { readonly value: string; readonly label: string }[];
    value?: string | undefined;
    label: string;
    name?: string | undefined;
    disabled?: boolean;
    /** Take the first focus of a surrounding popover. */
    autofocus?: boolean;
    onchange?: ((value: string) => void) | undefined;
    class?: ClassValue;
  } = $props();

  let track = $state<HTMLElement>();
  const index = $derived(Math.max(0, steps.findIndex((s) => s.value === value)));
  const last = $derived(Math.max(steps.length - 1, 1));
  const at = (i: number) => `${(i / last) * 100}%`;

  function set(i: number) {
    const step = steps[Math.max(0, Math.min(i, steps.length - 1))];
    if (!step || disabled || step.value === value) return;
    value = step.value;
    onchange?.(step.value);
  }

  function onkeydown(event: KeyboardEvent) {
    const delta: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, PageUp: 1, ArrowLeft: -1, ArrowDown: -1, PageDown: -1 };
    if (event.key in delta) set(index + delta[event.key]!);
    else if (event.key === "Home") set(0);
    else if (event.key === "End") set(steps.length - 1);
    else return;
    event.preventDefault();
  }

  // Nearest stop to the pointer, while pressed (pointer capture keeps the drag on the slider).
  function fromPointer(event: PointerEvent) {
    if (!track) return;
    const box = track.getBoundingClientRect();
    set(Math.round(((event.clientX - box.left) / Math.max(box.width, 1)) * last));
  }
  function onpointerdown(event: PointerEvent) {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    fromPointer(event);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>("[role=slider]")?.focus();
  }
  function onpointermove(event: PointerEvent) {
    if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) fromPointer(event);
  }
</script>

<div class={["grid touch-none gap-2 px-2 select-none", disabled && "opacity-50", className]} {onpointerdown} {onpointermove} role="presentation">
  <div bind:this={track} class="relative h-5">
    <div class="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-zinc-950/10 dark:bg-white/10"></div>
    <div class="absolute top-1/2 left-0 h-1 w-(--fill) -translate-y-1/2 rounded-full bg-zinc-950 dark:bg-white" style:--fill={at(index)}></div>
    {#each steps as step, i (step.value)}
      <span
        class={["absolute top-1/2 left-(--stop) size-1.5 -translate-1/2 rounded-full", i <= index ? "bg-white/60 dark:bg-zinc-950/60" : "bg-zinc-950/25 dark:bg-white/25"]}
        style:--stop={at(i)}
        aria-hidden="true"
      ></span>
    {/each}
    <div
      role="slider"
      tabindex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={steps.length - 1}
      aria-valuenow={index}
      aria-valuetext={steps[index]?.label}
      aria-disabled={disabled || undefined}
      data-autofocus={autofocus || undefined}
      class="absolute top-1/2 left-(--stop) size-5 -translate-1/2 cursor-grab rounded-full bg-white shadow-sm ring-1 ring-zinc-950/15 focus-ring active:cursor-grabbing sm:size-4 dark:bg-zinc-100 dark:shadow-none dark:ring-white/20"
      style:--stop={at(index)}
      {onkeydown}
    >
      <TouchTarget />
    </div>
  </div>
  <div class="relative h-5" aria-hidden="true">
    {#each steps as step, i (step.value)}
      <span
        class={[
          "absolute top-0 left-(--stop) text-sm/5 whitespace-nowrap sm:text-xs/5",
          i === 0 ? "" : i === steps.length - 1 ? "-translate-x-full" : "-translate-x-1/2",
          i === index ? "font-medium text-zinc-950 dark:text-white" : "text-zinc-500 dark:text-zinc-400",
        ]}
        style:--stop={at(i)}>{step.label}</span
      >
    {/each}
  </div>
  {#if name}<input type="hidden" {name} value={value ?? ""} />{/if}
</div>
