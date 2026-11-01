<script lang="ts">
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import { permissionModes } from "#lib/features/threads/labels.ts";
  import { threadDefaults } from "#lib/features/threads/thread-defaults.svelte.ts";
  import Button from "#lib/shared/ui/Button.svelte";
  import Input from "#lib/shared/ui/Input.svelte";
  import Select from "#lib/shared/ui/Select.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";

  const overview = useOverview();
  const values = $derived(threadDefaults.values);
  // Profiles any worker offers (the thread's worker decides at creation time).
  const profiles = $derived([...new Set(overview.workers.flatMap((w) => w.profiles.filter((p) => p.available).map((p) => p.id)))]);
  const changed = (event: Event) => (event.currentTarget as HTMLSelectElement | HTMLInputElement).value;
</script>

<svelte:head><title>Threads · Settings · Open Agents</title></svelte:head>

<SettingsGroup title="New threads" description="Starting values of the new-thread composer. Saved in this browser.">
  {#snippet actions()}
    <Button size="sm" icon="arrow-path" onclick={() => threadDefaults.reset()}>Restore defaults</Button>
  {/snippet}
  <SettingsRow title="Workspace" description="Where new threads start. A project link (New thread in a project) takes precedence.">
    {#snippet control()}
      <Select name="workspaceId" aria-label="Default workspace" value={values.workspaceId} onchange={(e) => threadDefaults.update({ workspaceId: changed(e) })} class="w-64">
        <option value="">First available</option>
        {#each overview.projects.filter((p) => p.workspaces.length > 0) as project (project.id)}
          <optgroup label={project.name}>
            {#each project.workspaces as ws (ws.id)}
              <option value={ws.id}>{overview.worker(ws.workerId)?.name ?? "Unknown worker"} · {ws.rootPath}</option>
            {/each}
          </optgroup>
        {/each}
      </Select>
    {/snippet}
  </SettingsRow>
  <SettingsRow title="Codex profile" description="How the agent reaches its model.">
    {#snippet control()}
      <Select name="profileId" aria-label="Default Codex profile" value={values.profileId} onchange={(e) => threadDefaults.update({ profileId: changed(e) })} class="w-48">
        {#each profiles as id (id)}<option value={id === "native" ? "" : id}>{id}</option>{:else}<option value="">Default</option>{/each}
      </Select>
    {/snippet}
  </SettingsRow>
  <SettingsRow title="Model" description="Leave empty for the profile's default model.">
    {#snippet control()}
      <Input name="model" aria-label="Default model" placeholder="Profile default" autocomplete="off" value={values.model} onchange={(e) => threadDefaults.update({ model: changed(e).trim() })} class="w-48" />
    {/snippet}
  </SettingsRow>
  <SettingsRow title="Permissions" description={permissionModes.find((m) => m.value === values.permissionMode)?.description}>
    {#snippet control()}
      <Select name="permissionMode" aria-label="Default permissions" value={values.permissionMode} onchange={(e) => threadDefaults.update({ permissionMode: changed(e) })} class="w-48">
        {#each permissionModes as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
      </Select>
    {/snippet}
  </SettingsRow>
</SettingsGroup>
