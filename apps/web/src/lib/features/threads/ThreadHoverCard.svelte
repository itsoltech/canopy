<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { Snippet } from "svelte";
  import { MediaQuery } from "svelte/reactivity";
  import { goalLook } from "#lib/features/goals/goals.ts";
  import { effortLevel } from "#lib/features/models/catalog.ts";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { basename } from "#lib/shared/format.ts";
  import HoverCard, { type HoverTriggerProps } from "#lib/shared/ui/HoverCard.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { dotTones, textTones } from "#lib/shared/ui/tone.ts";
  import { byActivity, workState } from "./activity.ts";
  import { isFullAuto, permissionLabel, permissionLook, providerLabel } from "./labels.ts";
  import { instanceLabel, instanceOf, providerKeyOf } from "./providers.ts";
  import { isSide, sideMark } from "./thread-tree.ts";
  import SummaryRow from "./components/SummaryRow.svelte";
  import ThreadStatusText from "./ThreadStatusText.svelte";

  /**
   * A thread's summary next to its row in lists (T3's hover card): title, project, worker, folder, agent
   * (model, effort, profile), permission mode, what it does now (status, background tasks, goal) and the
   * first side threads with theirs. Hover or keyboard focus opens it, tap-and-hold on touch; a tap still
   * opens the thread. `row` renders the list row, spreading the trigger props on its link. The same facts
   * are on the thread's page (details panel).
   */
  const SIDES_SHOWN = 3;
  const muted = "size-4 fill-zinc-400 dark:fill-zinc-500";
  let { thread, row }: { thread: ui.Thread; row: Snippet<[HoverTriggerProps]> } = $props();
  const overview = useOverview();
  // Beside the row where the sidebar leaves room; under it in the phone drawer.
  const beside = new MediaQuery("min-width: 40rem");
</script>

<HoverCard label="Thread {thread.title}" placement={beside.current ? "right-start" : "bottom-start"} touch="press" class="w-80">
  {#snippet trigger(props)}{@render row(props)}{/snippet}
  {@const project = overview.project(thread.projectId)}
  {@const worker = overview.worker(thread.workerId)}
  {@const provider = providerKeyOf(thread.provider)}
  {@const instance = providerKeyOf(thread.provider) ? instanceOf(worker, providerKeyOf(thread.provider)!, thread.providerProfileId) : undefined}
  {@const permission = permissionLook(thread.permissionMode)}
  {@const goal = thread.goalStatus ? goalLook(thread.goalStatus) : undefined}
  {@const sides = isSide(thread) ? [] : [...overview.threads.values()].filter((t) => isSide(t) && t.parentThreadId === thread.id).sort(byActivity)}
  <div class="grid gap-3 text-sm/5 text-zinc-600 sm:text-xs/5 dark:text-zinc-400">
    <p class="text-base/6 font-semibold text-pretty text-zinc-950 sm:text-sm/5 dark:text-white">{thread.title}</p>
    <ul role="list" class="grid gap-1.5">
      <SummaryRow>
        {#snippet mark()}<ProjectAvatar name={project?.name ?? "?"} class="size-4" />{/snippet}
        <span class="truncate">{project?.name ?? "Unknown project"}</span>
      </SummaryRow>
      <SummaryRow>
        {#snippet mark()}<Icon name="computer-desktop" class={muted} />{/snippet}
        <span class="truncate">{worker?.name ?? "Unknown worker"}</span>
        {#snippet aside()}<StatusDot tone={worker?.online ? "emerald" : "neutral"} />{worker?.online ? osLabel(worker.os) : "Offline"}{/snippet}
      </SummaryRow>
      <SummaryRow>
        {#snippet mark()}<Icon name="folder" class={muted} />{/snippet}
        <code class="truncate font-mono" title={thread.cwd}>{basename(thread.cwd)}</code>
      </SummaryRow>
      <SummaryRow>
        {#snippet mark()}{#if provider}<ProviderIcon {provider} class="size-4 opacity-70" />{:else}<Icon name="cpu-chip" class={muted} />{/if}{/snippet}
        <span class="truncate">{providerLabel(thread.provider)}{thread.model ? ` ${thread.model}` : ""}{thread.effort ? ` · ${effortLevel(thread.effort).label}` : ""}</span>
        {#snippet aside()}{#if thread.providerProfileId}<span class="text-zinc-500">{instance ? instanceLabel(instance) : thread.providerProfileId}</span>{/if}{/snippet}
      </SummaryRow>
      <SummaryRow>
        {#snippet mark()}<Icon name={permission.icon} class={["size-4", permission.iconClass]} />{/snippet}
        <span class={["truncate", isFullAuto(thread.permissionMode) && permission.textClass]}>{permissionLabel(thread.permissionMode)}</span>
      </SummaryRow>
      <SummaryRow>
        {#snippet mark()}<Icon name="signal" class={muted} />{/snippet}
        {#if workState(thread) === "idle" && thread.status === "idle"}<span>Idle<span class="text-zinc-400 dark:text-zinc-600">{" · "}</span></span>{/if}
        <ThreadStatusText {thread} />
        {#if thread.backgroundTasks > 0}
          <span class={["flex shrink-0 items-center gap-0.5 tabular-nums", textTones.sky]}><Icon name="bolt" class="size-3.5" />{thread.backgroundTasks} in background</span>
        {/if}
      </SummaryRow>
      {#if goal}
        <SummaryRow>
          {#snippet mark()}<Icon name="flag" class={["size-4", dotTones[goal.tone]]} />{/snippet}
          <span class={["truncate", textTones[goal.tone]]}>Goal: {goal.label.toLowerCase()}</span>
        </SummaryRow>
      {/if}
    </ul>
    {#if sides.length > 0}
      <div class="grid gap-1.5 border-t border-zinc-950/5 pt-3 dark:border-white/8">
        <p class="text-zinc-500">{sides.length} side {sides.length === 1 ? "thread" : "threads"}</p>
        <ul role="list" class="grid gap-1.5">
          {#each sides.slice(0, SIDES_SHOWN) as side (side.id)}
            {@const look = sideMark(side)}
            <SummaryRow>
              {#snippet mark()}<Icon name={look.icon} class={["size-4", look.iconClass]} />{/snippet}
              <span class="truncate text-zinc-700 dark:text-zinc-300">{side.title}</span>
              {#snippet aside()}<ThreadStatusText thread={side} />{/snippet}
            </SummaryRow>
          {/each}
        </ul>
        {#if sides.length > SIDES_SHOWN}<p class="text-zinc-500">and {sides.length - SIDES_SHOWN} more</p>{/if}
      </div>
    {/if}
  </div>
</HoverCard>
