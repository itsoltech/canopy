<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import type { WorkspaceCopyManifest } from "@canopy/contracts";
  import { copyTree, copySelectable, copyRepositorySummary, copySkippedSummary } from "@canopy/domain/workspace-copy";
  import FileTreePicker from "#lib/shared/ui/FileTreePicker.svelte";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

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
  const repository = $derived(copyRepositorySummary(manifest));
</script>

<div class={["flex shrink-0 flex-col gap-3", className]}>
  <div class="min-w-0 space-y-1 tabular-nums">
    <p>{repository.overview}</p>
    <button
      type="button"
      class="w-full truncate rounded-sm text-left font-mono text-sm focus-ring select-text sm:text-xs"
      aria-label="Branch: {repository.branch}"
      {@attach tooltip(repository.branch, { touch: "tap" })}
    >
      {repository.branch}
    </button>
    <p class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">{repository.changes}</p>
  </div>
  {#if manifest.skippedDirectories.length}
    <Disclosure class="text-sm text-zinc-500 sm:text-xs dark:text-zinc-400">
      {#snippet summary()}{copySkippedSummary(manifest.skippedDirectories)}{/snippet}
      <ul role="list" class="max-h-28 scroll-stable overflow-auto pt-2">
        {#each manifest.skippedDirectories as path (path)}<li class="break-all">{path}</li>{/each}
      </ul>
    </Disclosure>
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
