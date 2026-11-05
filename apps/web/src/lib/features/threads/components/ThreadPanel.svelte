<script lang="ts">
  import ThreadWorktree from "#lib/features/worktrees/ThreadWorktree.svelte";
  import ThreadSecretRow from "./secrets/ThreadSecretRow.svelte";
  import ThreadConnectors from "#lib/features/connectors/ThreadConnectors.svelte";
  import { timestampMs } from "@bufbuild/protobuf/wkt";
  import { terminalCwd } from "#lib/shared/ui/terminal.ts";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import type { ui, Usage } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import ScheduleCompactRow from "#lib/features/schedules/ScheduleCompactRow.svelte";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import { formatCount, formatDateTime } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { permissionLabel, permissionLook, providerLabel } from "../labels.ts";
  import type { UsageTotals } from "../thread-state.svelte.ts";
  import { instanceLabel, instanceOf, providerKeyOf } from "../providers.ts";
  import { isSide, type ThreadTree } from "../thread-tree.ts";
  import ThreadLineage from "./ThreadLineage.svelte";
  import PanelRow from "./PanelRow.svelte";
  import BackgroundTasksSection from "./BackgroundTasksSection.svelte";
  import type { BackgroundEntry } from "../background-tasks.ts";
  import type { Item } from "@canopy/contracts";
  import { useThreadDirectory } from "../thread-directory.ts";
  import ThreadTitleActions from "./ThreadTitleActions.svelte";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";

  /**
   * Context of a thread: where it runs, which agent, who answers its approvals,
   * usage, its scheduled tasks (pause, resume, cancel, schedule another), and its lineage — the main
   * thread with its side threads, agent-started and forked ones marked — plus "New side thread".
   */
  let {
    thread,
    tree,
    worker,
    usage,
    totals,
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
    /** Latest live usage (context window). */
    usage: Usage | undefined;
    /** Usage of the thread's own turns. */
    totals: UsageTotals;
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

  const providerKey = $derived(providerKeyOf(thread.provider));
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

  const parent = $derived(thread.parentThreadId ? lookup(thread.parentThreadId) : undefined);
  const hasUsage = $derived(totals.inputTokens > 0n || totals.outputTokens > 0n);
</script>

<div
  class={[
    "grid grid-cols-1 divide-y divide-zinc-950/5 rounded-2xl bg-white py-1.5 shadow-sm ring-1 ring-zinc-950/10 dark:divide-white/8 dark:bg-zinc-950 dark:shadow-none dark:ring-white/10",
    className,
  ]}
>
  <ThreadTitleActions {thread} class={windowTitlebar ? "macos:hidden" : undefined} />
  <!-- Connector accounts are per computer (stage 4); a linked computer's thread uses that computer's. -->
  {#if !thread.nodeId}<ThreadConnectors threadId={thread.id} />{/if}
  <section aria-label="Placement" class="grid grid-cols-1 px-1.5 pb-1.5">
    <PanelRow icon="computer-desktop">
      {worker?.name ?? "Unknown worker"}
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
        <code class="font-mono text-xs/6" {@attach tooltip(thread.cwd)}>{terminalCwd(thread.cwd, 34)}</code>
      {/if}
      {#snippet aside()}<CopyButton text={thread.cwd} label="Copy working directory" class="-my-1" />{/snippet}
    </PanelRow>
    {#if thread.worktree}
      <div class="px-2 py-1"><ThreadWorktree worktree={thread.worktree} onclick={onworktree} /></div>
      <!-- A git worktree (docs/worktrees.md): its branch and what it started from. -->
      <PanelRow icon="git-fork">
        <code class="font-mono text-xs/6" {@attach tooltip(`Worktree ${thread.worktree.path}`)}
          >{thread.worktree.branch}</code
        >
        {#snippet aside()}{#if thread.worktree?.baseRef}<span
              class="shrink-0 truncate text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400"
              >from <code class="font-mono">{thread.worktree.baseRef}</code></span
            >{/if}{/snippet}
      </PanelRow>
    {/if}
  </section>

  <section aria-label="Agent" class="grid grid-cols-1 p-1.5">
    <PanelRow icon="cpu-chip">
      {#snippet lead()}{#if providerKey}<ProviderIcon provider={providerKey} />{:else}<Icon
            name="cpu-chip"
            class="fill-zinc-400 dark:fill-zinc-500"
          />{/if}{/snippet}
      {providerLabel(thread.provider)}{thread.model ? ` ${thread.model}` : ""}
      {#snippet aside()}{#if thread.providerProfileId}{@const instance = providerKey
            ? instanceOf(worker, providerKey, thread.providerProfileId)
            : undefined}<span class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5"
            >{instance ? instanceLabel(instance) : thread.providerProfileId}</span
          >{/if}{/snippet}
    </PanelRow>
    <PanelRow
      icon={permissionLook(thread.permissionMode).icon}
      iconClass={permissionLook(thread.permissionMode).iconClass}>{permissionLabel(thread.permissionMode)}</PanelRow
    >
    {#if isSide(thread)}
      <PanelRow
        icon="hand-raised"
        iconClass={thread.interactionRoute === "parent" ? "text-violet-500 dark:text-violet-400" : undefined}
      >
        {#if thread.interactionRoute === "parent"}
          <span
            title="Approvals and questions of this thread go to the agent of “{parent?.title ??
              'the parent thread'}”. You can answer them here instead.">Main agent answers approvals</span
          >
        {:else}
          You answer approvals
        {/if}
        {#snippet aside()}{#if thread.interactionRoute === "parent"}<span
              class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5">You can step in</span
            >{/if}{/snippet}
      </PanelRow>
    {/if}
    <PanelRow icon="signal">
      Status
      {#snippet aside()}<StatusBadge status={thread.status} />{/snippet}
    </PanelRow>
    <!-- A thread that has run keeps this row from the first frame (a dash until the snapshot's totals
         arrive), so the sections below don't move down when they do. -->
    {#if hasUsage || thread.lastSeq > 0n}
      <PanelRow icon="bolt">
        {#if hasUsage}<span class="tabular-nums" title="Tokens of this thread's turns"
            >{formatCount(totals.inputTokens)} in · {formatCount(totals.outputTokens)} out</span
          >{:else}<span class="text-zinc-400 dark:text-zinc-500" aria-label="Token usage loading">–</span>{/if}
        {#snippet aside()}
          <span class="shrink-0 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5">
            {#if totals.costUsd > 0}${totals.costUsd.toFixed(
                3,
              )}{:else if usage && usage.contextWindowTokens > 0n}{formatCount(usage.contextWindowTokens)} ctx{/if}
          </span>
        {/snippet}
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
    <section aria-labelledby="secrets-title" class="grid grid-cols-1 p-1.5">
      <h2 id="secrets-title" class="px-3 pt-1 pb-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Secrets</h2>
      <ul role="list" class="grid grid-cols-1 gap-0.5">
        {#each activeSecrets as secret (secret.requestId)}
          <li><ThreadSecretRow {secret} onchange={onsecretchange} /></li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if schedules.length > 0 || onschedule}
    <section aria-labelledby="schedules-title" class="grid grid-cols-1 p-1.5">
      <h2 id="schedules-title" class="px-3 pt-1 pb-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
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
    <section aria-label="Fork" class="grid grid-cols-1 p-1.5">
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
