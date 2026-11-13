<script lang="ts">
  import ThreadSecretRow from "./secrets/ThreadSecretRow.svelte";
  import ThreadConnectors from "#lib/features/connectors/ThreadConnectors.svelte";
  import { timestampMs } from "@bufbuild/protobuf/wkt";
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import ScheduleCompactRow from "#lib/features/schedules/ScheduleCompactRow.svelte";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { ThreadTree } from "../thread-tree.ts";
  import ThreadLineage from "./ThreadLineage.svelte";
  import PanelRow from "./PanelRow.svelte";
  import BackgroundTasksSection from "./BackgroundTasksSection.svelte";
  import type { BackgroundEntry } from "../background-tasks.ts";
  import type { Item } from "@canopy/contracts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import ThreadTitleActions from "./ThreadTitleActions.svelte";
  import ThreadPlacement from "./ThreadPlacement.svelte";
  import ThreadPullRequests from "#lib/features/github/ThreadPullRequests.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import { useThreadPanel } from "../thread-panel.svelte.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { awayReason } from "#lib/features/computers/computers.ts";
  import { useWorkspace } from "#lib/features/workspace/workspace.svelte.ts";
  import type { WorkspaceModuleId } from "@canopy/domain/workspace-modules";

  const capabilities = useGatewayCapabilities();

  /**
   * Context of a thread: where it runs, its scheduled tasks (pause, resume, cancel, schedule another),
   * and its lineage — the main
   * thread with its side threads, agent-started and forked ones marked — plus "New side thread".
   */
  let {
    thread,
    tree,
    worker,
    schedules,
    syncStatus,
    secrets = [],
    onsecretchange,
    backgroundTasks = [],
    items = new Map(),
    onbackground,
    onschedule,
    onschedulechange,
    onnewside,
    onworktree,
    windowTitlebar = false,
    mode = "summary",
    class: className,
  }: {
    thread: ui.Thread;
    tree: ThreadTree;
    worker: ui.Worker | undefined;
    /** Active and paused schedules of the thread. */
    schedules: readonly ui.Schedule[];
    syncStatus?: ui.ThreadSyncStatus | undefined;
    /** The thread's secrets; the saved, unexpired ones are listed (pending requests stay above the composer). */
    secrets?: readonly ui.ThreadSecret[];
    onsecretchange?: ((secret: ui.ThreadSecret) => void) | undefined;
    backgroundTasks?: readonly BackgroundEntry[];
    items?: ReadonlyMap<string, Item>;
    onbackground?: ((id: string) => void) | undefined;
    onschedule?: (() => void) | undefined;
    onschedulechange?: ((schedule: ui.Schedule) => void) | undefined;
    onnewside?: (() => void) | undefined;
    onworktree: () => void;
    windowTitlebar?: boolean;
    mode?: "summary" | WorkspaceModuleId;
    class?: ClassValue;
  } = $props();

  const activeSecrets = $derived(
    secrets.filter((s) => s.status === "saved" && (!s.expiresAt || timestampMs(s.expiresAt) > clock.now)),
  );

  const lookup = (id: string) => (tree.main.id === id ? tree.main : tree.sides.find((s) => s.id === id));
  const directory = useThreadDirectory();
  const workspace = useWorkspace();
  const overview = useOverview();
  const panel = useThreadPanel(() => thread.id);
  const homeName = $derived(overview.machine(thread.nodeId) || "this computer");
  const away = $derived(thread.nodeId ? awayReason(overview.computer(thread.nodeId)) : undefined);

  const stale = $derived(
    !!away || syncStatus?.reason === "computer_unreachable" || !!panel.data?.stale || !!panel.error,
  );

  const panelSchedules = $derived(
    thread.nodeId || stale || !schedules.length ? (panel.data?.schedules ?? schedules) : schedules,
  );

  // A forked main thread ("Fork from here") is in its own tree: its source is found among the project's threads.
  const source = $derived(
    thread.forkSourceThreadId
      ? (lookup(thread.forkSourceThreadId) ?? directory.thread(thread.forkSourceThreadId))
      : undefined,
  );
</script>

<div
  class={[
    "density-chrome grid min-w-0 grid-cols-1 divide-y divide-zinc-950/5 rounded-2xl bg-white py-1 shadow-sm ring-1 ring-zinc-950/10 dark:divide-white/8 dark:bg-zinc-950 dark:shadow-none dark:ring-white/10",
    className,
  ]}
