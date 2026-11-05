<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import { isFullAuto, permissionLabel, permissionLook, permissionModes, type PermissionModeKey } from "../labels.ts";
  import PermissionModeTitle from "./PermissionModeTitle.svelte";

  /**
   * Composer pill for a thread's permission mode (new thread and side thread: the draft's pick; thread
   * composer: the thread's stored mode, saved when picked). Full auto never asks before running anything,
   * so the pill turns amber with a warning shield and says so in the menu.
   */
  let {
    value,
    onselect,
    class: className,
  }: {
    value: PermissionModeKey;
    onselect: (mode: PermissionModeKey) => void;
    class?: ClassValue;
  } = $props();

  const warn = $derived(isFullAuto(value));
  const look = $derived(permissionLook(value));
</script>

<DropdownMenu label="Permissions" placement="bottom-end" class="w-72">
  {#snippet trigger(props)}
    <PillButton
      {...props}
      class={[
        "shrink-0 pl-1.5",
        warn &&
          "text-amber-700 hover:text-amber-800 aria-expanded:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 dark:aria-expanded:text-amber-300",
        className,
      ]}
      aria-label="Permissions: {permissionLabel(value)}"
      title={warn
        ? "Full auto: runs commands and edits without asking (sandboxed to the workspace)"
        : `Permissions: ${permissionLabel(value)}`}
    >
      <Icon name={look.icon} class={["size-3.5", warn && look.iconClass]} />
      <span class="max-sm:sr-only @max-[34rem]/context:sr-only">{permissionLabel(value)}</span>
    </PillButton>
  {/snippet}
  {#each permissionModes as option (option.value)}
    <MenuCheckItem
      checked={option.value === value}
      description={option.description}
      onselect={() => onselect(option.value)}
    >
      <PermissionModeTitle mode={option.value} />
    </MenuCheckItem>
  {/each}
</DropdownMenu>
