<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { threadSyncFailure, threadSyncRecords } from "@canopy/domain/thread-sync-display";

  let { entry, class: className }: { entry: ui.ThreadSyncDiagnostic; class?: ClassValue } = $props();
</script>

<div class={["grid min-w-0 gap-1 py-2", className]}>
  <a
    class="min-w-0 rounded break-words underline decoration-zinc-300 underline-offset-4 focus-ring dark:decoration-zinc-600"
    href="/threads/{entry.threadId}">{entry.threadTitle || "Untitled thread"}</a
  >
  <p class="text-sm text-zinc-500 tabular-nums dark:text-zinc-400">
    {#if entry.reason}Sync paused · {threadSyncFailure(entry.reason)}{:else}Catching up{/if}
    {#if entry.remaining}
      · {threadSyncRecords(entry.remaining)}{/if}
  </p>
  {#if entry.reason}
    <p class="text-sm text-zinc-500 dark:text-zinc-400">
      {entry.retryable ? "Retrying automatically." : "Check the linked computer."}
    </p>
  {/if}
</div>
