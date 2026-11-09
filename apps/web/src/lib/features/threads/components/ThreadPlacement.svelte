<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { placementPath } from "@canopy/domain/git-heads";
  import { osLabel } from "#lib/features/overview/workers.ts";
  import CopyButton from "#lib/shared/ui/CopyButton.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import PanelRow from "./PanelRow.svelte";
  import ThreadBranch from "./ThreadBranch.svelte";

  let {
    thread,
    worker,
    onworktree,
    class: className,
  }: { thread: ui.Thread; worker?: ui.Worker; onworktree: () => void; class?: ClassValue } = $props();

  const path = $derived(placementPath(thread.cwd, worker?.homeDirectory));
</script>

<section aria-label="Placement" class={["grid min-w-0 grid-cols-1 px-1.5 pb-1", className]}>
  <PanelRow icon="computer-desktop">
    <TruncatedText text={worker?.name ?? "Unknown worker"} />
    {#snippet aside()}<div class="flex shrink-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/5">
        <StatusDot tone={worker?.online ? "emerald" : "neutral"} />{worker?.online ? osLabel(worker.os) : "Offline"}
      </div>{/snippet}
  </PanelRow>
  <div class="group/path grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 px-2 py-2">
    <Icon name="folder" class="mt-0.5 shrink-0" />
    <div class="grid min-w-0 gap-1">
      <p class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
        {thread.worktree ? "Worktree" : "Directory"}
      </p>
      <p class="font-mono text-sm/5 wrap-anywhere sm:text-xs/5" {@attach tooltip(thread.cwd)}>
        <span class="text-zinc-500 dark:text-zinc-400">{path.parent}</span><strong
          class="font-semibold text-zinc-800 dark:text-zinc-200">{path.name}</strong
        >
      </p>
    </div>
    <div
      class="shrink-0 pointer-fine:opacity-0 pointer-fine:group-focus-within/path:opacity-100 pointer-fine:group-hover/path:opacity-100"
    >
      <CopyButton text={thread.cwd} label="Copy working directory" />
    </div>
  </div>
  {#if thread.worktree || thread.checkoutHead}<ThreadBranch {thread} {worker} />{/if}
  {#if thread.worktree}<PanelRow icon="cog-6-tooth" onclick={onworktree}>Manage worktree</PanelRow>{/if}
</section>
