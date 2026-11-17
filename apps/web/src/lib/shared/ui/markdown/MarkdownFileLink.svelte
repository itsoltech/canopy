<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import DropdownMenu from "../DropdownMenu.svelte";
  import InlineLink from "../InlineLink.svelte";
  import MenuItem from "../MenuItem.svelte";
  import { anchorOnly, type PopoverTriggerProps } from "../Popover.svelte";
  import { longPress } from "../long-press.ts";
  import { tooltip } from "../tooltip.ts";
  import { copyText } from "#lib/shared/clipboard.ts";
  import { fileLocation } from "@canopy/domain/file-references";
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
    event.preventDefault();
    event.stopPropagation();
    open = true;
  }
</script>

{#snippet link(menu?: PopoverTriggerProps)}
  <InlineLink
    {...menu ? anchorOnly(menu) : {}}
    {title}
    class={className}
    aria-haspopup={menu ? "menu" : undefined}
    aria-expanded={menu ? open : undefined}
    aria-controls={menu?.["aria-controls"]}
    onactivate={() => files?.open(path)}
    oncontextmenu={menu ? context : undefined}
    onkeydown={menu
      ? (event) => {
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) context(event);
        }
      : undefined}
    {@attach label ? press : undefined}
    {@attach tooltip(`Open ${path}`)}>{@render children()}</InlineLink
  >
{/snippet}

{#if label}
  <DropdownMenu bind:open label="File actions" sheet>
    {#snippet trigger(menu)}{@render link(menu)}{/snippet}
    <MenuItem icon="arrow-top-right-on-square" onselect={() => files?.open(path)}>Open file</MenuItem>
    <MenuItem icon="folder-open" onselect={() => files?.reveal?.(path)}>{label}</MenuItem>
    <MenuItem icon="copy" onselect={() => void copyText(fileLocation(path).path)}>Copy path</MenuItem>
  </DropdownMenu>
{:else}
  {@render link()}
{/if}
