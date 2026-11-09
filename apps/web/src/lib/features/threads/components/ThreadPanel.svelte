<script lang="ts">
  import ThreadSecretRow from "./secrets/ThreadSecretRow.svelte";
  import ThreadConnectors from "#lib/features/connectors/ThreadConnectors.svelte";
  import { timestampMs } from "@bufbuild/protobuf/wkt";
  import { terminalCwd } from "#lib/shared/ui/terminal.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import MiddleTruncatedText from "#lib/shared/ui/MiddleTruncatedText.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import ScheduleCompactRow from "#lib/features/schedules/ScheduleCompactRow.svelte";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import type { ThreadTree } from "../thread-tree.ts";
  import ThreadLineage from "./ThreadLineage.svelte";
  import PanelRow from "./PanelRow.svelte";
  import BackgroundTasksSection from "./BackgroundTasksSection.svelte";
  import type { BackgroundEntry } from "../background-tasks.ts";
  import type { Item } from "@canopy/contracts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import ThreadTitleActions from "./ThreadTitleActions.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { headLabel, worktreeTooltip } from "@canopy/domain/git-heads";

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
    class: className,
  }: {
    thread: ui.Thread;
    tree: ThreadTree;
    worker: ui.Worker | undefined;
    /** Active and paused schedules of the thread. */
    schedules: readonly ui.Schedule[];
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
    class?: ClassValue;
  } = $props();

  const activeSecrets = $derived(
    secrets.filter((s) => s.status === "saved" && (!s.expiresAt || timestampMs(s.expiresAt) > clock.now)),
  );

  const overview = useOverview();
  const scratch = $derived(overview.project(thread.projectId)?.kind === "scratch");

  const lookup = (id: string) => (tree.main.id === id ? tree.main : tree.sides.find((s) => s.id === id));
  const directory = useThreadDirectory();

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
  <ThreadTitleActions {thread} compact class={windowTitlebar ? "macos:hidden" : undefined} />
  <!-- Connector accounts are per computer (stage 4); a linked computer's thread uses that computer's. -->
  {#if !thread.nodeId}<ThreadConnectors threadId={thread.id} />{/if}
  <section aria-label="Placement" class="grid min-w-0 grid-cols-1 px-1.5 pb-1">
    <PanelRow icon="computer-desktop">
      <TruncatedText text={worker?.name ?? "Unknown worker"} />
      {#snippet aside()}
        <span class="flex shrink-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/5">
          <StatusDot tone={worker?.online ? "emerald" : "neutral"} />{worker?.online ? osLabel(worker.os) : "Offline"}
        </span>
      {/snippet}
    </PanelRow>
    <!-- One line: the path shortened in the middle (home as ~), all of it in the tooltip and one click from the clipboard. -->
    <PanelRow icon="folder">
      {#if scratch}
        <span {@attach tooltip(`${thread.cwd} — kept after the thread ends; remove it by hand when no thread needs it`)}
          >Scratch folder</span
        >
      {:else}
        <MiddleTruncatedText text={terminalCwd(thread.cwd, Infinity)} hint={thread.cwd} class="font-mono" />
      {/if}
      {#snippet aside()}<span
          class="flex shrink-0 pointer-fine:opacity-0 pointer-fine:group-focus-within/panel-row:opacity-100 pointer-fine:group-hover/panel-row:opacity-100"
          ><CopyButton text={thread.cwd} label="Copy working directory" /></span
        >{/snippet}
    </PanelRow>
    {#if thread.worktree}
      <!-- A git worktree (docs/worktrees.md): its branch and what it started from; opens Manage worktree. -->
      <PanelRow icon="git-fork" onclick={onworktree}>
        <MiddleTruncatedText
          text={headLabel(thread.worktree)}
          hint={`${headLabel(thread.worktree)} · ${worktreeTooltip(thread.worktree)}`}
          class="font-mono"
        />
        {#snippet aside()}{#if thread.worktree?.baseRef}<span
              class="max-w-2/5 min-w-0 truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
              {@attach tooltip(`Started from ${thread.worktree.baseRef}`)}
              >from <code class="font-mono">{thread.worktree.baseRef}</code></span
            >{/if}{/snippet}
      </PanelRow>
    {:else if thread.checkoutHead && headLabel(thread.checkoutHead)}
      <!-- The workspace's own checkout: its live branch, as the worker reports it. -->
      <PanelRow icon="git-fork">
        <MiddleTruncatedText text={headLabel(thread.checkoutHead)} class="font-mono" />
        {#snippet aside()}<span class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
            >Current checkout</span
          >{/snippet}
      </PanelRow>
    {/if}
  </section>

  {#if onbackground}<BackgroundTasksSection
      tasks={backgroundTasks}
      threadId={thread.id}
      {items}
      onopen={onbackground}
    />{/if}

  {#if activeSecrets.length > 0 && onsecretchange}
    <section aria-labelledby="secrets-title" class="grid min-w-0 grid-cols-1 px-1.5 py-1">
      <h2 id="secrets-title" class="px-2 py-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Secrets</h2>
      <ul role="list" class="grid grid-cols-1 gap-0.5">
        {#each activeSecrets as secret (secret.requestId)}
          <li><ThreadSecretRow {secret} onchange={onsecretchange} /></li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if schedules.length > 0 || onschedule}
    <section aria-labelledby="schedules-title" class="grid min-w-0 grid-cols-1 px-1.5 py-1">
      <h2 id="schedules-title" class="px-2 py-0.5 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        Scheduled tasks
      </h2>
      {#if schedules.length > 0}
        <ul role="list" class="grid grid-cols-1 gap-0.5">
          {#each schedules as schedule (schedule.id)}
            <li><ScheduleCompactRow {schedule} onchange={onschedulechange} /></li>
          {/each}
        </ul>
      {/if}
      {#if onschedule}
        <PanelRow icon="plus" onclick={onschedule} class="text-zinc-500 dark:text-zinc-400">Schedule a task</PanelRow>
      {/if}
    </section>
  {/if}

  {#if thread.forkSourceThreadId}
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

  <ThreadLineage {tree} currentId={thread.id} {onnewside} />
</div>
