<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
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
  import { defaultSandboxProfile, nativeWindowsSandboxMode } from "../sandbox-profiles.ts";
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
    fixed = false,
    scope,
    nextTurnMode,
    confirmFullAccess = false,
    onconfirmfullaccess,
    explanation,
    sandboxProfileName,
    sandboxProfiles,
    onmanage,
    class: className,
  }: {
    value: PermissionModeKey;
    onselect: (mode: PermissionModeKey) => void;
    /** false hides Full auto for a selected worker without a sandbox. */
    fullAuto?: boolean | undefined;
    fullAccessDescription?: string | undefined;
    disabled?: boolean;
    /** A bound sandbox profile is managed in the thread permissions dialog. */
    fixed?: boolean;
    scope?: "message" | "next" | undefined;
    nextTurnMode?: PermissionModeKey | undefined;
    confirmFullAccess?: boolean;
    /** Let a shared composer own the confirmation across picker instances. */
    onconfirmfullaccess?: () => void;
    explanation?: string | undefined;
    sandboxProfileName?: string | undefined;
    sandboxProfiles?: Snippet;
    onmanage?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();

  const modes = $derived(permissionModes.filter((m) => isPermissionModeAvailable(m.value, fullAuto)));

  const look = $derived(permissionLook(value));
  const tone = $derived(look.tone);
  const selected = $derived(permissionModes.find((mode) => mode.value === value));
  const savedFullAuto = $derived(!isPermissionModeAvailable(value, fullAuto));
  const sandboxSelected = $derived(value === "FULL_AUTO" || nextTurnMode === "FULL_AUTO");

  const modeName = (mode: PermissionModeKey) =>
    mode === "FULL_AUTO" ? `Sandbox - ${sandboxProfileName ?? defaultSandboxProfile.label}` : permissionLabel(mode);

  const sandboxModeNote = $derived(
    fullAuto === false && !sandboxProfileName
      ? savedFullAuto
        ? savedFullAutoDescription
        : nativeWindowsSandboxMode
      : undefined,
  );

  const selection = $derived(
    nextTurnMode
      ? `Now: ${modeName(value)} · Next: ${modeName(nextTurnMode)}`
      : scope === "message"
        ? `This message: ${modeName(value)}`
        : scope === "next"
          ? `Next turn: ${modeName(value)}`
          : modeName(value),
  );

  const label = $derived(`Permissions: ${selection}`);
  let confirming = $state<() => void>();
  let open = $state(false);
  let details = $state(false);

  $effect(() => {
    if (!open) details = false;
  });

  function pick(mode: PermissionModeKey) {
    if (disabled || fixed) return;

    if (isFullAccess(mode) && (mode !== value || confirmFullAccess)) {
      if (onconfirmfullaccess) onconfirmfullaccess();
      else confirming = () => onselect(mode);

      return;
    }

    onselect(mode);
  }
</script>

<DropdownMenu bind:open label="Permissions" placement="top-end" class="w-72 max-w-[calc(100vw-1rem)]">
  {#snippet trigger(props)}
    <PillButton
      {...props}
      {disabled}
      class={[
        "max-w-full pl-1.5",
        tone === "amber" &&
          "text-amber-700 hover:text-amber-800 aria-expanded:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 dark:aria-expanded:text-amber-300",
        tone === "rose" &&
          "text-rose-700 hover:text-rose-800 aria-expanded:text-rose-800 dark:text-rose-400 dark:hover:text-rose-300 dark:aria-expanded:text-rose-300",
        className,
      ]}
      aria-label={label}
      chevronClass={sandboxSelected ? "shrink-0 @max-[24rem]/context:hidden" : "shrink-0"}
      title={nextTurnMode || sandboxSelected
        ? label
        : savedFullAuto
          ? savedFullAutoDescription
          : selected && tone !== "neutral"
            ? permissionDescription(selected, fullAuto)
            : `Permissions: ${permissionLabel(value)}`}
    >
      <Icon name={look.icon} class={["size-3.5 shrink-0", tone !== "neutral" && look.iconClass]} />
      {#if sandboxSelected || nextTurnMode || scope}
        <span class="min-w-0 truncate">{selection}</span>
      {:else}
        <span class="max-sm:sr-only @max-[34rem]/context:sr-only">{permissionLabel(value)}</span>
      {/if}
    </PillButton>
  {/snippet}
  {#if sandboxModeNote}<p class="px-2 py-1.5 text-sm/5 text-muted sm:text-xs/4">{sandboxModeNote}</p>{/if}
  {#if explanation}<p class="px-2 py-1.5 text-sm/5 wrap-anywhere text-muted sm:text-xs/4">{explanation}</p>{/if}
  {#if fixed && onmanage}
    <MenuItem onselect={onmanage}>Open thread permissions</MenuItem>
  {:else if !fixed}
    {#each modes as option (option.value)}
      <MenuCheckItem
        {disabled}
        checked={option.value === value}
        keepOpen={Boolean(sandboxProfiles && option.value === "FULL_AUTO")}
        onselect={() => pick(option.value)}
      >
        <PermissionModeTitle mode={option.value} {fullAuto} />
        <span class="sr-only">. {permissionDescription(option, fullAuto)}</span>
      </MenuCheckItem>
    {/each}
  {/if}
  {#if value === "FULL_AUTO"}{@render sandboxProfiles?.()}{/if}
  {#if !fixed}
    <MenuItem keepOpen onselect={() => (details = !details)}
      >{details ? "Hide permission details" : "Show permission details"}</MenuItem
    >
    {#if details}
      <dl class="grid gap-2 px-2 py-1.5 text-sm/5 text-muted sm:text-xs/4">
        {#each modes as option (option.value)}
          <div>
            <dt class="font-medium text-ink">{option.label}</dt>
            <dd>{permissionDescription(option, fullAuto)}</dd>
          </div>
        {/each}
      </dl>
    {/if}
  {/if}
</DropdownMenu>
{#if !onconfirmfullaccess}<FullAccessConfirm bind:pending={confirming} description={fullAccessDescription} />{/if}
