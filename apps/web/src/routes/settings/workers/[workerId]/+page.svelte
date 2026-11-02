<script lang="ts">
  import { Provider, ui } from "@open-agents/contracts";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import WorkerSettings from "#lib/features/overview/WorkerSettings.svelte";
  import SettingsHeading from "#lib/features/settings/SettingsHeading.svelte";
  import { useSettingsRoute } from "#lib/features/settings/settings-route.ts";
  import DeleteProfileDialog from "#lib/features/profiles/DeleteProfileDialog.svelte";
  import ProfileDialog from "#lib/features/profiles/ProfileDialog.svelte";
  import ProfileRow from "#lib/features/profiles/ProfileRow.svelte";
  import { deleteProfile, profileName, saveProfile, toggleRequest, withReport } from "#lib/features/profiles/profiles.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import StatusBadge from "#lib/shared/ui/StatusBadge.svelte";
  import { toast } from "#lib/shared/ui/toast.svelte.ts";
  import { decode } from "#lib/shared/wire.ts";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();
  const route = useSettingsRoute();
  const overview = useOverview();

  const workerId = $derived(route.params.workerId ?? "");
  const worker = $derived(overview.worker(workerId));
  const loaded = $derived(decode(ui.ListProviderProfilesResponseSchema, data.profiles));
  const profiles = $derived(loaded.profiles.map((p) => withReport(p, worker)));

  let editing = $state<ui.ProviderProfileSettings>();
  let editorOpen = $state(false);
  let deleting = $state<ui.ProviderProfileSettings>();
  let deleteOpen = $state(false);
  let failure = $state<string>();

  const modelsHref = (profile: ui.ProviderProfileSettings) => (provider: Provider) =>
    `/settings/workers/${workerId}/models?profile=${encodeURIComponent(profile.id)}&provider=${provider === Provider.CLAUDE ? "claude" : "codex"}`;
  const reload = () => route.refresh("app:profiles");

  function edit(profile: ui.ProviderProfileSettings | undefined) {
    editing = profile;
    editorOpen = true;
  }

  async function toggle(profile: ui.ProviderProfileSettings) {
    failure = undefined;
    try {
      await saveProfile(toggleRequest(workerId, profile, loaded.configVersion));
      toast(`${profileName(profile)} turned ${profile.enabled ? "off" : "on"}`);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    await reload();
  }
</script>

<svelte:head><title>{worker?.name ?? "Worker"} · Settings · Open Agents</title></svelte:head>

<SettingsHeading title={worker?.name ?? "Worker"}>
  {#snippet actions()}{#if worker}<StatusBadge status={worker.online ? "online" : "offline"} />{/if}{/snippet}
</SettingsHeading>

<SettingsGroup title="Provider profiles" description="How the agents on this worker reach their models. Threads pick one when they start.">
  {#snippet actions()}<Button variant="primary" icon="plus" onclick={() => edit(undefined)}>New profile</Button>{/snippet}
  {#each profiles as profile (profile.id)}
    <ProfileRow
      {profile}
      modelsHref={modelsHref(profile)}
      onedit={() => edit(profile)}
      ontoggle={() => toggle(profile)}
      ondelete={() => ((deleting = profile), (deleteOpen = true))}
    />
  {/each}
</SettingsGroup>

{#if failure}<Alert tone="error">{failure}</Alert>{/if}
{#if worker && !worker.online}
  <Alert tone="info">This worker is offline. Profile changes are saved and reach it when it connects.</Alert>
{/if}

{#if worker}<WorkerSettings {worker} title="Machine" showProfiles={false} />{/if}

<ProfileDialog
  bind:open={editorOpen}
  {workerId}
  profile={editing}
  configVersion={loaded.configVersion}
  onsaved={(saved) => {
    toast(editing ? "Profile saved" : `${saved.profile ? profileName(saved.profile) : "Profile"} created`);
    void reload();
  }}
/>

{#if deleting}
  <DeleteProfileDialog
    bind:open={deleteOpen}
    profile={deleting}
    ondelete={async () => {
      await deleteProfile(workerId, deleting!.id, loaded.configVersion);
      toast("Profile deleted");
      await reload();
    }}
    ondisable={async () => {
      await saveProfile(toggleRequest(workerId, deleting!, loaded.configVersion));
      toast(`${profileName(deleting!)} turned off`);
      await reload();
    }}
  />
{/if}
