<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import { snoozeDeadline, snoozePresets } from "@canopy/domain/thread-snooze";
  import MenuGroup from "#lib/shared/ui/MenuGroup.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import MenuSub from "#lib/shared/ui/MenuSub.svelte";
  import { useThreadActions } from "../thread-actions.svelte.ts";
  import { threadCount } from "../thread-bulk-actions.svelte.ts";

  /**
   * The row menu for several selected threads: the actions that make sense for a group. Each item names how
   * many threads it changes; `done` runs once an action is chosen (the selection clears).
   */
  let { threads, done }: { threads: readonly ui.Thread[]; done: () => void } = $props();

  const bulk = useThreadActions().bulk;
  const editable = $derived(bulk.editable(threads));
  const active = $derived(editable.filter((thread) => thread.status !== "archived"));
  const archived = $derived(editable.filter((thread) => thread.status === "archived"));
  const snoozable = $derived(active.filter((thread) => !thread.spawnedByAgent));
  const snoozed = $derived(snoozable.filter((thread) => thread.snoozed));
  const anyUnread = $derived(editable.some((thread) => thread.markedUnread || thread.unseenResult));
  const allPinned = $derived(editable.length > 0 && editable.every((thread) => bulk.pinned(thread)));

  // The action reads its threads before the selection clears.
  function run(action: () => Promise<void>) {
    const pending = action();
    done();
    void pending;
  }
</script>

<MenuGroup label="{threadCount(threads.length)} selected">
  <MenuItem icon="star" disabled={!editable.length} onselect={() => run(() => bulk.pin(editable))}
    >{allPinned ? "Unpin threads" : "Pin threads"}</MenuItem
  >
  <MenuItem icon="chat-bubble-left" disabled={!editable.length} onselect={() => run(() => bulk.markRead(editable))}
    >{anyUnread ? "Mark as read" : "Mark as unread"}</MenuItem
  >
  <MenuSub
    label="Snooze options"
    icon="moon"
    disabled={!snoozable.length}
    primary={{
      label: snoozable.length ? `Snooze ${threadCount(snoozable.length)} for 1 hour` : "Snooze for 1 hour",
      onselect: () => run(() => bulk.snooze(snoozable, snoozeDeadline(1))),
    }}
  >
    {#each snoozePresets as preset (preset.value)}
      <MenuItem onselect={() => run(() => bulk.snooze(snoozable, snoozeDeadline(preset.value)))}
        >{preset.label}</MenuItem
      >
    {/each}
    <MenuItem onselect={() => bulk.openSnooze(snoozable, done)}>Choose date and time</MenuItem>
  </MenuSub>
  {#if snoozed.length}<MenuItem icon="sun" onselect={() => run(() => bulk.wake(snoozed))}
      >Wake {threadCount(snoozed.length)}</MenuItem
    >{/if}
</MenuGroup>
<MenuSeparator />
{#if active.length}<MenuItem icon="archive-box" onselect={() => bulk.request("archive", active, done)}
    >Archive {threadCount(active.length)}</MenuItem
  >{/if}
{#if archived.length}<MenuItem icon="archive-box" onselect={() => run(() => bulk.unarchive(archived))}
    >Unarchive {threadCount(archived.length)}</MenuItem
  >{/if}
<MenuItem icon="trash" danger disabled={!editable.length} onselect={() => bulk.request("delete", editable, done)}
  >Delete {threadCount(editable.length)}…</MenuItem
>
