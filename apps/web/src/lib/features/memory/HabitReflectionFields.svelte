<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { count } from "@canopy/domain/usage-report";
  import { formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import HabitModelControls from "./HabitModelControls.svelte";
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

  let modelValid = $state(false);
  const tokens = $derived(usage ? usage.inputTokens + usage.outputTokens : 0n);

  const intervals = [
    { value: "60", label: "Every hour" },
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

  $effect(() => {
    valid = !draft.enabled || (!!draft.projectIds.length && !missingProject && modelValid);
  });
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
<HabitModelControls {models} bind:draft bind:valid={modelValid} {disabled} />
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
