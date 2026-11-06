<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import { headLabel, worktreeTooltip } from "@canopy/domain/git-heads";

  /** The branch of a thread's git worktree, in the thread's header; the path in the tooltip (docs/worktrees.md). */
  let { worktree, class: className }: { worktree: ui.ThreadWorktree; class?: ClassValue } = $props();
</script>

<span
  class={[
    "flex min-w-0 items-center gap-1 rounded-md py-0.5 pr-1.5 pl-1 text-xs/5 text-zinc-600 ring-1 ring-zinc-950/10 dark:text-zinc-300 dark:ring-white/10",
    className,
  ]}
  {@attach tooltip(worktreeTooltip(worktree))}
>
  <Icon name="git-fork" size="sm" />
  <code class="truncate font-mono">{headLabel(worktree)}</code>
</span>
