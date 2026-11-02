<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { stepSwap } from "./motion.ts";

  /**
   * Text that swaps in place when it changes (motion.ts `stepSwap`): the old text leaves while the new one
   * arrives, both in one grid cell, so neighbours never jump mid-swap. With `rank` (the value's place on
   * its scale) the motion follows the change: a higher rank rises in from below, a lower one drops in from
   * above. The first render shows the text at once.
   *
   *   <SwapText text={level.label} rank={index} distance="base" />
   */
  let {
    text,
    rank,
    distance = "micro",
    class: className,
  }: {
    text: string;
    /** The value's place on its scale (direction of the swap); without it the text always rises. */
    rank?: number | undefined;
    distance?: "micro" | "base";
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

<span class={["inline-grid *:col-start-1 *:row-start-1", className]}>
  {#key text}
    <span class="truncate" in:stepSwap={{ step, distance }} out:stepSwap={{ step, distance }}>{text}</span>
  {/key}
</span>
