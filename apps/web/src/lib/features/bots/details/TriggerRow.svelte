<script lang="ts">
  import { formatDateTime } from "#lib/shared/format.ts";
  import type { bots } from "@canopy/contracts";
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import Switch from "#lib/shared/ui/Switch.svelte";

  /** An event trigger: what it listens to, whether it runs, and how often it ran this week. */
  let {
    item,
    busy = false,
    disabled = false,
    ontoggle,
    ondelete,
    class: className,
  }: {
    item: bots.BotTrigger;
    busy?: boolean;
    disabled?: boolean;
    ontoggle: (enabled: boolean) => void;
    ondelete: () => void;
    class?: ClassValue;
  } = $props();

  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

  const summary = $derived(
    item.autoPaused
      ? "Paused after running too often"
      : item.enabled
        ? `${plural(item.matchedWeek, "event")} · ${plural(item.runsWeek, "run")} in 7 days`
        : "Paused",
  );

  let checked = $state(false);

  // Restore the server's value after a failed request as well as after SSE confirms a change.
  $effect(() => {
    if (!busy) checked = item.enabled && !item.autoPaused;
  });
</script>

<li class={["grid gap-2 py-4 first:pt-0 last:pb-0", className]} aria-busy={busy || undefined}>
  <div class="flex items-start gap-3">
    <div class="grid min-w-0 flex-1 gap-1">
      <h4 class="font-medium text-pretty wrap-anywhere text-zinc-900 dark:text-zinc-100">{item.title}</h4>
      <p class="text-pretty wrap-anywhere text-zinc-500 dark:text-zinc-400">{item.description}</p>
    </div>
    <div class="flex shrink-0 items-center gap-1 pt-0.5">
      <Switch
        bind:checked
        name={`trigger-${item.id}`}
        label={`${checked ? "Pause" : "Activate"} ${item.title}`}
        disabled={busy || disabled}
        onchange={ontoggle}
      />
      <DropdownMenu label={`Actions for ${item.title}`} placement="bottom-end">
        {#snippet trigger(props)}<IconButton
            icon="ellipsis-horizontal"
            size="sm"
            label={`Actions for ${item.title}`}
            disabled={busy || disabled}
            {...props}
          />{/snippet}
        <MenuItem icon="trash" onselect={ondelete}>Delete trigger…</MenuItem>
      </DropdownMenu>
    </div>
  </div>
  <div class="grid gap-0.5 text-zinc-500 dark:text-zinc-400">
    <p class="text-sm/5 tabular-nums sm:text-xs/5">{summary}</p>
    {#if item.lastRunAt}<p class="text-sm/5 tabular-nums sm:text-xs/5">
        Last run {formatDateTime(item.lastRunAt)} · {item.lastOutcome.toLowerCase() || "completed"}
      </p>{/if}
  </div>
</li>
