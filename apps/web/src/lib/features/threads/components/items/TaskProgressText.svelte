<script lang="ts">
  import type { TaskProgress } from "@canopy/contracts";
  import { formatCount, formatDuration } from "#lib/shared/format.ts";

  /** "12 tools · 8.1K tokens · 1m 4s" for subagents and background tasks. */
  let { progress }: { progress: TaskProgress | undefined } = $props();
  const parts = $derived(
    progress
      ? [
          progress.toolUses > 0 && `${progress.toolUses} ${progress.toolUses === 1 ? "tool" : "tools"}`,
          progress.totalTokens > 0n && `${formatCount(progress.totalTokens)} tokens`,
          progress.durationMs > 0n && formatDuration(progress.durationMs),
        ].filter(Boolean)
      : [],
  );
</script>

{#if parts.length > 0}<span class="max-sm:hidden">{parts.join(" · ")}</span>{/if}
