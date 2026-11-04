<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import InsetList from "#lib/shared/ui/InsetList.svelte";
  import RouteRow from "./RouteRow.svelte";

  /** A linked computer's routes in the order connecting tries them (docs/linked-computers.md, stage 6). */
  let {
    computer,
    now,
    busy = false,
    onadd,
    onremove,
    class: className,
  }: {
    computer: ui.LinkedComputer;
    now: number;
    busy?: boolean;
    onadd: () => void;
    onremove: (address: string) => void;
    class?: ClassValue;
  } = $props();

  const name = $derived(computer.displayName || computer.name);
</script>

<section class={["grid min-w-0 gap-3", className]} aria-label={`Routes to ${name}`}>
  <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
    <div class="min-w-0 flex-1">
      <h4 class="text-base/6 font-medium text-zinc-950 sm:text-sm/6 dark:text-white">Routes</h4>
      <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
        Tried in order, the most recently working first.
      </p>
    </div>
    <Button size="sm" icon="plus" disabled={busy} onclick={onadd}>Add route</Button>
  </div>
  {#if computer.routes.length}
    <InsetList label={`Routes to ${name}`}>
      {#each computer.routes as route (route.address)}<RouteRow
          {route}
          {now}
          {busy}
          onremove={() => onremove(route.address)}
        />{/each}
    </InsetList>
  {:else}
    <p class="text-base/6 text-pretty text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      No known route. This computer can still connect when {name} reaches it, or add an address.
    </p>
  {/if}
</section>
