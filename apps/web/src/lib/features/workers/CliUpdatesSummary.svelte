<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import SettingsRow from "#lib/shared/ui/SettingsRow.svelte";
  import ActionNote from "./ActionNote.svelte";
  import { cliActions, cliLabel, providerUpdates } from "./cli-tools.svelte.ts";

  /** Agent CLI updates across the owner's workers, with "Update all" per provider. Shown only when there are some. */
  let { workers, class: className }: { workers: readonly ui.Worker[]; class?: ClassValue } = $props();
  const cli = cliActions();
  const updates = $derived(providerUpdates(workers));
</script>

{#if updates.length > 0}
  <SettingsGroup title="Agent CLI updates" description="Newer versions of the agent CLIs on your workers. Workers with running turns update when you try again later." class={className}>
    {#snippet actions()}
      <Button size="sm" icon="arrow-path" loading={cli.pending["check/"]} onclick={() => void cli.check()}>Check for updates</Button>
    {/snippet}
    {#each updates as update (update.provider)}
      {@const key = `all/${update.provider}`}
      <SettingsRow title={`${cliLabel(update.provider)} ${update.version}`} description={`${update.workers.length} worker${update.workers.length === 1 ? "" : "s"}: ${update.workers.map((w) => w.name).join(", ")}`}>
        {#snippet control()}
          <Button size="sm" icon="arrow-up" loading={cli.pending[key]} onclick={() => void cli.updateAll(update.provider)}>Update all</Button>
        {/snippet}
        <ActionNote error={cli.errors[key]} note={cli.notes[key]} class="mt-1" />
      </SettingsRow>
    {/each}
  </SettingsGroup>
{/if}
