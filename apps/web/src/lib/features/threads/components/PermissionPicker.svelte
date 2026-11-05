<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import { isFullAccess, permissionLabel, permissionLook, permissionModes, type PermissionModeKey } from "../labels.ts";
  import FullAccessConfirm from "./FullAccessConfirm.svelte";
  import PermissionModeTitle from "./PermissionModeTitle.svelte";

  /**
   * Composer pill for a thread's permission mode (new thread and side thread: the draft's pick; thread
   * composer: the thread's stored mode, saved when picked). Full auto never asks before running anything,
   * so the pill turns amber with a warning shield and says so in the menu. Full access has no sandbox either:
   * rose with a crossed-out shield, and picking it asks for a confirmation first.
   */
  let {
    value,
    onselect,
    fullAccess = true,
    class: className,
  }: {
    value: PermissionModeKey;
    onselect: (mode: PermissionModeKey) => void;
    /** false: Full access is not offered (schedules: nobody watches those runs start). */
    fullAccess?: boolean;
    class?: ClassValue;
  } = $props();

  const modes = $derived(permissionModes.filter((m) => fullAccess || !isFullAccess(m.value)));

  const look = $derived(permissionLook(value));
  const tone = $derived(look.tone);
  let confirming = $state<() => void>();

  function pick(mode: PermissionModeKey) {
    if (isFullAccess(mode) && mode !== value) confirming = () => onselect(mode);
    else onselect(mode);
  }
</script>

<DropdownMenu label="Permissions" placement="bottom-end" class="w-72">
  {#snippet trigger(props)}
    <PillButton
      {...props}
      class={[
        "shrink-0 pl-1.5",
        tone === "amber" &&
          "text-amber-700 hover:text-amber-800 aria-expanded:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 dark:aria-expanded:text-amber-300",
        tone === "rose" &&
          "text-rose-700 hover:text-rose-800 aria-expanded:text-rose-800 dark:text-rose-400 dark:hover:text-rose-300 dark:aria-expanded:text-rose-300",
        className,
      ]}
      aria-label="Permissions: {permissionLabel(value)}"
      title={tone === "rose"
        ? "Full access: runs commands and edits without asking, with no sandbox"
        : tone === "amber"
          ? "Full auto: runs commands and edits without asking (sandboxed to the workspace)"
          : `Permissions: ${permissionLabel(value)}`}
    >
      <Icon name={look.icon} class={["size-3.5", tone !== "neutral" && look.iconClass]} />
      <span class="max-sm:sr-only @max-[34rem]/context:sr-only">{permissionLabel(value)}</span>
    </PillButton>
  {/snippet}
  {#each modes as option (option.value)}
    <MenuCheckItem
      checked={option.value === value}
      description={option.description}
      onselect={() => pick(option.value)}
    >
      <PermissionModeTitle mode={option.value} />
    </MenuCheckItem>
  {/each}
</DropdownMenu>
<FullAccessConfirm bind:pending={confirming} />
