<script lang="ts">
  import { getContext } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import WorktreeSettingRow from "./WorktreeSettingRow.svelte";
  import WorktreeToggleSetting from "./WorktreeToggleSetting.svelte";
  import { overrides, type WorktreeSettingsState } from "./worktree-settings.svelte.ts";

  let { class: className }: { class?: ClassValue } = $props();
  const state = getContext<WorktreeSettingsState>("worktree-settings");
  const effective = $derived(state.current?.effective);
  const inherited = $derived(state.current?.inherited);

  const toggles = [
    {
      field: "cleanupDeletedThreads",
      title: "Deleted threads",
      description: "Remove a worktree once all its threads are deleted.",
    },
    {
      field: "cleanupMerged",
      title: "Merged branches",
      description: "Fetch, then check whether the branch is contained in the default or base branch.",
    },
    {
      field: "cleanupSettled",
      title: "Settled threads",
      description: "Remove worktrees whose threads are archived or have completed their latest turn.",
    },
    {
      field: "cleanupUnchanged",
      title: "Unchanged worktrees",
      description: "Remove clean worktrees with no commits since creation.",
    },
    {
      field: "keepLocalChanges",
      title: "Keep worktrees with local changes",
      description:
        "Keep uncommitted files and unpushed commits. Turning this off still requires manual confirmation for each worktree.",
    },
    {
      field: "deleteLocalBranch",
      title: "Delete safe local branches",
      description:
        "Also delete the local branch when merged or unchanged, with no unpushed commits. Otherwise keep it.",
    },
  ] as const;
</script>

{#if effective && inherited}
  <SettingsGroup
    title="Cleanup"
    description="Runs hourly and when a computer reconnects. Any matching rule can remove a worktree; active threads and local work are protected."
    class={className}
  >
    {#each toggles as toggle (toggle.field)}
      <WorktreeToggleSetting
        {...toggle}
        checked={effective[toggle.field] ?? false}
        inherited={inherited[toggle.field] ?? false}
        overridden={overrides(state.current?.settings, toggle.field)}
        onchange={(checked) => state.update({ [toggle.field]: checked })}
        onreset={() => state.update({ [toggle.field]: undefined })}
      />
    {/each}
    <WorktreeSettingRow
      field="cleanupInactiveDays"
      title="Inactive for days"
      description="Remove after this many days without thread or local file activity. Use 0 to turn this rule off."
      overridden={overrides(state.current?.settings, "cleanupInactiveDays")}
      inherited={String(inherited.cleanupInactiveDays ?? 0)}
      onreset={() => state.update({ cleanupInactiveDays: undefined })}
    >
      {#snippet control()}
        <Input
          type="number"
          name="cleanupInactiveDays"
          aria-label="Inactive for days"
          min={0}
          max={3650}
          step={1}
          value={effective.cleanupInactiveDays ?? 0}
          class="w-28"
          onchange={(event) => state.update({ cleanupInactiveDays: Number(event.currentTarget.value) })}
        />
      {/snippet}
    </WorktreeSettingRow>
  </SettingsGroup>
{/if}
