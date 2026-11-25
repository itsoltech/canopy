<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import ActionNote from "./ActionNote.svelte";
  import { cliActions, cliLabel, providerUpdates } from "./cli-tools.svelte.ts";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";

  /** Agent CLI updates across the owner's workers, with "Update all" per provider. Shown only when there are some. */
  let { workers, class: className }: { workers: readonly ui.Worker[]; class?: ClassValue } = $props();
  const cli = cliActions();
  const capabilities = useGatewayCapabilities();
  const updates = $derived(providerUpdates(workers));
  const offline = $derived(!!capabilities && capabilities.state !== "ready");
</script>

{#if updates.length > 0}
  <SettingsGroup
    title="Agent CLI updates"
    description="These updates apply to agent CLIs on workers registered with this gateway."
    class={className}
  >
    {#snippet actions()}
      <Button
        size="sm"
        icon="arrow-path"
        loading={cli.pending["check/"]}
        disabled={offline || capabilities?.supportsMethod("CheckCliUpdates") === false}
        onclick={() => void cli.check()}>Check for updates</Button
      >
    {/snippet}
    {#each updates as update (update.provider)}
      {@const key = `all/${update.provider}`}
      <SettingsRow
        title={`${cliLabel(update.provider)} ${update.version}`}
        description={update.workers.map((w) => w.name).join(", ")}
      >
        {#snippet control()}
          <Button
            size="sm"
            icon="arrow-up"
            loading={cli.pending[key]}
            disabled={offline || capabilities?.supportsMethod("InstallCli") === false}
            onclick={() => void cli.updateAll(update.provider)}>Update all</Button
          >
        {/snippet}
        <ActionNote error={cli.errors[key]} note={cli.notes[key]} class="mt-1" />
      </SettingsRow>
    {/each}
    <ActionNote error={cli.errors["check/"]} note={cli.notes["check/"]} class="px-4" />
  </SettingsGroup>
{/if}
