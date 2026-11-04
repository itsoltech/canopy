<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import SettingsGroup from "#lib/shared/ui/SettingsGroup.svelte";
  import ActionNote from "./ActionNote.svelte";
  import CliToolRow from "./CliToolRow.svelte";
  import { cliActions } from "./cli-tools.svelte.ts";

  /** The agent CLIs on one worker (docs/provider-cli.md): Canopy never bundles them, it installs them on request. */
  let { worker }: { worker: ui.Worker } = $props();
  const cli = cliActions();
  const key = $derived(`check/${worker.id}`);
</script>

<SettingsGroup title="Agent CLIs" description="Installed on this machine. Nothing changes until you install or update.">
  {#snippet actions()}
    <Button
      size="sm"
      icon="arrow-path"
      loading={cli.pending[key]}
      disabled={!worker.online}
      onclick={() => void cli.check(worker.id)}>Check for updates</Button
    >
  {/snippet}
  {#each worker.cliTools as item (item.tool?.provider)}
    <CliToolRow workerId={worker.id} {item} class="p-4" />
  {:else}
    <p class="p-4 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      {worker.online
        ? "This worker has not reported its CLIs. Update the worker to manage them here."
        : "Connect the worker to see its CLIs."}
    </p>
  {/each}
  <ActionNote error={cli.errors[key]} note={cli.notes[key]} class="p-4" />
</SettingsGroup>
