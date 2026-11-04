<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import TouchTarget from "./TouchTarget.svelte";

  /**
   * Slider over discrete, labelled stops (WAI-ARIA slider). Arrows (and PageUp/PageDown) step,
   * Home/End jump to the ends; drag or click anywhere on the track or a label. The value is the stop's
   * `value`; screen readers hear its `label`. A value that is no stop (undefined) shows a hollow thumb at
   * the start and reads as `unsetLabel`. `name` adds a hidden input for forms. Thumb and fill glide
   * between stops (motion.css `t-slide`).
   *
   * `variant="pill"` (ChatGPT's effort slider): a compact rounded track filled with the accent's gradient
   * (lighter → deeper, spanning the whole track, so a stop's colour never changes) up to a white thumb
   * just inside it, the stops as small dots and no labels under them (the surrounding UI names the
   * value). The thumb grows a little while pressed; the focus ring circles the track. The hit area
   * reaches past the track (48px tall on touch screens) without growing it.
   *
   *   <Slider label="Reasoning effort" steps={[{ value: "low", label: "Low" }, …]} bind:value={effort} />
   */
  let {
    steps,
    value = $bindable(),
    label,
    unsetLabel = "Not set",
    name,
    variant = "line",
    disabled = false,
    autofocus = false,
    onchange,
    class: className,
  }: {
    steps: readonly { readonly value: string; readonly label: string }[];
    value?: string | undefined;
    label: string;
    /** What screen readers hear while the value is no stop. */
    unsetLabel?: string;
    name?: string | undefined;
    variant?: "line" | "pill";
    disabled?: boolean;
    /** Take the first focus of a surrounding popover. */
    autofocus?: boolean;
    onchange?: ((value: string) => void) | undefined;
    class?: ClassValue;
  } = $props();

  let track = $state<HTMLElement>();
  let pressed = $state(false);
  const index = $derived(steps.findIndex((s) => s.value === value));
  const unset = $derived(index < 0);
  const last = $derived(Math.max(steps.length - 1, 1));
  const at = (i: number) => `${(i / last) * 100}%`;

  function set(i: number) {
    const step = steps[Math.max(0, Math.min(i, steps.length - 1))];

    if (!step || disabled || step.value === value) return;
    value = step.value;
    onchange?.(step.value);
  }

  function onkeydown(event: KeyboardEvent) {
    const delta = new Map<string, number>([
      ["ArrowRight", 1],
      ["ArrowUp", 1],
      ["PageUp", 1],
      ["ArrowLeft", -1],
      ["ArrowDown", -1],
      ["PageDown", -1],
    ]);

    const step = delta.get(event.key);

    if (step !== undefined) set(index + step);
    else if (event.key === "Home") set(0);
    else if (event.key === "End") set(steps.length - 1);
    else return;
    event.preventDefault();
  }

  // Nearest stop to the pointer, while pressed (pointer capture keeps the drag on the slider). The pill's
  // stops sit half a track height in from its ends (where the thumb's centre can go).
  function fromPointer(event: PointerEvent) {
    if (!track) return;
    const box = track.getBoundingClientRect();
    const inset = variant === "pill" ? box.height / 2 : 0;
    set(Math.round(((event.clientX - box.left - inset) / Math.max(box.width - 2 * inset, 1)) * last));
  }

  function onpointerdown(event: PointerEvent) {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    pressed = true;
    fromPointer(event);
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>("[role=slider]")?.focus();
  }

  function onpointermove(event: PointerEvent) {
    if ((event.currentTarget as HTMLElement).hasPointerCapture(event.pointerId)) fromPointer(event);
  }

  const release = () => (pressed = false);
</script>

