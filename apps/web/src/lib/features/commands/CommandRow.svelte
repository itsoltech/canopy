<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import { formatAge } from "#lib/shared/format.ts";
  import { clock } from "#lib/shared/clock.svelte.ts";
  import HighlightedText from "#lib/shared/ui/HighlightedText.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import Kbd from "#lib/shared/ui/Kbd.svelte";
  import ProjectAvatar from "#lib/shared/ui/ProjectAvatar.svelte";
  import ProviderIcon from "#lib/features/models/ProviderIcon.svelte";
  import type { PaletteEntry } from "./palette.ts";

  /**
   * One option of the command palette's listbox. A command with `href` is a real link (`<a role="option">`:
   * the router, a new tab with a modifier, whatever handles links); others are plain options. Keys reach it
   * through the input (`aria-activedescendant`); the pointer highlights on move and chooses on click.
   * Thread rows have a second line (project · worker · provider) and their age on the right (T3 layout).
   */
  let {
    id,
    entry,
    active,
    onchoose,
    onpoint,
    class: className,
  }: { id: string; entry: PaletteEntry; active: boolean; onchoose: (event: MouseEvent) => void; onpoint: () => void; class?: ClassValue } = $props();

  const command = $derived(entry.command);
  const thread = $derived(command.thread);
  const rowClass =
    "group/row flex cursor-default items-center gap-3 rounded-lg px-3 py-2.5 text-base/6 text-zinc-800 select-none scroll-my-1 data-active:bg-zinc-950/5 data-active:text-zinc-950 aria-disabled:text-zinc-400 sm:py-2 sm:text-sm/5 dark:text-zinc-200 dark:data-active:bg-white/8 dark:data-active:text-white dark:aria-disabled:text-zinc-600";
</script>

{#snippet body()}
  {#if command.projectName}
    <ProjectAvatar name={command.projectName} />
  {:else if command.icon}
    <Icon name={command.icon} class="fill-zinc-500 group-aria-disabled/row:fill-zinc-300 group-data-active/row:fill-zinc-700 dark:fill-zinc-400 dark:group-aria-disabled/row:fill-zinc-700 dark:group-data-active/row:fill-zinc-200" />
  {:else if !thread}
    <span class="size-4 shrink-0" aria-hidden="true"></span>
  {/if}
  <span class="grid min-w-0 flex-1 gap-0.5">
    <span class="truncate">
      {#if entry.parent}<span class="text-zinc-500 dark:text-zinc-400">{entry.parent.title}<span aria-hidden="true">{" › "}</span><span class="sr-only">{": "}</span></span>{/if}<HighlightedText text={command.title} indices={entry.indices} />
    </span>
    {#if thread}
      <span class="flex min-w-0 items-center gap-1.5 text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">
        <ProjectAvatar name={thread.projectName} class="size-3.5 text-[0.5rem]/none" />
        <span class="min-w-0 truncate">{thread.projectName}<span class="text-zinc-400 dark:text-zinc-500">{" · "}</span>{thread.workerName}</span>
        {#if thread.provider}<ProviderIcon provider={thread.provider} class="size-3 opacity-70" />{/if}
      </span>
    {/if}
  </span>
  {#if command.checked}<Icon name="check" class="fill-brand-600 dark:fill-brand-400" label="Current" />{/if}
  {#if command.hotkey}<Kbd hotkey={command.hotkey} />{/if}
  {#if thread?.activityAt}<span class="shrink-0 self-start text-sm/6 text-zinc-500 tabular-nums sm:text-xs/5 dark:text-zinc-400">{formatAge(thread.activityAt, clock.now)}</span>{/if}
  {#if command.children}<Icon name="chevron-right" class="fill-zinc-400 dark:fill-zinc-500" />{/if}
{/snippet}

<!-- Options are not focusable: focus stays in the input (combobox pattern); a click chooses. -->
{#if command.href && !command.disabled}
  <!-- svelte-ignore a11y_interactive_supports_focus -->
  <a
    {id}
    href={command.href}
    role="option"
    tabindex="-1"
    aria-selected={active}
    data-active={active || undefined}
    class={[rowClass, className]}
    onpointerdown={(event) => event.preventDefault()}
    onpointermove={onpoint}
    onclick={onchoose}
  >
    {@render body()}
  </a>
{:else}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    {id}
    role="option"
    tabindex="-1"
    aria-selected={active}
    aria-disabled={command.disabled || undefined}
    data-active={active || undefined}
    class={[rowClass, className]}
    onpointerdown={(event) => event.preventDefault()}
    onpointermove={onpoint}
    onclick={onchoose}
  >
    {@render body()}
  </div>
{/if}
