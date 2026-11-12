<script lang="ts">
  import { page } from "$app/state";
  import { DesktopUpdatesState } from "#lib/features/desktop/desktop-updates.svelte.ts";
  import CompactUpdates from "../CompactUpdates.svelte";
  import { create } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { DesktopUpdateStatus } from "@canopy/ui/desktop";
  import AppUpdates from "#lib/features/desktop/AppUpdates.svelte";
  import LinkedAppUpdates from "#lib/features/desktop/LinkedAppUpdates.svelte";
  import CompactComputerUpdate from "../CompactComputerUpdate.svelte";
  import UpdatesPanel from "../UpdatesPanel.svelte";
  import { UpdatesState } from "../updates.svelte.ts";
  import { computerStates, fixtureSnapshot } from "./update-fixtures.ts";

  /**
   * The updates center with fixture data: light/dark with `?dark=1`, the settings sections with `?view=settings`.
   * `client=web` has no Electron bridge; `home` selects a computer state and `name` overrides its name.
   * Development only.
   */
  const updates = new UpdatesState();

  updates.snapshot = fixtureSnapshot();

  const home = computerStates().find((computer) => computer.name === page.url.searchParams.get("home"));

  if (home) {
    updates.snapshot.app = home.updates?.app;
    updates.snapshot.appUpdateSupported = home.remoteUpdate;
  }

  updates.snapshot.computerName = page.url.searchParams.get("name") || updates.snapshot.computerName;

  if (page.url.searchParams.get("run") === "failed") {
    updates.snapshot.run = create(ui.UpdateRunSchema, {
      id: "failed-fixture",
      state: "failed",
      reason: "Linked computer · Canopy app: The app restarted before the update completed. Request it again.",
      steps: [
        { kind: "computer", label: "Linked computer · Canopy app", state: "failed", version: "0.43.0-nightly.1" },
      ],
    });
  }

  const app = new DesktopUpdatesState();

  const status: DesktopUpdateStatus = {
    version: "0.42.0-nightly.7",
    channel: "nightly",
    buildChannel: "nightly",
    phase: "idle",
    message: "Canopy is up to date",
    changingChannel: false,
    checkIntervalMinutes: 360,
    lastCheckedAt: Date.now() - 60_000,
  };

  if (page.url.searchParams.get("client") !== "web") app.status = status;

  const states = new UpdatesState();
  const settings = page.url.searchParams.get("view") === "settings";
  const linked = new UpdatesState();

  linked.snapshot = create(ui.UpdatesSnapshotSchema, {
    computers: [...fixtureSnapshot().computers, ...computerStates()],
  });

  // App updates reads this computer's app through the desktop bridge; the gallery answers with the fixture.
  if (settings && !window.canopyDesktop)
    Object.assign(window, {
      canopyDesktop: {
        updates: async () => status,
        onUpdates: () => () => {},
        status: async () => ({ mode: "local" }),
        onStatus: () => () => {},
      },
    });

  $effect(() => {
    document.documentElement.classList.toggle("dark", page.url.searchParams.get("dark") === "1");
  });
</script>

{#if settings}
  <div class="settings-density bg-white dark:bg-zinc-950">
    <div class="settings-content mx-auto grid max-w-3xl grid-cols-1 gap-8 px-4 py-4 sm:px-6" id="settings">
      <div id="workers-updates"><UpdatesPanel fixture={{ updates, app }} /></div>
      <div id="app-updates" class="grid gap-8"><AppUpdates /><LinkedAppUpdates fixture={linked} /></div>
    </div>
  </div>
{:else}<div class="flex flex-wrap items-start gap-6 p-4">
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
{/if}
