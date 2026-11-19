<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import InstructionText from "./InstructionText.svelte";
  import { textChanges } from "@canopy/domain/environment-review";

  let {
    local,
    expected,
    localLabel = "On this computer",
    expectedLabel = "In your library",
    class: className,
  }: { local: string; expected: string; localLabel?: string; expectedLabel?: string; class?: ClassValue } = $props();

  const changes = $derived(textChanges(local, expected));
</script>

<p class="text-base text-zinc-500 sm:text-sm dark:text-zinc-400">
  {#if changes.removed.length || changes.added.length}
    The block starting at line {changes.line} changes from {changes.removed.length}
    {changes.removed.length === 1 ? "line" : "lines"} to
    {changes.added.length}
    {changes.added.length === 1 ? "line" : "lines"}.
  {:else}
    No text changes.
  {/if}
</p>
<div class={["grid min-w-0 gap-3 @xl:grid-cols-2", className]}>
  {#each [{ label: localLabel, content: local }, { label: expectedLabel, content: expected }] as version (version.label)}
    <div class="grid min-w-0 gap-2">
      <h4 class="text-base font-medium text-balance sm:text-sm">{version.label}</h4>
      <InstructionText class="max-h-64" content={version.content} />
    </div>
  {/each}
</div>
