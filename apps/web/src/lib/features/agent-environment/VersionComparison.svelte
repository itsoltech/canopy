<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import InstructionText from "./InstructionText.svelte";

  let { local, expected, class: className }: { local: string; expected: string; class?: ClassValue } = $props();
</script>

<div class={["grid min-w-0 gap-3 @xl:grid-cols-2", className]}>
  {#each [{ label: "On this computer", content: local }, { label: "In your library", content: expected }] as version (version.label)}
    <div class="grid min-w-0 gap-2">
      <h4 class="text-base font-medium text-balance sm:text-sm">{version.label}</h4>
      <InstructionText class="max-h-64" content={version.content} />
    </div>
  {/each}
</div>
