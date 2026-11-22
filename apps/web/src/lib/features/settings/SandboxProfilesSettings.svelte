<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import SandboxProfileDialog from "./SandboxProfileDialog.svelte";
  import { useSettingsRoute } from "./settings-route.ts";
  import { useSettings } from "./settings-state.svelte.ts";

  const settings = useSettings();
  const route = useSettingsRoute();
  const addButtonId = $props.id();
  const domainPreviewLimit = 3;
  let dialog: ReturnType<typeof SandboxProfileDialog>;
  let section = $state<HTMLDivElement>();

  $effect(() => {
    if (route.url.hash !== "#sandbox-profiles" || !section) return;
    const target = section;

    const frame = requestAnimationFrame(() => {
      target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    });

    return () => cancelAnimationFrame(frame);
  });
</script>

<div id="sandbox-profiles" class="min-w-0 scroll-mt-4 outline-none" tabindex="-1" bind:this={section}>
  <SettingsGroup
    title="Sandbox profiles"
    description="A thread can use these shell network rules only if its agent CLI and worker support them."
  >
    {#snippet actions()}
      <Button
        id={addButtonId}
        size="sm"
        icon="plus"
        disabled={!settings.loaded}
        onclick={() => dialog.show({ mode: "add" })}>Add profile</Button
      >
    {/snippet}
    {#each settings.sandboxProfiles as profile (profile.id)}
      {@const remaining = profile.allowedDomains.length - domainPreviewLimit}
      <SettingsRow title={profile.name}>
        <p class="text-sm/5 wrap-anywhere text-muted">
          {#if profile.allowedDomains.length}
            Allows {profile.allowedDomains.slice(0, domainPreviewLimit).join(", ")}{remaining > 0
              ? ` and ${remaining.toLocaleString()} more`
              : ""}.
          {:else}
            Blocks all outbound shell connections.
          {/if}
        </p>
        {#snippet control()}
          <Button
            size="sm"
            aria-label={`Edit profile “${profile.name}”`}
            onclick={() => dialog.show({ mode: "edit", profile })}>Edit</Button
          >
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Delete profile “${profile.name}”`}
            onclick={() => dialog.show({ mode: "delete", profile })}>Delete</Button
          >
        {/snippet}
      </SettingsRow>
    {:else}
      {#if settings.loaded}
        <SettingsRow title="No sandbox profiles yet" />
      {:else}
        <p class="settings-row px-4 py-3.5 text-sm/5 text-muted" role="status">Loading sandbox profiles…</p>
      {/if}
    {/each}
  </SettingsGroup>
</div>

<SandboxProfileDialog bind:this={dialog} ondelete={() => document.getElementById(addButtonId)?.focus()} />
