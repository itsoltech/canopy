<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import {
    isFullAccess,
    isPermissionModeAvailable,
    permissionDescription,
    permissionLabel,
    permissionLook,
    permissionModes,
    savedFullAutoDescription,
    type PermissionModeKey,
  } from "../labels.ts";
  import FullAccessConfirm from "./FullAccessConfirm.svelte";
  import PermissionModeTitle from "./PermissionModeTitle.svelte";

  /**
   * Composer pill for a thread's permission mode (new thread and side thread: the draft's pick; thread
   * composer: the next turn's mode, or the running turn for Claude with live permission updates).
   */
  let {
    value,
    onselect,
    fullAuto,
    fullAccessDescription,
    disabled = false,
    scope,
    nextTurnMode,
    confirmFullAccess = false,
    onconfirmfullaccess,
    explanation,
    class: className,
  }: {
    value: PermissionModeKey;
    onselect: (mode: PermissionModeKey) => void;
    /** false hides Full auto for a selected worker without a sandbox. */
    fullAuto?: boolean | undefined;
    fullAccessDescription?: string | undefined;
    disabled?: boolean;
    scope?: "message" | "next" | undefined;
    nextTurnMode?: PermissionModeKey | undefined;
    confirmFullAccess?: boolean;
    /** Let a shared composer own the confirmation across picker instances. */
    onconfirmfullaccess?: () => void;
    explanation?: string | undefined;
    class?: ClassValue;
  } = $props();

  const modes = $derived(permissionModes.filter((m) => isPermissionModeAvailable(m.value, fullAuto)));

  const look = $derived(permissionLook(value));
  const tone = $derived(look.tone);
  const selected = $derived(permissionModes.find((mode) => mode.value === value));
  const savedFullAuto = $derived(!isPermissionModeAvailable(value, fullAuto));

  const label = $derived(
    nextTurnMode
      ? `Current turn: ${permissionLabel(value)}. Next turn: ${permissionLabel(nextTurnMode)}`
      : scope === "message"
        ? `Permissions for this message: ${permissionLabel(value)}`
        : scope === "next"
          ? `Next turn permissions: ${permissionLabel(value)}`
          : `Permissions: ${permissionLabel(value)}`,
  );

  let confirming = $state<() => void>();

  function pick(mode: PermissionModeKey) {
    if (disabled) return;

    if (isFullAccess(mode) && (mode !== value || confirmFullAccess)) {
      if (onconfirmfullaccess) onconfirmfullaccess();
      else confirming = () => onselect(mode);

      return;
    }

    onselect(mode);
  }
</script>

<DropdownMenu label="Permissions" placement="bottom-end" class="w-72">
  {#snippet trigger(props)}
    <PillButton
      {...props}
      {disabled}
      class={[
        "shrink-0 pl-1.5",
        tone === "amber" &&
          "text-amber-700 hover:text-amber-800 aria-expanded:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 dark:aria-expanded:text-amber-300",
        tone === "rose" &&
          "text-rose-700 hover:text-rose-800 aria-expanded:text-rose-800 dark:text-rose-400 dark:hover:text-rose-300 dark:aria-expanded:text-rose-300",
        className,
      ]}
      aria-label={label}
      title={nextTurnMode
        ? label
        : savedFullAuto
          ? savedFullAutoDescription
          : selected && tone !== "neutral"
            ? permissionDescription(selected, fullAuto)
            : `Permissions: ${permissionLabel(value)}`}
    >
      <Icon name={look.icon} class={["size-3.5", tone !== "neutral" && look.iconClass]} />
      {#if nextTurnMode}
        <span>Now: {permissionLabel(value)} · Next: {permissionLabel(nextTurnMode)}</span>
      {:else if scope === "message"}
        <span>This message: {permissionLabel(value)}</span>
      {:else if scope === "next"}
        <span>Next turn: {permissionLabel(value)}</span>
      {:else}
        <span class="max-sm:sr-only @max-[34rem]/context:sr-only">{permissionLabel(value)}</span>
      {/if}
    </PillButton>
  {/snippet}
  {#if savedFullAuto}<p class="px-2 py-1.5 text-sm/5 text-muted sm:text-xs/4">{savedFullAutoDescription}</p>{/if}
  {#if explanation}<p class="px-2 py-1.5 text-sm/5 text-muted sm:text-xs/4">{explanation}</p>{/if}
  {#each modes as option (option.value)}
    <MenuCheckItem
      {disabled}
      checked={option.value === value}
      description={permissionDescription(option, fullAuto)}
      onselect={() => pick(option.value)}
    >
      <PermissionModeTitle mode={option.value} {fullAuto} />
    </MenuCheckItem>
  {/each}
</DropdownMenu>
{#if !onconfirmfullaccess}<FullAccessConfirm bind:pending={confirming} description={fullAccessDescription} />{/if}
