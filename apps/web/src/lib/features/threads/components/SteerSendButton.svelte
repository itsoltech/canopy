<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";
  import { keybindings } from "#lib/features/commands/keybindings.svelte.ts";
  import ComposerTextButton from "./ComposerTextButton.svelte";

  /**
   * Send button of the composer while a turn runs (Codex app style): the main part submits the form, which
   * does the `primary` way (Enter): steer the message into the running turn, or queue it for the next turn
   * when queueing is on; the chevron offers both ways with what each does (the other one is Mod+Enter).
   */
  let {
    sending = false,
    disabled = false,
    primary = "steer",
    onsteer,
    onqueue,
    class: className,
  }: {
    sending?: boolean;
    disabled?: boolean;
    primary?: "steer" | "queue";
    onsteer: () => void;
    onqueue: () => void;
    class?: ClassValue;
  } = $props();

  const steerFirst = $derived(primary === "steer");
  const primaryShortcut = $derived(keybindings.get("composer:send")[0]);
  const alternateShortcut = $derived(keybindings.get("composer:alternate")[0]);
</script>

<div class={["flex shrink-0 items-center rounded-full bg-action text-on-accent", className]}>
  <ComposerTextButton
    split
    {sending}
    {disabled}
    icon={steerFirst ? "arrow-up" : "queue-list"}
    label={steerFirst ? "Steer" : "Queue"}
    ariaLabel={steerFirst ? "Steer into the running turn" : "Queue for the next turn"}
    hint={steerFirst ? "Send now, into the turn the agent is working on" : "Wait and run as the next turn"}
    hotkey={primaryShortcut}
  />
  <span class="h-4 w-px bg-white/30" aria-hidden="true"></span>
  <DropdownMenu label="How to send" placement="top-end" class="w-72">
    {#snippet trigger(props)}
      <button
        type="button"
        class="relative flex h-9 items-center rounded-r-full pr-2.5 pl-1.5 focus-ring not-disabled:hover:bg-action-hover disabled:opacity-60 aria-expanded:bg-action-hover sm:h-8"
        aria-label="More ways to send"
        disabled={disabled || sending}
        {...props}
        {@attach tooltip("More ways to send")}
      >
        <Icon name="chevron-down" tone="inherit" class="size-3.5" />
        <TouchTarget />
      </button>
    {/snippet}
    <MenuItem
      icon="arrow-turn-down-right"
      shortcut={steerFirst ? primaryShortcut : alternateShortcut}
      onselect={onsteer}>Steer into this turn</MenuItem
    >
    <MenuItem icon="queue-list" shortcut={steerFirst ? alternateShortcut : primaryShortcut} onselect={onqueue}
      >Queue for the next turn</MenuItem
    >
  </DropdownMenu>
</div>