{#snippet thumb(classes: ClassValue)}
  <div
    role="slider"
    tabindex={disabled ? -1 : 0}
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={steps.length - 1}
    aria-valuenow={Math.max(index, 0)}
    aria-valuetext={unset ? unsetLabel : steps[index]?.label}
    aria-disabled={disabled || undefined}
    data-autofocus={autofocus || undefined}
    data-pressed={pressed || undefined}
    class={classes}
    style:--stop={at(Math.max(index, 0))}
    style:--at={Math.max(index, 0) / last}
    {onkeydown}
  >
    <TouchTarget />
  </div>
{/snippet}

<div
  class={[
    "touch-none select-none",
    variant === "line" && "grid gap-2 px-2",
    // Invisible hit area around the track: 48px tall with a coarse pointer, a few px with a fine one.
    variant === "pill" && "-my-2.5 cursor-pointer py-2.5 pointer-fine:-my-1 pointer-fine:py-1",
    disabled && "opacity-50",
    className,
  ]}
  {onpointerdown}
  {onpointermove}
  onpointerup={release}
  onpointercancel={release}
  onlostpointercapture={release}
  role="presentation"
>
  {#if variant === "pill"}
    <!-- --pad: half the track height, where the thumb's centre stops at either end. A container, so the
         fill's gradient can span the whole track (100cqw) however far the fill reaches. -->
    <div
      bind:this={track}
      class="@container relative h-7 rounded-full bg-zinc-950/5 [--pad:--spacing(3.5)] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-brand-500 sm:h-6 sm:[--pad:--spacing(3)] dark:bg-white/10"
    >
      {#if !unset}
        <div
          class="t-slide absolute inset-y-0 left-0 w-[calc(var(--pad)*2+(100%-var(--pad)*2)*var(--fill))] rounded-full bg-linear-to-r from-brand-400 to-brand-600 bg-size-[100cqw_100%]"
          style:--fill={index / last}
        ></div>
      {/if}
      {#each steps as step, i (step.value)}
        <span
          class={[
            "t-slide-dot absolute top-1/2 left-[calc(var(--pad)+(100%-var(--pad)*2)*var(--at))] size-1 -translate-1/2 rounded-full",
            i < index ? "bg-white/60" : "bg-zinc-950/20 dark:bg-white/25",
          ]}
          style:--at={i / last}
          aria-hidden="true"
        ></span>
      {/each}
      <!-- The ring goes round the track (has-focus-visible above): on the thumb it would sit on the fill. -->
      {@render thumb([
        "t-slide t-slide-thumb absolute top-1/2 left-[calc(var(--pad)+(100%-var(--pad)*2)*var(--at))] size-6 -translate-1/2 cursor-grab rounded-full bg-white shadow-sm outline-none active:cursor-grabbing sm:size-5 dark:bg-zinc-50 dark:shadow-none",
        unset ? "ring-2 ring-zinc-950/15 dark:ring-white/30" : "ring-1 ring-zinc-950/5 dark:ring-0",
      ])}
    </div>
  {:else}
    <div bind:this={track} class="relative h-5">
      <div class="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-zinc-950/10 dark:bg-white/10"></div>
      <div
        class="t-slide absolute top-1/2 left-0 h-1 w-(--fill) -translate-y-1/2 rounded-full bg-zinc-950 dark:bg-white"
        style:--fill={at(Math.max(index, 0))}
      ></div>
      {#each steps as step, i (step.value)}
        <span
          class={[
            "absolute top-1/2 left-(--stop) size-1.5 -translate-1/2 rounded-full",
            i <= index ? "bg-white/60 dark:bg-zinc-950/60" : "bg-zinc-950/25 dark:bg-white/25",
          ]}
          style:--stop={at(i)}
          aria-hidden="true"
        ></span>
      {/each}
      {@render thumb([
        "t-slide absolute top-1/2 left-(--stop) size-5 -translate-1/2 cursor-grab rounded-full shadow-sm focus-ring active:cursor-grabbing sm:size-4 dark:shadow-none",
        unset
          ? "bg-white ring-2 ring-zinc-950/25 dark:bg-zinc-900 dark:ring-white/30"
          : "bg-white ring-1 ring-zinc-950/15 dark:bg-zinc-100 dark:ring-white/20",
      ])}
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
  {/if}
  {#if name}<input type="hidden" {name} value={value ?? ""} />{/if}
</div>
