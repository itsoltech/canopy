<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { count } from "@canopy/domain/usage-report";
  import { effortLevel } from "#lib/features/models/catalog.ts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { providerLabel } from "#lib/features/threads/labels.ts";
  import { instanceLabel } from "#lib/features/threads/providers.ts";
  import { formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import HabitProjectPicker from "./HabitProjectPicker.svelte";
  import { habitReportedCost } from "./habits-format.ts";

  let {
    settings,
    draft = $bindable(),
    projects,
    models,
    usage,
    disabled,
    valid = $bindable(false),
  }: {
    settings: ui.MemoryReflectionSettings;
    draft: ui.MemoryReflectionSettings;
    projects: ui.MemoryReflectionProject[];
    models: ui.MemoryReflectionModel[];
    usage?: ui.MemoryReflectionUsage | undefined;
    disabled: boolean;
    valid?: boolean;
  } = $props();

  const overview = useOverview();
  const tokens = $derived(usage ? usage.inputTokens + usage.outputTokens : 0n);

  const intervals = [
    { value: "360", label: "Every 6 hours" },
    { value: "720", label: "Every 12 hours" },
    { value: "1440", label: "Every 24 hours" },
    { value: "4320", label: "Every 3 days" },
    { value: "10080", label: "Every 7 days" },
  ];

  const checkStates = new Map([
    ["running", "Checking…"],
    ["completed", "Completed"],
    ["empty", "No eligible messages"],
    ["unavailable", "Worker unavailable"],
    ["failed", "Failed"],
    ["invalid", "Unusable result"],
    ["superseded", "Discarded"],
    ["unknown", "Result unavailable"],
  ]);

  const lastCheck = $derived(checkStates.get(settings.lastRunState));
  const showNext = $derived(settings.enabled && !!settings.nextRunAt);

  const profileKey = (option: Pick<ui.MemoryReflectionModel, "workerId" | "provider" | "profileId">) =>
    JSON.stringify([option.workerId, option.provider, option.profileId || "native"]);

  const projectWorkspaces = $derived(
    draft.projectIds.flatMap((id) => {
      const project = overview.ownProjects.find((project) => project.id === id);

      return project ? [project.workspaces] : [];
    }),
  );

  const eligibleModels = $derived(
    models.filter((model) =>
      projectWorkspaces.every((workspaces) => workspaces.some((ws) => ws.workerId === model.workerId)),
    ),
  );

  const profiles = $derived(new Map(eligibleModels.map((model) => [profileKey(model), model])));
  const profile = $derived(profiles.get(profileKey(draft)));

  const modelOptions = $derived(
    new Map(
      eligibleModels
        .filter((model) => profileKey(model) === profileKey(draft) && model.model)
        .map((item) => [item.model, item]),
    ),
  );

  const model = $derived(modelOptions.get(draft.model));
  const efforts = $derived(model?.efforts ?? []);
  const missingProject = $derived(draft.projectIds.some((id) => !projects.some((project) => project.id === id)));

  const projectHint = $derived(
    missingProject
      ? "Remove unavailable projects before turning on habit checks."
      : !projects.length
        ? "Add a project to turn on habit checks."
        : draft.enabled && !draft.projectIds.length
          ? "Choose at least one project."
          : undefined,
  );

  const profileHint = $derived(
    !models.length
      ? "Sign in to a provider on a connected worker."
      : !profiles.size
        ? "Choose projects that share a worker with an available provider profile."
        : draft.enabled && !profile
          ? "Choose a provider profile to turn on habit checks."
          : undefined,
  );

  $effect(() => {
    valid =
      !draft.enabled ||
      (!!draft.projectIds.length &&
        !missingProject &&
        !!profile &&
        (!draft.model || !!model) &&
        (!draft.effort || efforts.includes(draft.effort)));
  });

  function profileName(option: ui.MemoryReflectionModel): string {
    const worker = overview.ownWorkers.find((worker) => worker.id === option.workerId);
    const provider = providerLabel(option.provider);
    const id = option.profileId || "native";
    const instance = worker?.providerInstances.find((item) => item.harness === option.provider && item.id === id);

    const name = instanceLabel(instance ?? { id, label: "" });

    return [provider, name !== provider && name, worker?.name || option.workerName].filter(Boolean).join(" · ");
  }

  function changeProfile(key: string) {
    const next = profiles.get(key);

    if (!next || key === profileKey(draft)) return;
    const { workerId, provider, profileId } = next;
    draft = { ...draft, workerId, provider, profileId, model: "", effort: "" };
  }
</script>

<SettingsRow
  title="Learn from repeated requests"
  description="Canopy suggests habits based on messages in selected projects."
>
  {#snippet control()}
    <Switch
      name="learn-habits"
      label="Learn from repeated requests"
      checked={draft.enabled}
      {disabled}
      onchange={(enabled) => (draft = { ...draft, enabled })}
    />
  {/snippet}
</SettingsRow>
<SettingsRow title="Projects" description={projectHint}>
  {#snippet control()}
    <HabitProjectPicker
      {projects}
      value={draft.projectIds}
      {disabled}
      onchange={(projectIds) => (draft = { ...draft, projectIds })}
    />
  {/snippet}
</SettingsRow>
<SettingsRow title="Check for habits">
  {#snippet control()}
    <Select
      aria-label="Check for habits"
      options={intervals}
      value={String(draft.intervalMinutes)}
      {disabled}
      onchange={(interval) => (draft = { ...draft, intervalMinutes: Number(interval) })}
    />
  {/snippet}
</SettingsRow>
<SettingsRow title="Provider profile" description={profileHint}>
  {#snippet control()}
    <Select
      aria-label="Provider profile"
      options={[...profiles].map(([value, option]) => {
        const label = profileName(option);

        return { value, label, tooltip: label };
      })}
      value={profileKey(draft)}
      placeholder={draft.workerId ? "Unavailable profile" : "Choose a provider profile"}
      disabled={disabled || !profiles.size}
      class="w-64 max-w-full"
      onchange={changeProfile}
    />
  {/snippet}
</SettingsRow>
<SettingsRow
  title="Model"
  description={profile && draft.model && !model ? "Choose an available model or use Auto." : undefined}
>
  {#snippet control()}
    <Select
      aria-label="Model"
      options={[
        { value: "", label: "Auto" },
        ...[...modelOptions.values()].map((option) => ({
          value: option.model,
          label: option.label || option.model,
          tooltip: option.label || option.model,
        })),
      ]}
      value={draft.model}
      placeholder={draft.model || "Auto"}
      disabled={disabled || !profile}
      class="w-64 max-w-full"
      onchange={(model) => {
        if (model !== draft.model) draft = { ...draft, model, effort: "" };
      }}
    />
  {/snippet}
</SettingsRow>
{#if efforts.length || (model && draft.effort)}
  <SettingsRow
    title="Reasoning effort"
    description={draft.effort && !efforts.includes(draft.effort)
      ? "Choose an available effort or use Auto."
      : undefined}
  >
    {#snippet control()}
      <Select
        aria-label="Reasoning effort"
        options={[{ value: "", label: "Auto" }, ...efforts.map((id) => ({ value: id, label: effortLevel(id).label }))]}
        value={draft.effort}
        placeholder={draft.effort}
        {disabled}
        onchange={(effort) => (draft = { ...draft, effort })}
      />
    {/snippet}
  </SettingsRow>
{/if}
{#if showNext || settings.lastRunAt || lastCheck}
  <div class="settings-row flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-sm/5 text-muted" role="status">
    {#if showNext}<span
        >Next check <time datetime={isoDateTime(settings.nextRunAt)}>{formatDateTime(settings.nextRunAt)}</time></span
      >{/if}
    {#if settings.lastRunAt || lastCheck}
      <span>
        Last check
        {#if settings.lastRunAt}<time datetime={isoDateTime(settings.lastRunAt)}
            >{formatDateTime(settings.lastRunAt)}</time
          >{/if}
        {#if settings.lastRunAt && lastCheck}
          ·
        {/if}
        {lastCheck}
      </span>
    {/if}
  </div>
{/if}
<div class="settings-row flex flex-wrap gap-x-4 gap-y-1 px-4 py-3 text-sm/5 text-muted tabular-nums">
  <span class="font-medium">Last 30 days</span>
  {#if usage}
    <span>{count(BigInt(usage.attempts))} {usage.attempts === 1 ? "attempt" : "attempts"}</span>
    <span>{tokens ? `${count(tokens)} reported ${tokens === 1n ? "token" : "tokens"}` : "No reported tokens"}</span>
    {#if usage.reportedCostUsd !== undefined}<span>{habitReportedCost(usage.reportedCostUsd)} reported cost</span>{/if}
  {:else}
    <span>Usage unavailable</span>
  {/if}
</div>
