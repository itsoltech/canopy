<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import { finished } from "./moves.ts";
  import MoveProgressRow from "./MoveProgressRow.svelte";

  /** Started moves: one summary line (announced politely) and each thing's state. */
  let {
    moves,
    target,
    class: className,
  }: { moves: readonly ui.ComputerMove[]; target: string; class?: ClassValue } = $props();

  const running = $derived(!moves.every(finished));
  const moved = $derived(moves.filter((m) => m.state === "done" || m.state === "committed").length);
</script>

<div class={["grid min-w-0 grid-cols-1 gap-2", className]}>
  <p role="status" class="text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">
    {running
      ? `Moving to ${target}. You can close this; the move continues.`
      : moved === moves.length
        ? `Moved to ${target}.`
        : moved
          ? `${moved} of ${moves.length} moved to ${target}. The others stay on this computer.`
          : "Nothing moved. Everything stays on this computer."}
  </p>
  <div class="divide-y divide-zinc-950/5 dark:divide-white/10">
    {#each moves as move (move.id)}<MoveProgressRow {move} />{/each}
  </div>
</div>
