<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import MenuCheckItem from "#lib/shared/ui/MenuCheckItem.svelte";
  import PillButton from "#lib/shared/ui/PillButton.svelte";
  import { isFullAuto, permissionLabel, permissionLook, permissionModes, type PermissionModeKey } from "../labels.ts";
  import PermissionModeTitle from "./PermissionModeTitle.svelte";

  /**
   * Composer pill for a permission mode (new thread: the thread's mode; thread composer: the next
   * messages' mode). `inherited` marks the thread's default in the menu. Full auto never asks before
   * running anything, so the pill turns amber with a warning shield and says so in the menu.
   */
  let {
    value,
    inherited,
    onselect,
    class: className,
  }: { value: PermissionModeKey; inherited?: PermissionModeKey | undefined; onselect: (mode: PermissionModeKey) => void; class?: ClassValue } = $props();

  const warn = $derived(isFullAuto(value));
  const look = $derived(permissionLook(value));
</script>

<DropdownMenu label="Permissions" placement="bottom-end" class="w-72">
  {#snippet trigger(props)}
    <PillButton
      {...props}
      class={[
        "shrink-0 pl-1.5",
        warn && "text-amber-700 hover:text-amber-800 aria-expanded:text-amber-800 dark:text-amber-400 dark:hover:text-amber-300 dark:aria-expanded:text-amber-300",
        className,
      ]}
      aria-label="Permissions: {permissionLabel(value)}"
      title={warn ? "Full auto: runs commands and edits without asking (sandboxed to the workspace)" : undefined}
    >
      <Icon name={look.icon} class={["size-3.5", warn && look.iconClass]} />
      <span class="max-sm:sr-only">{permissionLabel(value)}</span>
    </PillButton>
  {/snippet}
  {#each permissionModes as option (option.value)}
    <MenuCheckItem checked={option.value === value} description={option.description} onselect={() => onselect(option.value)}>
      <PermissionModeTitle mode={option.value} note={option.value === inherited ? "· thread default" : undefined} />
    </MenuCheckItem>
  {/each}
</DropdownMenu>
