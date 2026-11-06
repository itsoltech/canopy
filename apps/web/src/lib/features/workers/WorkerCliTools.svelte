<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ActionNote from "./ActionNote.svelte";
  import CliToolRow from "./CliToolRow.svelte";
  import { cliActions } from "./cli-tools.svelte.ts";
  import CliCheckSettings from "./CliCheckSettings.svelte";
  import WorkerSection from "./WorkerSection.svelte";

  /** The agent CLIs on one worker (docs/provider-cli.md): Canopy never bundles them, it installs them on request. */
  let { worker, readOnly = "" }: { worker: ui.Worker; readOnly?: string } = $props();
  const cli = cliActions();
  const key = $derived(`check/${worker.id}`);
</script>

<WorkerSection title="Agent CLIs" description="Nothing changes until you install or update.">
  {#snippet actions()}
    <Button
      size="sm"
      icon="arrow-path"
      loading={cli.pending[key]}
      disabled={!worker.online || Boolean(readOnly)}
      onclick={() => void cli.check(worker.id)}>Check for updates</Button
    >
  {/snippet}
  {#if worker.cliTools.length}<div class="grid gap-6">
      {#each worker.cliTools as item (item.tool?.provider)}
        <CliToolRow workerId={worker.id} {item} disabled={Boolean(readOnly)} />
      {/each}
    </div>
  {:else}
    <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      {worker.online && !readOnly
        ? "This worker has not reported its CLIs. Update the worker to manage them here."
        : "Connect the worker to see its CLIs."}
    </p>
  {/if}
  <ActionNote error={cli.errors[key]} note={cli.notes[key]} />
  <CliCheckSettings {worker} {readOnly} flush />
</WorkerSection>
