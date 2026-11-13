<script lang="ts">
  import { workspaceModules, type WorkspaceModuleTarget } from "@canopy/domain/workspace-modules";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";

  let { sidebar = false, onselect }: { sidebar?: boolean; onselect: (target: WorkspaceModuleTarget) => void } =
    $props();
</script>

<DropdownMenu label={sidebar ? "Open sidebar module" : "Open module"} placement="bottom-end" sheet>
  {#snippet trigger(props)}<IconButton
      icon="plus"
      label={sidebar ? "Open sidebar module" : "Open module"}
      {...props}
    />{/snippet}
  {#each workspaceModules as module (module.id)}
    <MenuItem icon={module.icon} onselect={() => onselect({ module: module.id, resource: "" })}>{module.label}</MenuItem
    >
  {/each}
</DropdownMenu>
