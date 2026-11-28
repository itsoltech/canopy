<script lang="ts">
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import type { PopoverTriggerProps } from "#lib/shared/ui/Popover.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import StatusDot from "#lib/shared/ui/StatusDot.svelte";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import { backgroundName, type BackgroundEntry } from "../background-tasks.ts";
  import ComposerDisclosureChevron from "./ComposerDisclosureChevron.svelte";

  /**
   * "N running in background" above the composer: opens output (one), or lists tasks to pick (several).
   */
  let {
    tasks,
    onjump,
    class: className,
  }: { tasks: readonly BackgroundEntry[]; onjump: (task: BackgroundEntry) => void; class?: ClassValue } = $props();

  const label = $derived(`${tasks.length} running in background`);

  const chipClasses =
    "relative flex items-center gap-1.5 rounded-full bg-white py-1 pr-2.5 pl-2 text-sm/5 text-zinc-700 shadow-xs ring-1 ring-zinc-950/10 focus-ring hover:bg-zinc-50 aria-expanded:bg-zinc-50 sm:text-xs/5 dark:bg-zinc-900 dark:text-zinc-300 dark:shadow-none dark:ring-white/10 dark:hover:bg-white/5 dark:aria-expanded:bg-white/5";
</script>

{#snippet chip(icon: IconName, props: HTMLButtonAttributes | PopoverTriggerProps, expanded?: boolean)}
  <button type="button" class={[chipClasses, className]} {...props}>
    <StatusDot tone="sky" active />
    <span class="tabular-nums">{label}</span>
    {#if expanded !== undefined}
      <ComposerDisclosureChevron {expanded} />
    {:else}
      <Icon name={icon} class="size-3.5 fill-zinc-400 dark:fill-zinc-500" />
    {/if}
    <TouchTarget />
  </button>
{/snippet}

{#if tasks.length === 1 && tasks[0]}
  {@const task = tasks[0]}
  {@render chip("command-line", {
    onclick: () => onjump(task),
    "aria-label": `${label}: ${backgroundName(task.item.content.value)}. Open output`,
  })}
{:else if tasks.length > 1}
  <DropdownMenu label="Background tasks" placement="top-start" class="w-max max-w-[min(32rem,calc(100vw-1rem))]">
    {#snippet trigger(props)}{@render chip("chevron-down", props, props["aria-expanded"])}{/snippet}
    {#each tasks as task (task.id)}
      {@const content = task.item.content.value}
      {@const description = content.description.trim()}
      <MenuItem icon="bolt" wrapLabel onselect={() => onjump(task)}>
        {#if content.command && (!description || description === content.command.trim())}
          <code class="whitespace-pre-wrap">{content.command.trim()}</code>
        {:else}
          {description || content.taskId}
        {/if}
      </MenuItem>
    {/each}
  </DropdownMenu>
{/if}
