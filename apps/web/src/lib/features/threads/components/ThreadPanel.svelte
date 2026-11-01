<script lang="ts">
  import type { ui, Usage } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import { formatCount } from "#lib/shared/format.ts";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import { permissionLabel, providerLabel } from "../labels.ts";
  import type { ThreadTree } from "../thread-tree.ts";
  import ThreadStatusText from "../ThreadStatusText.svelte";
  import PanelRow from "./PanelRow.svelte";

  /**
   * Context of a thread (T3's right panel): where it runs, which agent, usage, and its lineage — the
   * main thread with its side threads, agent-started ones marked — plus "New side thread".
   */
  let {
    thread,
    tree,
    worker,
    usage,
    onnewside,
    class: className,
  }: {
    thread: ui.Thread;
    tree: ThreadTree;
    worker: ui.Worker | undefined;
    usage: Usage | undefined;
    onnewside?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();
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
    <PanelRow icon="signal">
      Status
      {#snippet aside()}<StatusBadge status={thread.status} />{/snippet}
    </PanelRow>
    {#if usage && (usage.inputTokens > 0n || usage.outputTokens > 0n)}
      <PanelRow icon="bolt">
        <span class="tabular-nums">{formatCount(usage.inputTokens)} in · {formatCount(usage.outputTokens)} out</span>
        {#snippet aside()}{#if usage.contextWindowTokens > 0n}<span class="shrink-0 text-sm/5 text-zinc-500 tabular-nums sm:text-xs/5">{formatCount(usage.contextWindowTokens)} ctx</span>{/if}{/snippet}
      </PanelRow>
    {/if}
  </section>

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
            icon={side.spawnedByAgent ? "sparkles" : "arrow-turn-down-right"}
            iconClass={side.spawnedByAgent ? "fill-violet-500 dark:fill-violet-400" : undefined}
            href="/threads/{side.id}"
            current={side.id === thread.id}
            class="pl-6"
          >
            {side.title}{#if side.spawnedByAgent}<span class="sr-only"> (started by an agent)</span>{/if}
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
