<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "../DropdownMenu.svelte";
  import InlineLink from "../InlineLink.svelte";
  import MenuItem from "../MenuItem.svelte";
  import { anchorOnly } from "../Popover.svelte";
  import { longPress } from "../long-press.ts";
  import { tooltip } from "../tooltip.ts";
  import { useFileLinks } from "./file-links.ts";

  let {
    path,
    title,
    class: className,
    children,
  }: { path: string; title?: string | undefined; class?: ClassValue; children: Snippet } = $props();

  const files = useFileLinks();
  let open = $state(false);
  const label = $derived(files?.revealLabel);
  const press = longPress(() => (open = true));

  function context(event: MouseEvent | KeyboardEvent) {
    if (event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    open = true;
  }
</script>

<DropdownMenu bind:open label="File actions" sheet>
  {#snippet trigger(menu)}
    <InlineLink
      {...anchorOnly(menu)}
      {title}
      class={className}
      aria-haspopup={menu["aria-haspopup"]}
      aria-expanded={open}
      aria-controls={open ? menu["aria-controls"] : undefined}
      onactivate={() => files?.open(path)}
      oncontextmenu={context}
      onkeydown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) context(event);
      }}
      {@attach press}
      {@attach open ? undefined : tooltip(`Open ${path}`)}>{@render children()}</InlineLink
    >
  {/snippet}
  <MenuItem icon="arrow-top-right-on-square" onselect={() => files?.open(path)}>Open file</MenuItem>
  {#if label}
    <MenuItem icon="folder-open" onselect={() => files?.reveal?.(path)}>{label}</MenuItem>
  {/if}
  <MenuItem icon="copy" onselect={() => files?.copyPath(path, "full")}>Copy full path</MenuItem>
  <MenuItem icon="copy" onselect={() => files?.copyPath(path, "relative")}>Copy relative path</MenuItem>
  {#if files?.canDownload}
    <MenuItem icon="arrow-down-tray" onselect={() => files.download(path)}>Download file</MenuItem>
  {/if}
</DropdownMenu>
