<script lang="ts">
  import { ui } from "@canopy/contracts";
  import { setContext } from "svelte";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import ButtonLink from "#lib/shared/ui/ButtonLink.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import WorktreeChoiceSetting from "./WorktreeChoiceSetting.svelte";
  import { overrides, WorktreeSettingsState } from "./worktree-settings.svelte.ts";

  /**
   * Project settings → Worktrees: the project's default workspace on every computer (the project ×
   * All computers scope of Settings → Worktrees, docs/worktrees.md). The rest of the scope stays there.
   */
  let { projectId }: { projectId: string } = $props();

  const settingsState = new WorktreeSettingsState();

  setContext("worktree-settings", settingsState);

  $effect(() => {
    void settingsState.load({ projectId, workerId: "" });
  });

  const own = $derived(settingsState.current?.settings);
  const inherited = $derived(settingsState.current?.inherited);
  const effective = $derived(settingsState.current?.effective);

  const modes = [
    { value: String(ui.WorkspaceMode.CHECKOUT), label: "Current checkout" },
    { value: String(ui.WorkspaceMode.NEW_WORKTREE), label: "New worktree" },
  ];
</script>

<SettingsGroup title="Worktrees" description="Where new threads in this project start, on every computer.">
  {#snippet actions()}
    <ButtonLink href="/settings/worktrees?project={projectId}" size="sm" variant="ghost" icon="cog-6-tooth">
      Worktree settings
    </ButtonLink>
  {/snippet}
  {#if settingsState.error}
    <div class="p-4"><Alert tone="error">{settingsState.error}</Alert></div>
  {:else if !effective || !inherited}
    <Skeleton class="h-16 w-full" />
  {:else}
    <WorktreeChoiceSetting
      name="projectDefaultMode"
      field="defaultMode"
      title="Default workspace"
      description="You can choose a different workspace for each thread."
      options={modes}
      value={effective.defaultMode}
      inherited={inherited.defaultMode}
      overridden={overrides(own, "defaultMode")}
      onchange={(defaultMode) => settingsState.update({ defaultMode })}
      onreset={() => settingsState.update({ defaultMode: undefined })}
    />
  {/if}
</SettingsGroup>
