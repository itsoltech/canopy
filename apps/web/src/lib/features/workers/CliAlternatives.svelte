<script lang="ts">
  import type { CliAlternative } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";
  import { methodLabel } from "./cli-tools.svelte.ts";

  /** Other copies of an agent CLI on the computer that the worker doesn't use, collapsed by default. */
  let { alternatives, class: className }: { alternatives: readonly CliAlternative[]; class?: ClassValue } = $props();

  const label = $derived(
    `${alternatives.length} other ${alternatives.length === 1 ? "copy" : "copies"} on this computer`,
  );
</script>

{#if alternatives.length > 0}
  <Disclosure class={className} summaryClass="py-1 text-sm/5 text-zinc-500 dark:text-zinc-400">
    {#snippet summary()}{label}{/snippet}
    <ul role="list" class="mt-1 grid gap-2">
      {#each alternatives as copy (copy.path)}
        <li class="min-w-0">
          <p
            class="truncate font-mono text-sm/5 text-zinc-700 dark:text-zinc-300"
            title={copy.resolvedPath || copy.path}
          >
            {copy.path}
          </p>
          <p class="text-sm/5 text-pretty break-words text-zinc-500 dark:text-zinc-400">
            {[methodLabel(copy.method), copy.version, copy.problem].filter(Boolean).join(" · ")}
          </p>
        </li>
      {/each}
    </ul>
  </Disclosure>
{/if}
