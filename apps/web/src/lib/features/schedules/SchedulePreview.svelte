<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { formatDateTime } from "#lib/shared/format.ts";
  import { previewSchedule } from "./api.ts";

  let { cron, timezone, class: className }: { cron: string; timezone: string; class?: ClassValue } = $props();
  let preview = $state<ui.PreviewScheduleResponse>();
  let error = $state<string>();
  let loading = $state(false);

  $effect(() => {
    const expression = cron;
    const zone = timezone;
    let active = true;
    preview = undefined;
    error = undefined;
    loading = true;

    const timer = setTimeout(() => {
      void previewSchedule(expression, zone)
        .then(
          (response) => {
            if (active) preview = response;
          },
          (cause: unknown) => {
            if (active) error = cause instanceof Error ? cause.message : "Could not preview the next runs";
          },
        )
        .finally(() => {
          if (active) loading = false;
        });
    }, 300);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  });
</script>

<div
  class={["grid gap-1 text-base/6 text-zinc-500 sm:text-sm/5 dark:text-zinc-400", className]}
  aria-live="polite"
  aria-busy={loading}
>
  {#if error}<p>{error}</p>
  {:else if preview}
    <p class="font-medium">Next runs</p>
    <ul role="list" class="grid gap-0.5 tabular-nums">
      {#each preview.nextRuns as run (run.seconds)}<li>{formatDateTime(run)}</li>{/each}
    </ul>
  {:else}<p>Checking next runs…</p>{/if}
</div>
