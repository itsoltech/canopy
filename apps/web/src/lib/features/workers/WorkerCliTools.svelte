<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import Button from "#lib/shared/ui/Button.svelte";
  import ActionNote from "./ActionNote.svelte";
  import CliToolRow from "./CliToolRow.svelte";
  import { cliActions } from "./cli-tools.svelte.ts";
  import CliCheckSettings from "./CliCheckSettings.svelte";
  import WorkerSection from "./WorkerSection.svelte";
  import { useGatewayCapabilities } from "#lib/features/desktop/gateway-capabilities.svelte.ts";
  import TextLink from "#lib/shared/ui/TextLink.svelte";
  import { updateCenter, type UpdatesState } from "./updates.svelte.ts";
  import { untrack } from "svelte";

  /** The agent CLIs on one worker (docs/provider-cli.md): Canopy never bundles them, it installs them on request. */
  let {
    worker,
    readOnly = "",
    anchor,
    updates = updateCenter,
  }: { worker: ui.Worker; readOnly?: string; anchor?: string | undefined; updates?: UpdatesState } = $props();

  const cli = cliActions();
  const capabilities = useGatewayCapabilities();
  const key = $derived(`check/${worker.id}`);

  const blocked = $derived(
    !worker.online ||
      !!readOnly ||
      (capabilities && capabilities.state !== "ready") ||
      updates.cliBlocked(worker.id, worker.nodeId),
  );

  $effect(() => {
    if (updates === updateCenter && updates.readable) return untrack(() => updates.poll());
  });
</script>

<WorkerSection title="Agent CLIs" description="Nothing changes until you install or update." {anchor}>
  {#snippet actions()}
    <Button
      size="sm"
      icon="arrow-path"
      loading={cli.pending[key]}
      disabled={blocked || capabilities?.supportsMethod("CheckCliUpdates") === false}
      onclick={() => void cli.check(worker.id)}>Check for updates</Button
    >
  {/snippet}
  {#if worker.cliTools.length}<div class="grid gap-6">
      {#each worker.cliTools as item (item.tool?.provider)}
        <CliToolRow
          workerId={worker.id}
          {item}
          disabled={blocked || capabilities?.supportsMethod("InstallCli") === false}
        />
      {/each}
    </div>
  {:else}
    <p class="text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400">
      {#if worker.online && !readOnly}
        This worker has not reported its CLIs. <TextLink href="/settings/app-updates#topic-status"
          >Check for a worker update</TextLink
        >.
      {:else}Connect the worker to see its CLIs.{/if}
    </p>
  {/if}
  <ActionNote error={cli.errors[key]} note={cli.notes[key]} />
  <CliCheckSettings {worker} {readOnly} flush />
</WorkerSection>
