<script lang="ts">
  import type { ui, Usage } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import { formatCount } from "#lib/shared/format.ts";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { permissionLabel, providerLabel } from "../labels.ts";
  import type { UsageTotals } from "../thread-state.svelte.ts";
  import { isSide, type ThreadTree } from "../thread-tree.ts";
  import ThreadStatusText from "../ThreadStatusText.svelte";
  import PanelRow from "./PanelRow.svelte";

  /**
   * Context of a thread (T3's right panel): where it runs, which agent, who answers its approvals,
   * usage, and its lineage — the main thread with its side threads, agent-started and forked ones
   * marked — plus "New side thread".
   */
  let {
    thread,
    tree,
    worker,
    usage,
    totals,
    onnewside,
    class: className,
  }: {
    thread: ui.Thread;
    tree: ThreadTree;
    worker: ui.Worker | undefined;
    /** Latest live usage (context window). */
    usage: Usage | undefined;
    /** Usage of the thread's own turns. */
    totals: UsageTotals;
    onnewside?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const lookup = (id: string) => (tree.main.id === id ? tree.main : tree.sides.find((s) => s.id === id));
  const source = $derived(thread.forkSourceThreadId ? lookup(thread.forkSourceThreadId) : undefined);
  const parent = $derived(thread.parentThreadId ? lookup(thread.parentThreadId) : undefined);
  const hasUsage = $derived(totals.inputTokens > 0n || totals.outputTokens > 0n);
</script>

<div class={["grid grid-cols-1 divide-y divide-zinc-950/5 rounded-2xl bg-white p-1.5 shadow-sm ring-1 ring-zinc-950/10 dark:divide-white/8 dark:bg-zinc-950 dark:shadow-none dark:ring-white/10", className]}>
  <section aria-label="Placement" class="grid grid-cols-1 pb-1.5">
    <PanelRow icon="computer-desktop">
      {worker?.name ?? "Unknown worker"}
      {#snippet aside()}
        <span class="flex shrink-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/5">
          <StatusDot tone={worker?.online ? "emerald" : "neutral"} />{worker?.online ? osLabel(worker.os) : "Offline"}
        </span>
      {/snippet}
    </PanelRow>
    <PanelRow icon="folder"><code class="font-mono text-[0.8125rem]" title={thread.cwd}>{thread.cwd}</code></PanelRow>
  </section>

  <section aria-label="Agent" class="grid grid-cols-1 py-1.5">
    <PanelRow icon="cpu-chip">
      {providerLabel(thread.provider)}{thread.model ? ` ${thread.model}` : ""}
      {#snippet aside()}{#if thread.providerProfileId}<span class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5">{thread.providerProfileId}</span>{/if}{/snippet}
    </PanelRow>
    <PanelRow icon="shield-check">{permissionLabel(thread.permissionMode)}</PanelRow>
    {#if isSide(thread)}
      <PanelRow icon="hand-raised" iconClass={thread.interactionRoute === "parent" ? "fill-violet-500 dark:fill-violet-400" : undefined}>
        {#if thread.interactionRoute === "parent"}
          <span title="Approvals and questions of this thread go to the agent of “{parent?.title ?? 'the parent thread'}”. You can answer them here instead.">Main agent answers approvals</span>
        {:else}
          You answer approvals
        {/if}
        {#snippet aside()}{#if thread.interactionRoute === "parent"}<span class="shrink-0 text-sm/5 text-zinc-500 sm:text-xs/5">You can step in</span>{/if}{/snippet}
      </PanelRow>
    {/if}
    <PanelRow icon="signal">
      Status
      {#snippet aside()}<StatusBadge status={thread.status} />{/snippet}
    </PanelRow>
    {#if hasUsage}
      <PanelRow icon="bolt">
        <span class="tabular-nums" title="Tokens of this thread's turns">{formatCount(totals.inputTokens)} in · {formatCount(totals.outputTokens)} out</span>
        {#snippet aside()}
          <span class="shrink-0 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5">
            {#if totals.costUsd > 0}${totals.costUsd.toFixed(3)}{:else if usage && usage.contextWindowTokens > 0n}{formatCount(usage.contextWindowTokens)} ctx{/if}
          </span>
        {/snippet}
      </PanelRow>
    {/if}
  </section>

  {#if thread.forkSourceThreadId}
    <section aria-label="Fork" class="grid grid-cols-1 py-1.5">
      <PanelRow icon="square-2-stack" href="/threads/{thread.forkSourceThreadId}">
        Forked from {source?.title ?? "another thread"}
        {#snippet aside()}<Icon name="arrow-top-right-on-square" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />{/snippet}
      </PanelRow>
    </section>
  {/if}

  <section aria-labelledby="lineage-title" class="grid grid-cols-1 pt-1.5">
    <h2 id="lineage-title" class="px-3 pt-1 pb-1 text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">Lineage</h2>
    <ul role="list" class="grid grid-cols-1 gap-0.5">
      <li>
        <PanelRow icon="chat-bubble-left-right" href="/threads/{tree.main.id}" current={tree.main.id === thread.id}>
          {tree.main.title}
          {#snippet aside()}<ThreadStatusText thread={tree.main} />{/snippet}
        </PanelRow>
      </li>
      {#each tree.sides as side (side.id)}
        <li>
          <PanelRow
            icon={side.spawnedByAgent ? "sparkles" : side.forkSourceThreadId ? "square-2-stack" : "arrow-turn-down-right"}
            iconClass={side.spawnedByAgent ? "fill-violet-500 dark:fill-violet-400" : undefined}
            href="/threads/{side.id}"
            current={side.id === thread.id}
            class="pl-6"
          >
            {side.title}{#if side.spawnedByAgent}<span class="sr-only"> (started by an agent)</span>{/if}{#if side.forkSourceThreadId}<span class="sr-only"> (fork)</span>{/if}
            {#snippet aside()}<ThreadStatusText thread={side} />{/snippet}
          </PanelRow>
        </li>
      {/each}
    </ul>
    {#if onnewside}
      <PanelRow icon="plus" onclick={onnewside} class="text-zinc-500 dark:text-zinc-400">New side thread</PanelRow>
    {/if}
  </section>
</div>
