<script lang="ts">
  import type { ui } from "@canopy/contracts";
  import type { Snippet } from "svelte";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import { usePrCitationTarget } from "./citation-target.ts";
  import type { ClassValue } from "svelte/elements";

  let { quote, children, class: className }: { quote: ui.Quote; children?: Snippet; class?: ClassValue } = $props();
  const target = usePrCitationTarget();
</script>

<div class={["flex shrink-0 justify-end gap-1", className]}>
  {#if target?.enabled()}
    <span
      class="sm:opacity-0 sm:group-focus-within/pr:opacity-100 sm:group-hover/pr:opacity-100 [@media(hover:none)]:opacity-100"
    >
      <IconButton icon="paper-airplane" label="Send to agent" size="sm" onclick={() => target.target(quote)} />
    </span>
  {/if}
  {#if target?.enabled() || children}
    <DropdownMenu label="Item actions" sheet>
      {#snippet trigger(props)}<IconButton
          {...props}
          icon="ellipsis-horizontal"
          label="Item actions"
          size="sm"
        />{/snippet}
      {#if target?.enabled()}<MenuItem onselect={() => target.target(quote)}>Send to agent</MenuItem>{/if}
      {@render children?.()}
    </DropdownMenu>
  {/if}
</div>
