<script lang="ts">
  import { botReactionOptions } from "@canopy/domain/bot-reactions";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import Popover from "#lib/shared/ui/Popover.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let {
    reactions,
    onreact,
    triggerId,
    open = $bindable(false),
  }: {
    reactions: readonly string[];
    onreact: (emoji: string, active: boolean) => void;
    triggerId: string;
    open?: boolean;
  } = $props();
</script>

<Popover bind:open label="Reactions" placement="top-end" class="w-max max-w-[calc(100vw-1rem)]">
  {#snippet trigger(props)}
    <IconButton id={triggerId} icon="face-smile" label="React to message" size="sm" {...props} />
  {/snippet}
  <div class="flex flex-wrap gap-0.5 p-1">
    {#each botReactionOptions as { emoji, label } (emoji)}
      {@const active = reactions.includes(emoji)}
      <button
        type="button"
        aria-pressed={active}
        aria-label={label}
        class="relative grid size-8 place-items-center rounded-lg text-lg focus-ring hover:bg-zinc-100 aria-pressed:bg-zinc-100 dark:hover:bg-zinc-800 dark:aria-pressed:bg-zinc-800 pointer-coarse:size-11"
        {@attach tooltip(label)}
        onclick={() => {
          open = false;
          onreact(emoji, !active);
        }}
      >
        <span class="font-emoji" aria-hidden="true">{emoji}</span>
        {#if active}<Icon name="check" size="xs" class="absolute right-0 bottom-0 rounded-full bg-surface" />{/if}
      </button>
    {/each}
  </div>
</Popover>
