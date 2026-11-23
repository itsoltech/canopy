<script lang="ts">
  import { formatBytes, formatSpan } from "#lib/shared/format.ts";
  import ProgressBar from "#lib/shared/ui/ProgressBar.svelte";
  import { fileDownloads } from "./file-downloads.svelte.ts";

  const recentDownloads = $derived([...fileDownloads].reverse());

  const labels = {
    starting: "Starting download…",
    progressing: "Downloading…",
    browser: "Track progress in your browser’s downloads.",
    requested: "Download requested",
    completed: "Download complete",
    cancelled: "Download canceled",
  };
</script>

{#if fileDownloads.size}
  <div class="flex max-h-[40dvh] flex-col gap-2 overflow-y-auto px-1 pt-1 pb-2">
    {#each recentDownloads as [key, download] (key)}
      <div
        class="t-toast grid min-w-0 gap-1 rounded-xl bg-white px-3 py-2.5 text-sm/5 text-zinc-950 shadow-lg ring-1 ring-zinc-950/10 motion-reduce:transition-none dark:bg-zinc-900 dark:text-zinc-100 dark:shadow-none dark:ring-white/10"
      >
        <p class="truncate font-medium" title={download.filename}>{download.filename}</p>
        <p role="status" class="wrap-anywhere text-zinc-600 dark:text-zinc-400">
          <span class="sr-only">{download.filename}. </span>
          {download.phase === "failed" ? download.message : labels[download.phase]}
        </p>
        {#if download.phase === "progressing"}
          {#if download.totalBytes > 0}
            <ProgressBar
              label={`Downloading ${download.filename}`}
              value={(download.receivedBytes / download.totalBytes) * 100}
              class="my-1"
            />
          {/if}
          <div class="flex flex-wrap justify-between gap-x-2 text-xs/4 text-zinc-600 tabular-nums dark:text-zinc-400">
            <span>
              {formatBytes(download.receivedBytes)}
              {#if download.totalBytes > 0}of {formatBytes(download.totalBytes)}{/if}
            </span>
            {#if download.remainingMs !== undefined}<span>About {formatSpan(download.remainingMs)} left</span>{/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
