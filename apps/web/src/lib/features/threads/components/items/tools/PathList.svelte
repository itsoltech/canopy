<script lang="ts">
  import MoreButton from "#lib/shared/ui/MoreButton.svelte";
  import { plural } from "#lib/shared/humanize.ts";

  /**
   * Files a search or listing found, relative to `base` when they are inside it (full path in the
   * tooltip), with a count of matches each when known; the first `max` until "Show N more".
   */
  let { files, base = "", max = 12 }: { files: readonly { path: string; count?: number | undefined }[]; base?: string; max?: number } = $props();
  let all = $state(false);
  const shown = $derived(all ? files : files.slice(0, max));
  const prefix = $derived(base ? `${base.replace(/\/$/, "")}/` : "");
  const relative = (path: string) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path);
</script>

<div class="grid gap-1">
  <ul role="list" class="grid gap-0.5 font-mono text-[0.8125rem]/5 text-zinc-700 dark:text-zinc-300">
    {#each shown as file (file.path)}
      <li class="flex min-w-0 items-baseline justify-between gap-3">
        <span class="truncate" title={file.path}>{relative(file.path)}</span>
        {#if file.count !== undefined}<span class="shrink-0 font-sans text-xs/5 text-zinc-500 tabular-nums dark:text-zinc-400">{plural(file.count, "match", "matches")}</span>{/if}
      </li>
    {/each}
  </ul>
  {#if files.length > max}
    <div class="text-sm/5 text-zinc-500 sm:text-xs/5 dark:text-zinc-400">
      <MoreButton expanded={all} onclick={() => (all = !all)}>{all ? "Show fewer" : `Show ${files.length - max} more`}</MoreButton>
    </div>
  {/if}
</div>