>
  {#if mode === "summary"}<ThreadTitleActions
      {thread}
      compact
      class={windowTitlebar ? "desktop:hidden" : undefined}
    />{/if}
  {#if stale}<p role="status" class="px-3 py-2 text-sm/5 text-zinc-500 dark:text-zinc-400">
      {#if panel.data?.unavailable}Thread details are unavailable. Manage on {homeName}.
      {:else}{away || `Thread details on ${homeName} are unreachable.`} Showing last known details.{/if}
    </p>{/if}
  {#if mode === "connectors"}<ThreadConnectors {thread} {panel} {homeName} disabled={stale} />{/if}
  {#if mode === "summary"}<ThreadPlacement {thread} {worker} {onworktree} />{/if}
  {#if mode === "summary" && thread.permissionModeNote}<p
      class="px-3 py-2 text-sm text-pretty text-zinc-600 sm:text-xs dark:text-zinc-400"
    >
      {thread.permissionModeNote}
    </p>{/if}
  {#if mode === "pull-requests" && capabilities?.supports("/pull-requests") !== false}<ThreadPullRequests
      {thread}
    />{:else if mode === "pull-requests"}<p class="px-3 py-2 text-sm text-zinc-500">
      Update Canopy on your gateway to link pull requests
    </p>{/if}

  {#if mode === "summary" && thread.newestPullRequest?.ref}
    {@const resource = thread.newestPullRequest.ref.id}
    <PanelRow icon="git-fork" onclick={() => workspace?.().openModule({ module: "pull-requests", resource })}>
      {thread.newestPullRequest.title || `Pull request #${thread.newestPullRequest.ref.number}`}
    </PanelRow>
  {/if}

  {#if mode === "tasks" && onbackground}<BackgroundTasksSection
      tasks={backgroundTasks}
      threadId={thread.id}
      {items}
      onopen={onbackground}
    />{/if}

  {#if mode === "summary" && activeSecrets.length > 0 && onsecretchange}
    <section aria-labelledby="secrets-title" class="grid min-w-0 grid-cols-1 px-1.5 py-1">
      <h2 id="secrets-title" class="px-2 py-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Secrets</h2>
      <ul role="list" class="grid grid-cols-1 gap-0.5">
        {#each activeSecrets as secret (secret.requestId)}
          <li><ThreadSecretRow {secret} onchange={onsecretchange} /></li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if mode === "tasks"}
    <section aria-labelledby="schedules-title" class="grid min-w-0 grid-cols-1 px-1.5 py-1">
      <h2 id="schedules-title" class="px-2 py-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        Scheduled tasks
      </h2>
      {#if panelSchedules.length > 0}
        <ul role="list" class="grid grid-cols-1 gap-0.5">
          {#each panelSchedules as schedule (schedule.id)}
            <li>
              <ScheduleCompactRow
                {schedule}
                disabled={stale}
                onchange={(updated) => {
                  onschedulechange?.(updated);
                  void panel.reload().catch(() => undefined);
                }}
              />
            </li>
          {/each}
        </ul>
      {/if}
      {#if onschedule}
        <PanelRow icon="plus" onclick={onschedule} disabled={stale} class="text-zinc-500 dark:text-zinc-400"
          >Schedule a task</PanelRow
        >
      {:else if !panelSchedules.length}<p class="px-2 py-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
          No scheduled tasks
        </p>
      {/if}
    </section>
  {/if}

  {#if mode === "summary" && thread.forkSourceThreadId}
    <section aria-label="Fork" class="grid min-w-0 grid-cols-1 px-1.5 py-1">
      <PanelRow icon="square-2-stack" href="/threads/{thread.forkSourceThreadId}">
        Forked from {source?.title ?? "another thread"}
        {#snippet aside()}
          <!-- The fork point stays readable when a long title truncates. -->
          {#if thread.forkAfterTurnOrdinal}<span class="shrink-0 text-zinc-500 tabular-nums dark:text-zinc-400"
              >Turn {thread.forkAfterTurnOrdinal}</span
            >{/if}
          <Icon name="arrow-top-right-on-square" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
        {/snippet}
      </PanelRow>
    </section>
  {/if}

  {#if mode === "summary"}<ThreadLineage {tree} currentId={thread.id} {onnewside} />{/if}
</div>
