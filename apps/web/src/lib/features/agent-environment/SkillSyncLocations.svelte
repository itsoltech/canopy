<script lang="ts">
  import Button from "#lib/shared/ui/Button.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { fileState, skillLocation } from "./computer-skills.ts";
  import type { SyncComputer } from "./skill-sync.ts";

  let {
    groups,
    busy,
    oncomputer,
  }: {
    groups: readonly SyncComputer[];
    busy: boolean;
    oncomputer: (id: string) => void;
  } = $props();
</script>

<Disclosure>
  {#snippet summary()}<span class="text-muted">Show affected locations</span>{/snippet}
  <div class="grid gap-4 pt-3">
    {#each groups as { worker, files } (worker.workerId)}
      <section class="grid min-w-0 gap-2">
        <h3 class="font-medium">{worker.name}</h3>
        {#each files as file (file.targetId)}
          <div>
            <p>{skillLocation(file)} · {fileState(file)}</p>
            {#if file.path}<p class="font-mono text-sm wrap-anywhere text-muted select-text">{file.path}</p>{/if}
          </div>
        {/each}
        <div>
          <Button size="sm" disabled={busy} onclick={() => oncomputer(worker.workerId)}>Review on computer</Button>
        </div>
      </section>
    {/each}
  </div>
</Disclosure>
