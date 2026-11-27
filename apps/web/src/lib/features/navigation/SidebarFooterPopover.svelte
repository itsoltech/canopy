<script lang="ts" module>
  import type { Attachment } from "svelte/attachments";

  /** Spread on the trigger: it anchors the panel, and its click (which opens the full page) closes it. */
  export type FooterTriggerProps = Record<symbol, Attachment<HTMLElement>> & { onclick: () => void };
</script>

<script lang="ts">
  import { onDestroy, type Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Popover, { anchorOnly } from "#lib/shared/ui/Popover.svelte";
  import type { FooterPopover } from "./footer-popovers.svelte.ts";

  /**
   * A footer shortcut with a summary panel. The panel opens on mouse hover in a wider window; activating the
   * trigger goes to the full page, so touch and keyboard reach the same information there.
   */
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
    trigger: Snippet<[FooterTriggerProps]>;
    children: Snippet;
  } = $props();

  onDestroy(() => panel.close());
</script>

<div role="group" aria-label={label} onpointerenter={panel.enter} onpointerleave={panel.leave} class={className}>
  <Popover
    bind:open={panel.isOpen, panel.setOpen}
    {label}
    placement="top-start"
    focusOnOpen={false}
    morph={false}
    {maxHeight}
    class={[panelClass, panel.superseded && "sidebar-footer-popover-superseded"]}
  >
    {#snippet trigger(props)}
      {@render triggerButton({ ...anchorOnly(props), onclick: panel.close })}
    {/snippet}
    {@render children()}
  </Popover>
</div>
