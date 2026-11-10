<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { WorkspaceCopyManifest } from "@canopy/contracts";
  import { copyTree, copySelectable, copyRepositorySummary, copySkippedSummary } from "@canopy/domain/workspace-copy";
  import FileTreePicker from "#lib/shared/ui/FileTreePicker.svelte";

  let {
    manifest,
    selected,
    onchange,
    class: className,
  }: {
    manifest: WorkspaceCopyManifest;
    selected: ReadonlySet<string>;
    onchange: (next: Set<string>) => void;
    class?: ClassValue;
  } = $props();

  const ignored = $derived(manifest.entries.filter(copySelectable));
  const roots = $derived(copyTree(ignored));
</script>

<div class={["flex shrink-0 flex-col gap-3", className]}>
  <p class="break-words tabular-nums">{copyRepositorySummary(manifest)}</p>
  {#if manifest.skippedDirectories.length}
    <details class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
      <summary class="cursor-pointer break-words">{copySkippedSummary(manifest.skippedDirectories)}</summary>
      <ul role="list" class="max-h-28 overflow-auto pt-2">
        {#each manifest.skippedDirectories as path (path)}<li class="break-all">{path}</li>{/each}
      </ul>
    </details>
  {/if}
  {#if ignored.length}
    {#if ignored.filter((e) => !e.directory).length > 200}
      <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
        Many ignored files found. Check for dependencies or build output before selecting a directory.
      </p>
    {/if}
    <FileTreePicker {roots} {selected} {onchange} />
  {:else}
    <p class="text-zinc-500 dark:text-zinc-400">No ignored local files to choose</p>
  {/if}
</div>
