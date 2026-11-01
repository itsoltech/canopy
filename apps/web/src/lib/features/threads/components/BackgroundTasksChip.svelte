<script lang="ts">
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import type { TimelineEntry } from "../thread-state.svelte.ts";

  /**
   * "N running in background" above the composer: jumps to the task in the timeline (one), or lists them
   * to pick one (several). `onjump` scrolls to the task's row.
   */
  let { tasks, onjump }: { tasks: readonly TimelineEntry[]; onjump: (task: TimelineEntry) => void } = $props();

  const label = $derived(`${tasks.length} running in background`);
  const name = (task: TimelineEntry) => {
    const content = task.item.content;
    return content.case === "backgroundTask" ? content.value.description || content.value.command.split("\n")[0] || content.value.taskId : task.id;
  };
  const chip =
    "relative flex items-center gap-1.5 rounded-full bg-white py-1 pr-2.5 pl-2 text-sm/5 text-zinc-700 shadow-xs ring-1 ring-zinc-950/10 focus-ring hover:bg-zinc-50 aria-expanded:bg-zinc-50 sm:text-xs/5 dark:bg-zinc-900 dark:text-zinc-300 dark:shadow-none dark:ring-white/10 dark:hover:bg-white/5 dark:aria-expanded:bg-white/5";
</script>

{#if tasks.length === 1 && tasks[0]}
  {@const task = tasks[0]}
  <button type="button" class={chip} onclick={() => onjump(task)} aria-label="{label}: {name(task)}. Show it">
    <StatusDot tone="sky" active />
    <span class="tabular-nums">{label}</span>
    <Icon name="arrow-up" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
    <TouchTarget />
  </button>
{:else if tasks.length > 1}
  <DropdownMenu label="Background tasks" placement="top-start" class="max-w-80">
    {#snippet trigger(props)}
      <button type="button" class={chip} {...props}>
        <StatusDot tone="sky" active />
        <span class="tabular-nums">{label}</span>
        <Icon name="chevron-up-down" class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
        <TouchTarget />
      </button>
    {/snippet}
    {#each tasks as task (task.id)}
      <MenuItem icon="bolt" onselect={() => onjump(task)}>{name(task)}</MenuItem>
    {/each}
  </DropdownMenu>
{/if}
