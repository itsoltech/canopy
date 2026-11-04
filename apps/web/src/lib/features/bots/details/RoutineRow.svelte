<script lang="ts">
  import { timestampDate, type Timestamp } from "@bufbuild/protobuf/wkt";
  import type { bots } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let {
    routine,
    busy = false,
    disabled = false,
    ontoggle,
    ondelete,
    class: className,
  }: {
    routine: bots.BotRoutine;
    busy?: boolean;
    disabled?: boolean;
    ontoggle: (enabled: boolean) => void;
    ondelete: () => void;
    class?: ClassValue;
  } = $props();

  const date = (at: Timestamp) =>
    timestampDate(at).toLocaleString("en", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: routine.timezone,
    });

  const next = $derived(
    routine.enabled && routine.nextRunAt ? `Next run ${date(routine.nextRunAt)} · ${routine.timezone}` : "Paused",
  );

  let checked = $state(false);

  // Restore the server's value after a failed request as well as after SSE confirms a change.
  $effect(() => {
    if (!busy) checked = routine.enabled;
  });
</script>

<li class={["grid gap-2 py-4 first:pt-0 last:pb-0", className]} aria-busy={busy || undefined}>
  <div class="flex items-start gap-3">
    <div class="grid min-w-0 flex-1 gap-1">
      <h4 class="font-medium text-pretty text-zinc-900 dark:text-zinc-100">{routine.title}</h4>
      <p class="text-pretty text-zinc-500 dark:text-zinc-400" {@attach tooltip(next)}>{routine.scheduleText}</p>
    </div>
    <div class="flex shrink-0 items-center gap-1 pt-0.5">
      <Switch
        bind:checked
        name={`routine-${routine.id}`}
        label={`${routine.enabled ? "Pause" : "Activate"} ${routine.title}`}
        disabled={busy || disabled}
        onchange={ontoggle}
      />
      <DropdownMenu label={`Actions for ${routine.title}`} placement="bottom-end">
        {#snippet trigger(props)}<IconButton
            icon="ellipsis-horizontal"
            size="sm"
            label={`Actions for ${routine.title}`}
            disabled={busy || disabled}
            {...props}
          />{/snippet}
        <MenuItem icon="trash" onselect={ondelete}>Delete routine…</MenuItem>
      </DropdownMenu>
    </div>
  </div>
  <div class="grid gap-0.5 text-zinc-500 dark:text-zinc-400">
    <p class="text-sm/5 tabular-nums sm:text-xs/5">{next}</p>
    {#if routine.lastRunAt}<p class="text-sm/5 tabular-nums sm:text-xs/5">
        Last run {date(routine.lastRunAt)} · {routine.lastOutcome.toLowerCase() || "completed"}
      </p>{/if}
  </div>
</li>
