<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import ActionNote from "#lib/features/workers/ActionNote.svelte";
  import { cliActions, cliLabel, providerUpdates } from "#lib/features/workers/cli-tools.svelte.ts";

  let { workers, class: className }: { workers: readonly ui.Worker[]; class?: ClassValue } = $props();
  const cli = cliActions();
  const updates = $derived(providerUpdates(workers));
</script>

{#if updates.length > 0}
  <div class={["flex flex-wrap items-center gap-2", className]}>
    {#each updates as update (update.provider)}
      {@const key = `all/${update.provider}`}
      <div class="grid gap-1">
        <Button
          size="sm"
          icon="arrow-up"
          loading={cli.pending[key]}
          onclick={() => void cli.updateAll(update.provider)}
        >
          Update {cliLabel(update.provider)} on all workers
        </Button>
        <ActionNote error={cli.errors[key]} note={cli.notes[key]} />
      </div>
    {/each}
  </div>
{/if}
