<script lang="ts">
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";

  let { settings, class: className }: { settings: ui.WorktreeSettings | undefined; class?: ClassValue } = $props();

  const fields = {
    location: "Worktree location",
    startFromRemote: "Start from remote",
    remote: "Remote",
    branchNaming: "Branch naming",
    branchPrefix: "Branch prefix",
    defaultMode: "Default workspace",
    cleanupDeletedThreads: "Clean up deleted threads",
    cleanupMerged: "Clean up merged branches",
    cleanupInactiveDays: "Inactive days",
    cleanupSettled: "Clean up settled worktrees",
    cleanupUnchanged: "Clean up unchanged worktrees",
    keepLocalChanges: "Keep local changes",
    deleteLocalBranch: "Delete local branch",
  };

  const labels = new Map(Object.entries(fields));

  const rows = $derived(
    Object.entries(settings ?? {}).flatMap(([key, value]) => {
      const label = labels.get(key);

      if (!label || value === undefined || ((key === "branchNaming" || key === "defaultMode") && !value)) return [];

      const text =
        key === "branchNaming"
          ? new Map([
              [ui.BranchNaming.SEMANTIC, "Semantic prefix"],
              [ui.BranchNaming.PREFIX, "Prefix"],
              [ui.BranchNaming.TITLE, "Thread title"],
            ]).get(Number(value))
          : key === "defaultMode"
            ? value === ui.WorkspaceMode.NEW_WORKTREE
              ? "New worktree"
              : "Current checkout"
            : value === true
              ? "On"
              : value === false
                ? "Off"
                : String(value);

      return [{ label, text }];
    }),
  );
</script>

<SettingsGroup
  title="Saved worker overrides"
  description="Connect this computer to view inherited values and edit these saved overrides."
  class={className}
>
  <dl class="grid min-w-0 gap-3 p-4 text-sm">
    {#each rows as row (row.label)}<div class="grid min-w-0 gap-1 sm:grid-cols-2">
        <dt class="text-zinc-500 dark:text-zinc-400">{row.label}</dt>
        <dd class="break-all">{row.text}</dd>
      </div>
    {:else}<p>No overrides saved for this scope.</p>{/each}
  </dl>
</SettingsGroup>
