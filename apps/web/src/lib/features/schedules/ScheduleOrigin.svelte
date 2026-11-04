<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";

  let {
    thread,
    compact = false,
    class: className,
  }: { thread: ui.Thread; compact?: boolean; class?: ClassValue } = $props();

  const label = $derived(`Started by schedule ${thread.scheduleName || "scheduled task"} · run ${thread.scheduleRun}`);
</script>

{#if thread.scheduleId}
  {#if compact}
    <span class={["flex shrink-0", className]} title={label}
      ><Icon name="clock" {label} class="size-4 shrink-0 fill-zinc-400 dark:fill-zinc-500" /></span
    >
  {:else}
    <p class={["flex min-w-0 items-start gap-2 text-base/6 text-zinc-500 sm:text-sm/6 dark:text-zinc-400", className]}>
      <Icon name="clock" class="size-4 h-lh shrink-0 fill-zinc-400 dark:fill-zinc-500" />
      <a
        href="/settings/schedules"
        class="min-w-0 break-words underline decoration-zinc-950/15 underline-offset-2 focus-ring hover:text-zinc-950 dark:decoration-white/20 dark:hover:text-white"
        >{label}</a
      >
    </p>
  {/if}
{/if}
