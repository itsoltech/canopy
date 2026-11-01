<script lang="ts">
  import { create } from "@bufbuild/protobuf";
  import { PermissionMode, Provider, ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { permissionLabel, permissionModes, providerLabel } from "#lib/features/threads/labels.ts";
  import { isProviderKey, profilesFor, providerKeyOf, providerKeys } from "#lib/features/threads/providers.ts";
  import ModelIdField from "#lib/features/models/ModelIdField.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import { modelFor, withModel } from "./thread-defaults.ts";

  /**
   * Rows of thread defaults (workspace, agent, profile, model, permissions) for Settings → Threads and a
   * project's settings. With `inherited` (the user's defaults) every field can stay "Use my default";
   * the agent's profile and model follow the agent, so they are set only together with it.
   */
  let {
    value,
    workspaces,
    inherited,
    onchange,
  }: {
    value: ui.ThreadDefaults;
    /** Workspaces to choose from, grouped by project. */
    workspaces: readonly { project: ui.Project; workspaces: readonly ui.Workspace[] }[];
    inherited?: ui.ThreadDefaults | undefined;
    onchange: (next: ui.ThreadDefaults) => void;
  } = $props();

  const overview = useOverview();
  const provider = $derived(providerKeyOf(value.provider));
  // Profiles any worker offers for the provider (the thread's worker decides when it starts).
  const profiles = $derived(provider ? [...new Set(overview.workers.flatMap((w) => profilesFor(w, provider).map((p) => p.id)))] : []);
  const inheritedAgent = $derived(inherited && inherited.provider !== Provider.UNSPECIFIED ? providerLabel(inherited.provider) : "any available");

  const set = (change: Partial<Omit<ui.ThreadDefaults, "$typeName">>) => onchange(create(ui.ThreadDefaultsSchema, { ...value, ...change }));
  const selected = (event: Event) => (event.currentTarget as HTMLSelectElement | HTMLInputElement).value;
  const workerName = (ws: ui.Workspace) => overview.worker(ws.workerId)?.name ?? "Unknown worker";
</script>

<SettingsRow
  title={inherited ? "Worker" : "Project and worker"}
  description={inherited ? "Where new threads of this project start." : "Where new threads start. Projects and “New thread” in a project take precedence."}
>
  {#snippet control()}
    <Select name="workspaceId" aria-label={inherited ? "Default worker" : "Default project and worker"} value={value.workspaceId} onchange={(e) => set({ workspaceId: selected(e) })} class="w-56 sm:w-64">
      <option value="">Last used</option>
      {#each workspaces.filter((g) => g.workspaces.length > 0) as group (group.project.id)}
        <optgroup label={group.project.name}>
          {#each group.workspaces as ws (ws.id)}<option value={ws.id}>{workerName(ws)} · {ws.rootPath}</option>{/each}
        </optgroup>
      {/each}
    </Select>
  {/snippet}
</SettingsRow>
<SettingsRow title="Agent" description="Claude or Codex. New threads offer only what the workspace's worker has.">
  {#snippet control()}
    <Select
      name="provider"
      aria-label="Default agent"
      value={provider ?? ""}
      onchange={(e) => {
        const key = selected(e);
        // The profile belongs to the agent; models are kept per agent.
        set({ provider: isProviderKey(key) ? Provider[key] : Provider.UNSPECIFIED, providerProfileId: "" });
      }}
      class="w-56 sm:w-48"
    >
      <option value="">{inherited ? `Use my default (${inheritedAgent})` : "Any available"}</option>
      {#each providerKeys as key (key)}<option value={key}>{providerLabel(Provider[key])}</option>{/each}
    </Select>
  {/snippet}
</SettingsRow>
{#if provider}
  <SettingsRow title="Profile" description="How the agent reaches its model.">
    {#snippet control()}
      <Select name="profileId" aria-label="Default profile" value={value.providerProfileId} onchange={(e) => set({ providerProfileId: selected(e) })} class="w-56 sm:w-48">
        <option value="">First available</option>
        {#each profiles as id (id)}<option value={id}>{id}</option>{/each}
      </Select>
    {/snippet}
  </SettingsRow>
  <SettingsRow title="Model" description="Leave empty for the profile's default model.">
    {#snippet control()}
      <ModelIdField
        provider={provider}
        label="Default {providerLabel(value.provider)} model"
        value={modelFor(value, value.provider)}
        onchange={(model) => set({ models: withModel(value.models, value.provider, model) })}
        class="w-56 sm:w-48"
      />
    {/snippet}
  </SettingsRow>
{/if}
<SettingsRow title="Permissions" description={permissionModes.find((m) => PermissionMode[m.value] === value.permissionMode)?.description}>
  {#snippet control()}
    <Select
      name="permissionMode"
      aria-label="Default permissions"
      value={value.permissionMode === PermissionMode.UNSPECIFIED ? (inherited ? "" : "ASK") : PermissionMode[value.permissionMode]}
      onchange={(e) => {
        const key = selected(e);
        set({ permissionMode: key in PermissionMode ? PermissionMode[key as keyof typeof PermissionMode] : PermissionMode.UNSPECIFIED });
      }}
      class="w-56 sm:w-48"
    >
      {#if inherited}<option value="">Use my default ({permissionLabel(inherited.permissionMode)})</option>{/if}
      {#each permissionModes as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
    </Select>
  {/snippet}
</SettingsRow>
