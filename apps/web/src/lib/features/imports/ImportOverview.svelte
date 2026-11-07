<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { timestampDate } from "@bufbuild/protobuf/wkt";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import { agentCliName, counted, providerKey, size } from "./labels.ts";

  /** One line per agent CLI of the scanned worker: threads, size on disk, date range and directories. */
  let { overview }: { overview: readonly ui.ImportOverview[] } = $props();

  const day = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

  const range = (o: ui.ImportOverview) =>
    o.oldest && o.newest
      ? `${day.format(timestampDate(o.oldest))} – ${day.format(timestampDate(o.newest))}`
      : "No threads";
</script>

<ul role="list" class="divide-y divide-zinc-950/5 dark:divide-white/5">
  {#each overview as o, index (`${o.agentCli}:${o.rootPath}:${index}`)}
    <li class="flex items-start gap-3 px-4 py-3">
      <ProviderIcon provider={providerKey(o.agentCli)} class="mt-0.5 shrink-0" />
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-baseline gap-x-2 font-medium text-zinc-950 dark:text-white">
          {agentCliName(o.agentCli)}
          {#if o.cliVersion}<span class="text-sm font-normal text-zinc-500 sm:text-xs dark:text-zinc-400"
              >{o.cliVersion}</span
            >{/if}
        </p>
        <p class="truncate text-sm text-zinc-500 sm:text-xs dark:text-zinc-400" title={o.rootPath}>{o.rootPath}</p>
        {#if o.problem}
          <p class="text-sm text-amber-700 sm:text-xs dark:text-amber-400">{o.problem}</p>
        {:else}
          <p class="text-sm text-zinc-600 sm:text-xs dark:text-zinc-300">
            {counted(o.threads, "thread")} · {size(o.bytes)} · {counted(o.directories, "directory", "directories")} ·
            {range(o)}
          </p>
        {/if}
      </div>
    </li>
  {/each}
</ul>
