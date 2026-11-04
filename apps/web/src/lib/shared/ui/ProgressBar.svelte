<script lang="ts">
  import type { ClassValue } from "svelte/elements";

  /**
   * Progress: a rounded track with a filled part. `value` is 0–100 and is clamped; without a value the bar is full and
   * reports no amount (the size is not known yet). `label` names what is progressing for assistive tech. `inset` drops
   * the rounding for bars pinned to the edge of a card.
   */
  let {
    value,
    label,
    inset = false,
    class: className,
  }: { value?: number; label: string; inset?: boolean; class?: ClassValue } = $props();

  const percent = $derived(value === undefined ? undefined : Math.min(100, Math.max(0, Math.round(value))));
</script>

<div
  role="progressbar"
  aria-label={label}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={percent}
  class={["h-1.5 overflow-hidden bg-zinc-950/10 dark:bg-white/10", !inset && "rounded-full", className]}
>
  <div
    class={[
      "h-full w-(--progress) bg-zinc-950 transition-[width] duration-(--duration-fast) ease-smooth-out motion-reduce:transition-none dark:bg-white",
      !inset && "rounded-full",
    ]}
    style:--progress={`${percent ?? 100}%`}
  ></div>
</div>
