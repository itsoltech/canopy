<script lang="ts" module>
  import type { Attachment } from "svelte/attachments";
  import type { PopoverTriggerProps } from "./Popover.svelte";

  /** What the trigger spreads: the popover's button props (`touch="tap"`) or only its anchor (`touch="press"`), plus hover and focus. */
  export interface HoverTriggerProps extends Partial<Omit<PopoverTriggerProps, symbol>> {
    readonly [key: symbol]: Attachment<HTMLElement>;
    readonly onpointerenter: (event: PointerEvent) => void;
    readonly onpointerleave: (event: PointerEvent) => void;
    readonly onfocus: (event: FocusEvent) => void;
    readonly onblur: () => void;
  }

  // Like tooltips: while one card is open, or just after it closed, the next opens without the delay
  // (hovering down a list moves the preview from row to row) and the previous closes at once.
  const WARM_MS = 400;
  let shown: { close: () => void } | undefined;
  let lastClosed = 0;
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import { createAttachmentKey } from "svelte/attachments";
  import type { Placement } from "./floating.ts";
  import { longPress } from "./long-press.ts";
  import Popover, { anchorOnly } from "./Popover.svelte";

  /**
   * Preview card for a trigger: opens after hovering it (`openDelay`, none while another card is open or just
   * closed) or on keyboard focus, stays while
   * the pointer is over the card, closes shortly after leaving both. Touch screens have no hover, so a
   * tap toggles it (the trigger is a button) or, with `touch="press"`, a tap-and-hold opens it and a tap
   * keeps doing what the trigger does (a link navigates; it gets no popup semantics). Escape and a click
   * outside close it. It never takes focus.
   * Keep it supplementary: what it shows must be reachable without it.
   *
   *   <HoverCard label="Worker details">
   *     {#snippet trigger(props)}<button type="button" {...props}>{worker.name}</button>{/snippet}
   *     …details…
   *   </HoverCard>
   */
  let {
    label,
    placement = "top-start",
    openDelay = 500,
    closeDelay = 200,
    touch = "tap",
    class: className,
    trigger: renderTrigger,
    children,
  }: {
    label: string;
    placement?: Placement;
    openDelay?: number;
    closeDelay?: number;
    /** tap: the trigger is a button that toggles the card; press: tap-and-hold opens it (links). */
    touch?: "tap" | "press";
    class?: ClassValue;
    trigger: Snippet<[HoverTriggerProps]>;
    children: Snippet;
  } = $props();

  let open = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const after = (ms: number, value: boolean) => {
    clearTimeout(timer);
    timer = setTimeout(() => (open = value), ms);
  };
  const self = {
    close: () => {
      clearTimeout(timer);
      open = false;
    },
  };
  $effect(() => {
    if (open) {
      if (shown !== self) shown?.close();
      shown = self;
    } else if (shown === self) {
      shown = undefined;
      lastClosed = Date.now();
    }
  });
  const enter = (event: PointerEvent) => {
    if (event.pointerType !== "mouse") return;
    const warm = open || (shown !== undefined && shown !== self) || Date.now() - lastClosed < WARM_MS;
    after(warm ? 0 : openDelay, true);
  };
  const leave = (event: PointerEvent) => {
    if (event.pointerType === "mouse") after(closeDelay, false);
  };
  $effect(() => () => {
    clearTimeout(timer);
    if (shown === self) shown = undefined;
  });
  const pressKey = createAttachmentKey();
  const press = longPress(() => after(0, true));
</script>

<Popover bind:open {label} {placement} focusOnOpen={false} class={["w-72", className]}>
  {#snippet trigger(props)}
    {@render renderTrigger({
      ...(touch === "press" ? { ...anchorOnly(props), [pressKey]: press } : props),
      onpointerenter: enter,
      onpointerleave: leave,
      onfocus: (event: FocusEvent) => {
        if ((event.currentTarget as HTMLElement).matches(":focus-visible")) after(0, true);
      },
      onblur: () => after(closeDelay, false),
    })}
  {/snippet}
  <div role="presentation" class="p-3" onpointerenter={enter} onpointerleave={leave} onfocusin={() => clearTimeout(timer)}>
    {@render children()}
  </div>
</Popover>
