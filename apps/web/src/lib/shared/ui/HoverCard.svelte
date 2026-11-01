<script lang="ts" module>
  import type { PopoverTriggerProps } from "./Popover.svelte";

  export interface HoverTriggerProps extends PopoverTriggerProps {
    readonly onpointerenter: (event: PointerEvent) => void;
    readonly onpointerleave: (event: PointerEvent) => void;
    readonly onfocus: (event: FocusEvent) => void;
    readonly onblur: () => void;
  }
</script>

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import type { Placement } from "./floating.ts";
  import Popover from "./Popover.svelte";

  /**
   * Preview card for a trigger: opens after hovering it (`openDelay`) or on keyboard focus, stays while
   * the pointer is over the card, closes shortly after leaving both. Touch screens have no hover, so a
   * tap toggles it (the trigger is a button); Escape and a click outside close it.
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
    class: className,
    trigger: renderTrigger,
    children,
  }: {
    label: string;
    placement?: Placement;
    openDelay?: number;
    closeDelay?: number;
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
  const enter = (event: PointerEvent) => {
    if (event.pointerType === "mouse") after(open ? 0 : openDelay, true);
  };
  const leave = (event: PointerEvent) => {
    if (event.pointerType === "mouse") after(closeDelay, false);
  };
  $effect(() => () => clearTimeout(timer));
</script>

<Popover bind:open {label} {placement} focusOnOpen={false} class={["w-72", className]}>
  {#snippet trigger(props)}
    {@render renderTrigger({
      ...props,
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
