<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { fileLookupMessage } from "@canopy/domain/thread-files";
  import Button from "#lib/shared/ui/Button.svelte";
  import { fileName } from "@canopy/domain/file-references";

  let { file, path, onselect }: { file: ui.ThreadFile; path: string; onselect: (path: string) => void } = $props();
</script>

<div class="grid min-w-0 gap-3" role="status">
  <p class="text-base sm:text-sm">{fileLookupMessage(fileName(path), file.resolution)}</p>
  {#if file.searchIncomplete}
    <p class="text-sm text-muted sm:text-xs">The search reached its limit. Open a full workspace-relative path.</p>
  {/if}
  {#if file.matches.length}
    <div class="grid max-h-64 gap-1 overflow-auto py-1">
      {#each file.matches as match (match)}
        <div class="min-w-0">
          <Button size="sm" variant="ghost" class="max-w-full" onclick={() => onselect(match)}>
            <span class="min-w-0 truncate font-mono" title={match}>{match}</span>
          </Button>
        </div>
      {/each}
    </div>
  {/if}
  {#if file.searchedPaths.length}
    <details class="min-w-0 text-sm text-muted sm:text-xs">
      <summary class="cursor-pointer">Show searched paths</summary>
      <ul role="list" class="grid gap-1 py-2 font-mono break-all select-text">
        {#each file.searchedPaths as searched, index (index)}<li>{searched}</li>{/each}
      </ul>
    </details>
  {/if}
</div>
