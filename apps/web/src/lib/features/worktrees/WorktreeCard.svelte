<script lang="ts">
  import { headLabel } from "@canopy/domain/git-heads";
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatRelative } from "#lib/shared/format.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import WorktreeActions from "./WorktreeActions.svelte";

  let {
    entry,
    onchange,
    class: className,
  }: { entry: ui.WorktreeEntry; onchange: () => void; class?: ClassValue } = $props();

  const overview = useOverview();
  const status = $derived(entry.status);
</script>

<article class={["grid min-w-0 gap-3 py-4", className]}>
  <div class="flex min-w-0 flex-wrap items-baseline justify-between gap-2">
    <h3 class="min-w-0 font-mono text-base font-medium break-all sm:text-sm">
      {status?.branch || (entry.worktree && headLabel(entry.worktree))}
    </h3>
    <span class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400"
      >{overview.worker(entry.worktree?.workerId ?? "")?.name ?? "Computer"}</span
    >
  </div>
  <code class="font-mono text-base break-all text-zinc-500 sm:text-sm dark:text-zinc-400">{entry.worktree?.path}</code>
  {#if status && !status.detail}
    <p class="text-base text-zinc-600 sm:text-sm dark:text-zinc-300">
      {status.dirtyFiles} changed {status.dirtyFiles === 1 ? "file" : "files"} · ↑{status.ahead} ahead · ↓{status.behind}
      behind{status.unpushed ? " · Unpushed commits" : ""}{status.merged ? " · Merged" : ""}
    </p>
  {/if}
  <p class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
    {#if entry.worktree?.external}{`Created outside Canopy${entry.worktree.unavailableReason ? ` · ${entry.worktree.unavailableReason}` : ""}`}
    {:else}Managed by Canopy · Last activity {formatRelative(entry.lastActivityAt)} · {entry.detail}{/if}
  </p>
  <WorktreeActions {entry} {onchange} />
</article>
