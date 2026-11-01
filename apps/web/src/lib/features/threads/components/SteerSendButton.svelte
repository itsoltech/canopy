<script lang="ts">
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  /**
   * Send button of the composer while a turn runs (Codex app style): the main part submits the form and
   * steers the message into the running turn (Enter); the chevron offers both ways, steer and queue for
   * the next turn (Mod+Enter), with what each does.
   */
  let { sending = false, disabled = false, onsteer, onqueue }: { sending?: boolean; disabled?: boolean; onsteer: () => void; onqueue: () => void } = $props();
  const half = "relative flex h-9 items-center focus-ring not-disabled:hover:bg-brand-500 disabled:opacity-60 sm:h-8";
</script>

<div class="flex shrink-0 items-center rounded-full bg-brand-600 text-white">
  <button
    type="submit"
    class={[half, "gap-1.5 rounded-l-full pr-2.5 pl-3 text-sm/5 font-medium sm:text-[0.8125rem]/5"]}
    aria-label="Steer into the running turn"
    {@attach tooltip("Send now, into the turn the agent is working on", { hotkey: "Enter" })}
    disabled={disabled || sending}
  >
    {#if sending}<Spinner class="size-3.5" />{:else}<Icon name="arrow-up" />{/if}
    Steer
    <TouchTarget />
  </button>
  <span class="h-4 w-px bg-white/30" aria-hidden="true"></span>
  <DropdownMenu label="How to send" placement="top-end" class="w-72">
    {#snippet trigger(props)}
      <button type="button" class={[half, "rounded-r-full pr-2.5 pl-1.5 aria-expanded:bg-brand-500"]} aria-label="More ways to send" disabled={disabled || sending} {...props} {@attach tooltip("More ways to send")}>
        <Icon name="chevron-down" class="size-3.5" />
        <TouchTarget />
      </button>
    {/snippet}
    <MenuItem icon="arrow-turn-down-right" shortcut="Enter" description="Joins the turn the agent is working on now." onselect={onsteer}>Steer into this turn</MenuItem>
    <MenuItem icon="queue-list" shortcut="Mod+Enter" description="Waits and runs as the next turn." onselect={onqueue}>Queue for the next turn</MenuItem>
  </DropdownMenu>
</div>
