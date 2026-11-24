<script lang="ts">
  import { onDestroy, type Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Popover, { type PopoverTriggerProps } from "#lib/shared/ui/Popover.svelte";
  import type { FooterPopover } from "./footer-popovers.svelte.ts";

  let {
    panel,
    label,
    class: className,
    panelClass = "w-[min(18rem,calc(100vw-1rem))]",
    maxHeight,
    trigger: triggerButton,
    children,
  }: {
    panel: FooterPopover;
    label: string;
    class?: ClassValue;
    panelClass?: string;
    maxHeight?: string;
    trigger: Snippet<[PopoverTriggerProps]>;
    children: Snippet;
  } = $props();

  onDestroy(() => panel.close());
</script>

<div role="group" aria-label={label} onpointerenter={panel.enter} onpointerleave={panel.leave} class={className}>
  <Popover
    bind:open={panel.isOpen, panel.setOpen}
    {label}
    placement="top-start"
    sheet
    focusOnOpen={panel.pinned}
    {maxHeight}
    class={[panelClass, panel.superseded && "sidebar-footer-popover-superseded"]}
  >
    {#snippet trigger(props)}
      {@render triggerButton({ ...props, onclick: panel.press })}
    {/snippet}
    {@render children()}
  </Popover>
</div>
