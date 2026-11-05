<script lang="ts">
  import { ui } from "@canopy/contracts";
  import { setContext } from "svelte";
  import WorktreeChoiceSetting from "#lib/features/worktrees/WorktreeChoiceSetting.svelte";
  import WorktreeScopeBar from "#lib/features/worktrees/WorktreeScopeBar.svelte";
  import WorktreeSettingRow from "#lib/features/worktrees/WorktreeSettingRow.svelte";
  import WorktreeTextSetting from "#lib/features/worktrees/WorktreeTextSetting.svelte";
  import WorktreeCleanupSettings from "#lib/features/worktrees/WorktreeCleanupSettings.svelte";
  import WorktreeManagement from "#lib/features/worktrees/WorktreeManagement.svelte";
  import {
    overrides,
    WorktreeSettingsState,
    type WorktreeField,
    type WorktreeScope,
  } from "#lib/features/worktrees/worktree-settings.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import ConfigNotices from "#lib/features/computers/ConfigNotices.svelte";

  /** Settings → Worktrees (docs/worktrees.md): creation, branch names and the default for new threads, per scope. */
  const settingsState = new WorktreeSettingsState();

  setContext("worktree-settings", settingsState);

  let scope = $state<WorktreeScope>({ projectId: "", workerId: "" });

  $effect(() => void settingsState.load(scope));

  const own = $derived(settingsState.current?.settings);
  const inherited = $derived(settingsState.current?.inherited);
  const effective = $derived(settingsState.current?.effective);

  const naming = [
    { value: String(ui.BranchNaming.SEMANTIC), label: "Semantic prefix", description: "feat/…, fix/…, refactor/…" },
    { value: String(ui.BranchNaming.PREFIX), label: "Prefix", description: "<prefix>/<task>" },
    { value: String(ui.BranchNaming.TITLE), label: "Thread title", description: "The title as a slug" },
  ];

  const modes = [
    { value: String(ui.WorkspaceMode.CHECKOUT), label: "Current checkout" },
    { value: String(ui.WorkspaceMode.NEW_WORKTREE), label: "New worktree" },
  ];

  const is = (field: WorktreeField) => overrides(own, field);
  const reset = (field: WorktreeField) => settingsState.update({ [field]: undefined });
</script>

<svelte:head><title>Worktrees · Settings · Canopy</title></svelte:head>

<div class="settings-stack">
  <WorktreeScopeBar {scope} disabled={settingsState.saving > 0} onchange={(next) => (scope = next)} />
  <ConfigNotices
    match={(notice) =>
      !scope.workerId && notice.kind === "worktree_policy" && notice.localId === (scope.projectId || "account")}
    onchange={() => void settingsState.load(scope)}
  />
  {#if settingsState.error}<Alert tone="error">{settingsState.error}</Alert>{/if}

  {#if !effective || !inherited}
    <Skeleton class="h-64 w-full" />
  {:else}
    <SettingsGroup
      title="Creation"
      description="Where new worktrees go and what they start from. Existing worktrees stay where they are."
    >
      <WorktreeTextSetting
        name="worktreeLocation"
        field="location"
        title="Worktree location"
        description="An absolute directory path on the computer. Empty: Canopy manages one in the worker's data directory."
        placeholder="Managed by Canopy"
        inputClass="w-64"
        value={effective.location ?? ""}
        overridden={is("location")}
        inherited={inherited.location || "Managed by Canopy"}
        onsave={(location) => settingsState.update({ location })}
        onreset={() => reset("location")}
      />
      <WorktreeSettingRow
        title="Start from remote"
        field="startFromRemote"
        description="New worktrees start from the base branch's latest remote commit, or from the local branch if it has no remote."
        overridden={is("startFromRemote")}
        inherited={inherited.startFromRemote ? "On" : "Off"}
        onreset={() => reset("startFromRemote")}
      >
        {#snippet control()}
          <Switch
            name="startFromRemote"
            label="Start from remote"
            checked={effective.startFromRemote ?? false}
            onchange={(checked) => settingsState.update({ startFromRemote: checked })}
          />
        {/snippet}
      </WorktreeSettingRow>
      <div class="px-4 py-3">
        <Disclosure summaryClass="py-1 text-base/6 sm:text-sm/6">
          {#snippet summary()}Advanced{/snippet}
          <WorktreeTextSetting
            name="worktreeRemote"
            field="remote"
            title="Remote"
            description="Used when the base branch tracks no remote branch."
            class="-mx-4"
            value={effective.remote ?? "origin"}
            overridden={is("remote")}
            inherited={inherited.remote || "origin"}
            onsave={(remote) => settingsState.update({ remote: remote || undefined })}
            onreset={() => reset("remote")}
          />
        </Disclosure>
      </div>
    </SettingsGroup>

    <SettingsGroup title="Branches" description="How the branch of a new worktree is named.">
      <WorktreeChoiceSetting
        name="branchNaming"
        field="branchNaming"
        title="Branch naming"
        description="Semantic prefix asks the text-generation model for a type from the first message."
        options={naming}
        value={effective.branchNaming}
        inherited={inherited.branchNaming}
        overridden={is("branchNaming")}
        onchange={(branchNaming) => settingsState.update({ branchNaming })}
        onreset={() => reset("branchNaming")}
      />
      <WorktreeTextSetting
        name="branchPrefix"
        field="branchPrefix"
        title="Branch prefix"
        description="For prefix names, and the first name before a semantic one arrives."
        value={effective.branchPrefix ?? ""}
        overridden={is("branchPrefix")}
        inherited={inherited.branchPrefix || "canopy"}
        onsave={(branchPrefix) => settingsState.update({ branchPrefix: branchPrefix || undefined })}
        onreset={() => reset("branchPrefix")}
      />
    </SettingsGroup>

    <SettingsGroup title="New threads">
      <WorktreeChoiceSetting
        name="defaultMode"
        field="defaultMode"
        title="Default workspace"
        description="What the new-thread composer starts with on this scope."
        options={modes}
        value={effective.defaultMode}
        inherited={inherited.defaultMode}
        overridden={is("defaultMode")}
        onchange={(defaultMode) => settingsState.update({ defaultMode })}
        onreset={() => reset("defaultMode")}
      />
    </SettingsGroup>
    <WorktreeCleanupSettings />
    {#key `${scope.projectId}:${scope.workerId}:${settingsState.current?.version}`}
      <WorktreeManagement {scope} />
    {/key}
  {/if}
</div>
