<script lang="ts">
  import { page } from "$app/state";
  import { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import CompactUpdates from "../CompactUpdates.svelte";
  import CompactComputerUpdate from "../CompactComputerUpdate.svelte";
  import { UpdatesState } from "../updates.svelte.ts";
  import { computerStates, fixtureSnapshot } from "./update-fixtures.ts";

  /** The updates center with fixture data: light/dark with `?dark=1`. Development only. */
  const updates = new UpdatesState();

  updates.snapshot = fixtureSnapshot();

  const app = new DesktopUpdatesState();

  app.status = {
    version: "0.42.0-nightly.7",
    channel: "nightly",
    buildChannel: "nightly",
    phase: "idle",
    message: "Canopy is up to date",
    changingChannel: false,
  };

  const states = new UpdatesState();

  $effect(() => {
    document.documentElement.classList.toggle("dark", page.url.searchParams.get("dark") === "1");
  });
</script>

<div class="flex flex-wrap items-start gap-6 p-4">
  <div
    class="density-overlay w-[min(22rem,calc(100vw-2rem))] rounded-xl bg-surface text-ink shadow-lg ring-1 ring-divider dark:shadow-none"
    id="popover"
  >
    <CompactUpdates {updates} {app} />
  </div>
  <div
    class="density-overlay w-[min(22rem,calc(100vw-2rem))] rounded-xl bg-surface px-3 py-1 text-ink shadow-lg ring-1 ring-divider dark:shadow-none"
    id="states"
  >
    {#each computerStates() as computer (computer.nodeId)}<CompactComputerUpdate {computer} updates={states} />{/each}
  </div>
</div>
