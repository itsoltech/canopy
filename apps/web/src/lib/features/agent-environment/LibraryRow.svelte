<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import IconButton from "#lib/shared/ui/IconButton.svelte";
  import DropdownMenu from "#lib/shared/ui/DropdownMenu.svelte";
  import MenuItem from "#lib/shared/ui/MenuItem.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";

  let {
    id,
    name,
    meta,
    status,
    targets,
    actions,
    onedit,
    onremove,
    disabled = false,
    editLabel = "Edit",
    removeLabel = "Delete",
    class: className,
  }: {
    id?: string;
    name: string;
    meta: string;
    status: Snippet;
    targets?: Snippet;
    actions?: Snippet;
    onedit: () => void;
    onremove?: () => void;
    disabled?: boolean;
    editLabel?: string;
    removeLabel?: string;
    class?: ClassValue;
  } = $props();
</script>

<div
  id={id ? `environment-item-${id}` : undefined}
  data-library-row
  class={["grid min-w-0 gap-0.5 rounded-lg py-2", className]}
>
  <div class="flex min-w-0 items-center gap-2">
    <button
      type="button"
      data-item-focus
      {disabled}
      class="min-w-0 flex-1 truncate rounded-md text-left text-sm/6 font-medium focus-ring hover:text-accent disabled:opacity-50"
      onclick={onedit}
      {@attach tooltip(name)}>{name}</button
    >
    <div class="min-w-0 shrink-0">{@render status()}</div>
    <div class="flex shrink-0 items-center gap-0.5 pointer-coarse:gap-3">
      {#if actions}{@render actions()}{/if}
      <IconButton icon="pencil-square" label={editLabel} size="sm" {disabled} onclick={onedit} />
      {#if onremove}<DropdownMenu label="Item actions" placement="bottom-end">
          {#snippet trigger(props)}<IconButton
              icon="ellipsis-horizontal"
              label="More actions"
              size="sm"
              {disabled}
              {...props}
            />{/snippet}
          <MenuItem icon="trash" danger {disabled} onselect={onremove}>{removeLabel}</MenuItem>
        </DropdownMenu>{/if}
    </div>
  </div>
  <div class="flex min-w-0 items-center gap-2 text-sm/5 text-muted">
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -- Keyboard focus reveals the full truncated metadata. -->
    <span tabindex="0" class="min-w-0 flex-1 truncate rounded-sm focus-ring" {@attach tooltip(meta)}>{meta}</span>
    {#if targets}<span class="shrink-0">{@render targets()}</span>{/if}
  </div>
</div>
