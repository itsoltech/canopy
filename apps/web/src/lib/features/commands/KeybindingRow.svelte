<script lang="ts">
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import ResettableControl from "#lib/shared/ui/ResettableControl.svelte";
  import TruncatedText from "#lib/shared/ui/TruncatedText.svelte";
  import { pop, reorder } from "#lib/shared/ui/motion.ts";
  import KeyChip from "./KeyChip.svelte";
  import type { BindingDefinition } from "./binding-catalogue.ts";

  /**
   * One command of the keybindings list: its name and where it works on the left, its shortcuts as key chips on
   * the right. Wide panes keep it on one line; narrow ones put the shortcuts under the name. `first` and `last` round
   * the group's card, which the virtual list draws row by row.
   */
  let {
    command,
    bindings,
    changed,
    first,
    last,
    onedit,
    onremove,
    onreset,
  }: {
    command: BindingDefinition;
    bindings: readonly string[];
    changed: boolean;
    first: boolean;
    last: boolean;
    onedit: (index?: number) => void;
    onremove: (index: number) => void;
    onreset: () => void;
  } = $props();
</script>

<div
  class={[
    "flex flex-col gap-2 border-x border-zinc-950/10 bg-white px-(--settings-row-x) py-2 @xl:min-h-11 @xl:flex-row @xl:items-center @xl:gap-4 @xl:py-1.5 dark:border-white/10 dark:bg-zinc-950",
    first ? "rounded-t-2xl border-t" : "border-t border-t-zinc-950/5 dark:border-t-white/8",
    last && "rounded-b-2xl border-b",
  ]}
>
  <div class="flex min-w-0 flex-1 flex-col @xl:flex-row @xl:items-baseline @xl:gap-2">
    <TruncatedText class="font-medium text-zinc-950 @xl:max-w-full @xl:shrink-0 dark:text-white" text={command.title} />
    <TruncatedText class="text-sm/5 text-zinc-500 @xl:flex-1 dark:text-zinc-400" text={command.when} />
  </div>
  <ResettableControl {changed} class="@xl:justify-end">
    <div class="flex min-w-0 flex-wrap items-center gap-1.5">
      {#each bindings as binding, index (binding)}
        <span class="flex" in:pop out:pop animate:reorder>
          <KeyChip
            hotkey={binding}
            title={command.title}
            onedit={() => onedit(index)}
            onremove={() => onremove(index)}
          />
        </span>
      {:else}<span class="px-1 text-sm/5 text-zinc-500 dark:text-zinc-400">Unassigned</span>{/each}
      <IconButton
        size="sm"
        icon="plus"
        label={`Add shortcut for ${command.title}`}
        tooltipText="Add shortcut"
        disabled={bindings.length >= 5}
        onclick={() => onedit()}
      />
    </div>
    {#snippet reset()}<IconButton
        size="sm"
        icon="arrow-path"
        label={`Reset ${command.title} to default`}
        tooltipText="Reset to default"
        onclick={onreset}
      />{/snippet}
  </ResettableControl>
</div>
