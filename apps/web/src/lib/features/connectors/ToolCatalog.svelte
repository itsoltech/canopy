<script lang="ts">
  import type { ConnectorTool } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Disclosure from "#lib/shared/ui/Disclosure.svelte";

  let { tools, class: className }: { tools: readonly ConnectorTool[]; class?: ClassValue } = $props();
</script>

<div
  role="status"
  class={["grid gap-3 rounded-lg bg-zinc-950/3 p-3 text-base/6 sm:text-sm/6 dark:bg-white/4", className]}
>
  <p class="font-medium">Connection verified · {tools.length} tools</p>
  <ul role="list" class="grid gap-2">
    {#each tools as tool (tool.name)}
      <li class="min-w-0">
        <Disclosure summaryClass="py-1"
          >{#snippet summary()}<p class="wrap-anywhere">
              {tool.remoteName}{tool.readOnly ? " · Read only" : " · Requires approval"}
            </p>{/snippet}
          <p class="pl-6 wrap-anywhere text-zinc-500 dark:text-zinc-400">{tool.description}</p></Disclosure
        >
      </li>
    {/each}
  </ul>
</div>
