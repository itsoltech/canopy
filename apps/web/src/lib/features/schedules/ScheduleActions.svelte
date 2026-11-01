<script lang="ts">
  import type { ui } from "@open-agents/contracts";
  import type { ClassValue } from "svelte/elements";
  import Button from "#lib/shared/ui/Button.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import { setScheduleStatus, type ScheduleStatusChange } from "./api.ts";
  import { isFinished } from "./schedules.ts";

  /**
   * Pause or resume a schedule, and cancel it (asks once more: a cancelled schedule does not come
   * back). `compact` shows icon buttons (thread panel). The live stream brings the new status;
   * `onchange` gets it right away too.
   */
  let {
    schedule,
    compact = false,
    onchange,
    class: className,
  }: { schedule: ui.Schedule; compact?: boolean; onchange?: ((schedule: ui.Schedule) => void) | undefined; class?: ClassValue } = $props();

  let busy = $state<ScheduleStatusChange>();
  let confirming = $state(false);
  let error = $state<string>();

  async function change(status: ScheduleStatusChange) {
    busy = status;
    error = undefined;
    try {
      const updated = await setScheduleStatus(schedule.id, status);
      if (updated) onchange?.(updated);
      confirming = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "The change failed";
    } finally {
      busy = undefined;
    }
  }
</script>

{#if !isFinished(schedule)}
  <div class={["flex flex-col items-end gap-1", className]}>
    <div class="flex items-center gap-1">
      {#if confirming}
        <Button size="sm" variant="danger" loading={busy === "cancelled"} onclick={() => change("cancelled")}>Cancel schedule</Button>
        <Button size="sm" variant="ghost" disabled={Boolean(busy)} onclick={() => (confirming = false)}>Keep</Button>
      {:else if compact}
        {#if schedule.status === "paused"}
          <IconButton icon="play" size="sm" label="Resume" disabled={Boolean(busy)} onclick={() => change("active")} />
        {:else}
          <IconButton icon="pause" size="sm" label="Pause" disabled={Boolean(busy)} onclick={() => change("paused")} />
        {/if}
        <IconButton icon="x-mark" size="sm" label="Cancel…" disabled={Boolean(busy)} onclick={() => (confirming = true)} />
      {:else}
        {#if schedule.status === "paused"}
          <Button size="sm" icon="play" loading={busy === "active"} disabled={Boolean(busy)} onclick={() => change("active")}>Resume</Button>
        {:else}
          <Button size="sm" icon="pause" loading={busy === "paused"} disabled={Boolean(busy)} onclick={() => change("paused")}>Pause</Button>
        {/if}
        <Button size="sm" variant="ghost" disabled={Boolean(busy)} onclick={() => (confirming = true)}>Cancel…</Button>
      {/if}
    </div>
    {#if error}<p class="text-sm/5 text-rose-700 dark:text-rose-400" role="alert">{error}</p>{/if}
  </div>
{/if}
