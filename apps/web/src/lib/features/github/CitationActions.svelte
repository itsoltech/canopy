<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { Snippet } from "svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import MenuGroup from "#lib/shared/ui/MenuGroup.svelte";
  import MenuSeparator from "#lib/shared/ui/MenuSeparator.svelte";
  import { safeHref } from "@canopy/domain/markdown";
  import { usePrCitationTarget } from "./citation-target.ts";
  import type { ClassValue } from "svelte/elements";

  let {
    quote,
    children,
    url = "",
    label = "Item actions",
    class: className,
  }: { quote?: ui.Quote; children?: Snippet; url?: string; label?: string; class?: ClassValue } = $props();

  const target = usePrCitationTarget();
  const canSend = $derived(!!quote && !!target?.enabled());
  const href = $derived(safeHref(url));
</script>

<div class={["flex shrink-0 justify-end gap-1", className]}>
  {#if canSend || children || href}
    <DropdownMenu {label} placement="bottom-end" sheet>
      {#snippet trigger(props)}<IconButton {...props} icon="ellipsis-horizontal" {label} size="sm" />{/snippet}
      {#if canSend}
        <MenuGroup label="Canopy">
          <MenuItem icon="paper-airplane" onselect={() => quote && target?.target(quote)}>Send to agent</MenuItem>
        </MenuGroup>
      {/if}
      {#if children || href}
        {#if canSend}<MenuSeparator />{/if}
        <MenuGroup label="GitHub">
          {@render children?.()}
          {#if href}<MenuItem icon="arrow-top-right-on-square" {href}>Open on GitHub</MenuItem>{/if}
        </MenuGroup>
      {/if}
    </DropdownMenu>
  {/if}
</div>
