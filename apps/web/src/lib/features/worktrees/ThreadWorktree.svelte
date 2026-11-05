<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import WorktreeBadge from "./WorktreeBadge.svelte";

  /** The worktree badge as a button (opens Manage worktree). It shrinks with its container and truncates the branch. */
  let {
    worktree,
    onclick,
    class: className,
  }: { worktree: ui.ThreadWorktree; onclick: () => void; class?: ClassValue } = $props();
</script>

<button
  type="button"
  {onclick}
  aria-label="Manage worktree"
  class={["flex min-w-0 rounded-md p-1 focus-ring hover:bg-zinc-950/5 dark:hover:bg-white/5", className]}
>
  <WorktreeBadge {worktree} class="max-w-full" />
</button>
