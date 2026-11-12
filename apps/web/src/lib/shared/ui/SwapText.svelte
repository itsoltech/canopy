<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { stepSwap } from "./motion.ts";
  import LiveText from "./LiveText.svelte";

  /**
   * Text that swaps in place when it changes (motion.ts `stepSwap`): the old text leaves while the new one
   * arrives, both in one grid cell, so neighbours never jump mid-swap. With `rank` (the value's place on
   * its scale) the motion follows the change: a higher rank rises in from below, a lower one drops in from
   * above. The first render shows the text at once. `reserve` lists every text it may show: the box keeps
   * the widest one's width, so it (and whatever sits beside it) never resizes as the text changes.
   * Use `align="center"` for a centred slot: both texts keep the same centre even when their widths differ.
   *
   *   <SwapText text={level.label} rank={index} reserve={levels.map((l) => l.label)} distance="base" />
   */
  let {
    text,
    rank,
    distance = "micro",
    align = "start",
    reserve = [],
    live = false,
    class: className,
  }: {
    text: string;
    live?: boolean;
    /** The value's place on its scale (direction of the swap); without it the text always rises. */
    rank?: number | undefined;
    distance?: "micro" | "base";
    align?: "start" | "center";
    /** Texts whose widest width the box keeps. */
    reserve?: readonly string[];
    class?: ClassValue;
  } = $props();

  // Direction of the last change of `rank` (kept when the text changes on its own).
  let previous: number | undefined;

  const step = $derived.by(() => {
    const from = previous;
    previous = rank;

    return from === undefined || rank === undefined || rank === from ? 1 : Math.sign(rank - from);
  });
</script>

<span class={["inline-grid *:col-start-1 *:row-start-1", align === "center" ? "text-center" : "text-start", className]}>
  {#each reserve as each, i (i)}
    <span class="invisible truncate" aria-hidden="true">{each}</span>
  {/each}
  {#key text}
    <span class="truncate" in:stepSwap={{ step, distance }} out:stepSwap={{ step, distance }}>
      {#if live}<LiveText {text} />{:else}{text}{/if}
    </span>
  {/key}
</span>
