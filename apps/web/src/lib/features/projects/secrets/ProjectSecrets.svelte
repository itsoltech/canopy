<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { formatDateTime, isoDateTime } from "#lib/shared/format.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import Skeleton from "#lib/shared/ui/Skeleton.svelte";
  import { listProjectSecrets } from "./api.ts";
  import ProjectSecretDialog from "./ProjectSecretDialog.svelte";

  /**
   * Project settings → Secrets: names and update times only. Values are write only (docs/ui-api.md); the list is
   * held in this component, never in a shared cache.
   */
  let { projectId }: { projectId: string } = $props();

  const addButtonId = $props.id();
  let dialog: ReturnType<typeof ProjectSecretDialog>;
  let secrets = $state.raw<ui.ProjectSecret[]>();
  let failed = $state(false);
  let loading = $state(false);

  async function load() {
    loading = true;
    failed = false;

    try {
      const loaded = await listProjectSecrets(projectId);

      secrets = loaded.toSorted((a, b) => a.name.localeCompare(b.name));
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  function saved(secret: ui.ProjectSecret) {
    secrets = [...(secrets ?? []).filter((item) => item.name !== secret.name), secret].toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  function deleted(name: string) {
    secrets = (secrets ?? []).filter((item) => item.name !== name);
    document.getElementById(addButtonId)?.focus();
  }
</script>

<SettingsGroup title="Secrets" description="Agents in this project's threads can ask for these by name.">
  {#snippet actions()}
    <Button
      id={addButtonId}
      size="sm"
      icon="plus"
      disabled={!secrets}
      onclick={() => dialog.show({ mode: "add", names: (secrets ?? []).map((item) => item.name) })}>Add secret</Button
    >
  {/snippet}
  {#if failed}
    <div class="p-4">
      <Alert tone="error" title="Could not load secrets">
        Check your connection, then retry.
        {#snippet actions()}<Button size="sm" {loading} onclick={() => void load()}>Retry</Button>{/snippet}
      </Alert>
    </div>
  {:else if !secrets}
    <div class="p-4" role="status" aria-label="Loading secrets"><Skeleton class="h-10 w-full" /></div>
  {:else}
    {#each secrets as secret (secret.name)}
      <div class="settings-row flex flex-col items-start gap-3 px-4 py-3.5 sm:flex-row sm:items-center">
        <div class="settings-row-copy min-w-0 flex-1">
          <p class="font-mono text-base/6 font-medium wrap-anywhere text-zinc-950 sm:text-sm/6 dark:text-white">
            {secret.name}
          </p>
          {#if secret.updatedAt}<p class="text-sm/5 text-zinc-500 dark:text-zinc-400">
              Updated <time datetime={isoDateTime(secret.updatedAt)}>{formatDateTime(secret.updatedAt)}</time>
            </p>{/if}
        </div>
        <div class="settings-row-control flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            aria-label={`Replace value of ${secret.name}`}
            onclick={() => dialog.show({ mode: "replace", name: secret.name })}>Replace value</Button
          >
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Delete ${secret.name}`}
            onclick={() => dialog.show({ mode: "delete", name: secret.name })}>Delete</Button
          >
        </div>
      </div>
    {:else}
      <SettingsRow title="No secrets yet" description="Add one so agents can use it without seeing it in a thread." />
    {/each}
  {/if}
</SettingsGroup>

<ProjectSecretDialog bind:this={dialog} {projectId} onsaved={saved} ondeleted={deleted} />
