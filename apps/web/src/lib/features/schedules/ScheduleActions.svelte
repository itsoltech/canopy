<script lang="ts">
  import { clone } from "@bufbuild/protobuf";
  import { ui } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import { useOverview } from "#lib/features/overview/overview-state.svelte.ts";
  import Alert from "#lib/shared/ui/Alert.svelte";
  import Button from "#lib/shared/ui/Button.svelte";
  import Dialog from "#lib/shared/ui/Dialog.svelte";
  import DialogActions from "#lib/shared/ui/DialogActions.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import { setScheduleStatus, type ScheduleStatusChange } from "./api.ts";
  import { scheduleActions } from "./schedules.ts";
  import ScheduleDialog from "./ScheduleDialog.svelte";

  /** Shared by all lists. The editor keeps its opening version while live updates arrive. */
  let {
    schedule,
    compact = false,
    onchange,
    class: className,
  }: {
    schedule: ui.Schedule;
    compact?: boolean;
    onchange?: ((schedule: ui.Schedule) => void) | undefined;
    class?: ClassValue;
  } = $props();

  const overview = useOverview();
  const actions = $derived(scheduleActions(schedule.status));
  let busy = $state<ScheduleStatusChange>();
  let confirming = $state(false);
  let editing = $state(false);
  let snapshot = $state<ui.Schedule>();
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

<div class={["shrink-0", className]}>
  {#if actions.length}
    <DropdownMenu label="Scheduled task actions" placement="bottom-end">
      {#snippet trigger(props)}
        <IconButton
          icon="ellipsis-horizontal"
          label="Scheduled task actions"
          size={compact ? "sm" : "md"}
          loading={Boolean(busy)}
          {...props}
        />
      {/snippet}
      <MenuItem
        icon="pencil-square"
        onselect={() => {
          snapshot = clone(ui.ScheduleSchema, schedule);
          editing = true;
        }}>Edit…</MenuItem
      >
      {#if actions.includes("resume")}
        <MenuItem icon="play" onselect={() => change("active")}>Resume</MenuItem>
      {:else}
        <MenuItem icon="pause" onselect={() => change("paused")}>Pause</MenuItem>
      {/if}
      <MenuSeparator />
      <MenuItem
        icon="x-mark"
        danger
        onselect={() => {
          error = undefined;
          confirming = true;
        }}>Cancel schedule…</MenuItem
      >
    </DropdownMenu>
  {/if}
  {#if error && !confirming}<p class="text-base/6 text-rose-700 sm:text-sm/5 dark:text-rose-400" role="alert">
      {error}
    </p>{/if}
</div>

<ScheduleDialog bind:open={editing} schedule={snapshot} threads={[...overview.threads.values()]} oncreated={onchange} />
<Dialog
  bind:open={confirming}
  title="Cancel scheduled task?"
  description="This task will not run again. Its run history stays available. Work that has already started will continue."
>
  <div class="grid gap-5">
    <p class="text-base/6 break-words text-zinc-700 sm:text-sm/6 dark:text-zinc-300">
      {schedule.name || schedule.prompt}
    </p>
    {#if error}<Alert tone="error">{error}</Alert>{/if}
    <DialogActions>
      <Button disabled={Boolean(busy)} onclick={() => (confirming = false)} data-autofocus>Keep task</Button>
      <Button variant="danger" loading={busy === "cancelled"} onclick={() => change("cancelled")}
        >Cancel schedule</Button
      >
    </DialogActions>
  </div>
</Dialog>
