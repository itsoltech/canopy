<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import WorktreeBadge from "./WorktreeBadge.svelte";

  let {
    worktree,
    onclick,
    class: className,
  }: { worktree: ui.ThreadWorktree; onclick: () => void; class?: ClassValue } = $props();
</script>

<div class={["min-w-0", className]}>
  <Button variant="ghost" size="sm" {onclick} aria-label="Manage worktree">
    <WorktreeBadge {worktree} class="max-w-48" />
  </Button>
</div>
