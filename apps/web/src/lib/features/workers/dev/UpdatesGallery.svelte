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
  import { bulkUpdateSteps, plannedUpdateRun } from "@canopy/domain/release/update-plan";

  /**
   * The updates center with fixture data: light/dark with `?dark=1`, the settings sections with `?view=settings`.
   * `client=web` has no Electron bridge; `home` selects a computer state and `name` overrides its name.
   * `state=quiet` makes everything current, `state=starting` shows the instant state of Update all, `restart=1` (or
   * `slow`) has the linked computer restart for its update. Development only.
   */
  const updates = new UpdatesState();

  updates.snapshot = fixtureSnapshot();

  const home = computerStates().find((computer) => computer.name === page.url.searchParams.get("home"));

  if (home) {
    updates.snapshot.app = home.updates?.app;
    updates.snapshot.appUpdateSupported = home.remoteUpdate;
  }

  updates.snapshot.computerName = page.url.searchParams.get("name") || updates.snapshot.computerName;

  const params = page.url.searchParams;
  const finishedAt = new Date().toISOString();

  if (params.get("state") === "quiet") {
    const snapshot = updates.snapshot;

    for (const home of [snapshot, ...snapshot.computers.flatMap((computer) => computer.updates ?? [])]) {
      for (const worker of home.workers) worker.version = home.gatewayVersion;

      for (const item of home.cliWorkers.flatMap((worker) => worker.cliTools)) {
        if (item.tool && item.latest) item.tool.version = item.latest.version;
        item.updateAvailable = false;
        item.action = "";
      }

      if (home.app) home.app.version = home.app.availableVersion;
    }

    snapshot.computers = snapshot.computers.filter((computer) => computer.remoteUpdate);
  }

  if (params.has("restart")) {
    const studio = updates.snapshot.computers[0];

    if (studio) {
      studio.presence = "updating";
      studio.presenceSinceMs = BigInt(Date.now() - (params.get("restart") === "slow" ? 5 * 60_000 : 20_000));
    }
  }

  if (page.url.searchParams.get("run") === "failed") {
    updates.snapshot.run = create(ui.UpdateRunSchema, {
      id: "failed-fixture",
      state: "failed",
      reason: "Linked computer · Canopy app: The app restarted before the update completed. Request it again.",
      steps: [
        ...bulkUpdateSteps(updates.snapshot)
          .filter((step) => step.kind !== "computer" && step.state !== "skipped")
          .map((step) => ({ ...step, state: "succeeded", finishedAt })),
        {
          kind: "computer",
          nodeId: updates.snapshot.computers[0]?.nodeId,
          label: "Linked computer · Canopy app",
          state: "failed",
          version: "0.43.0-nightly.1",
          reason: "The app restarted before the update completed. Request it again.",
          finishedAt,
        },
      ],
    });
  }

  if (["running", "complete"].includes(page.url.searchParams.get("run") || "")) {
    const complete = page.url.searchParams.get("run") === "complete";
    const steps = bulkUpdateSteps(updates.snapshot);

    for (const [index, step] of steps.entries()) {
      if (step.state === "skipped") continue;
      step.state = complete || index === 0 ? "succeeded" : index <= 3 ? "running" : "queued";
      step.finishedAt = step.state === "succeeded" ? finishedAt : "";
    }

    steps.push(
      create(ui.UpdateStepSchema, {
        kind: "cli",
        label: "Build computer · Codex",
        state: "skipped",
        reason: "Update this agent CLI with Homebrew.",
      }),
    );
    updates.snapshot.run = create(ui.UpdateRunSchema, {
      id: "update-fixture",
      state: complete ? "succeeded" : "running",
      steps,
    });
  }

  if (params.get("state") === "starting") {
    updates.optimistic = { run: plannedUpdateRun(updates.snapshot, ""), rows: new Map() };
    updates.pending = "update_all";
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
