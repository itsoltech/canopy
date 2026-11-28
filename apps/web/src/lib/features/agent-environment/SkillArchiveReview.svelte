<script lang="ts">
  import Checkbox from "#lib/shared/ui/Checkbox.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { archiveLocation, skillLocation } from "./computer-skills.ts";
  import type { SyncComputer } from "./skill-sync.ts";

  let {
    skillName,
    groups,
    remaining,
    busy,
    selected = $bindable(),
  }: {
    skillName: string;
    groups: SyncComputer[];
    remaining: number;
    busy: boolean;
    selected: string[];
  } = $props();
</script>

<p>
  Canopy archives the local copies of “{skillName}” on the selected computers, then installs the library version.
</p>
<fieldset class="grid min-w-0 gap-2" disabled={busy}>
  <legend class="sr-only">Computers to update</legend>
  {#each groups as { worker, files } (worker.workerId)}
    <Checkbox
      name={worker.workerId}
      label={worker.name}
      description={`${files.length} ${files.length === 1 ? "location" : "locations"}`}
      bind:checked={
        () => selected.includes(worker.workerId),
        (checked) =>
          (selected = checked ? [...selected, worker.workerId] : selected.filter((id) => id !== worker.workerId))
      }
    />
  {/each}
</fieldset>
{#if remaining}
  <p class="text-muted">
    {remaining} other {remaining === 1 ? "location needs" : "locations need"} separate review.
  </p>
{/if}
{#if selected.length}
  <p class="text-muted">
    Links to moved folders may stop working. When Canopy archives a link, its target stays in place.
  </p>
  <Disclosure>
    {#snippet summary()}Show folders and backups{/snippet}
    <div class="grid gap-3 pt-2">
      {#each groups.filter(({ worker }) => selected.includes(worker.workerId)) as { worker, files } (worker.workerId)}
        {#each files as file (file.targetId)}
          <div>
            <p class="font-medium">{worker.name} · {skillLocation(file)}</p>
            <p class="font-mono text-sm text-muted select-text">{file.path}</p>
            <p class="mt-1">Backup</p>
            <p class="font-mono text-sm text-muted select-text">{archiveLocation(file)}</p>
          </div>
        {/each}
      {/each}
    </div>
  </Disclosure>
{/if}
