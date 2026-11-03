<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Badge from "#lib/shared/ui/Badge.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import MoveItemLabel from "./MoveItemLabel.svelte";
  import { finished, moveState } from "./moves.ts";

  /** One move while it runs and after: its state and, when it did not move, why (nothing changed then). */
  let { move, class: className }: { move: ui.ComputerMove; class?: ClassValue } = $props();
  const state = $derived(moveState(move));
</script>

<div class={["grid min-w-0 grid-cols-1 gap-1 py-3", className]}>
  <div class="flex min-w-0 items-center gap-2">
    <MoveItemLabel kind={move.kind} title={move.title} />
    {#if !finished(move)}<Spinner class="size-4 shrink-0" />{/if}
    <Badge tone={state.tone}>{state.label}</Badge>
  </div>
  {#if move.error}<p class="text-base/6 text-pretty text-zinc-600 sm:text-sm/6 dark:text-zinc-400">{move.error}{move.state.startsWith("abort") ? " It stays on this computer." : ""}</p>{/if}
</div>
