<script lang="ts" module>
  import type { Attachment } from "svelte/attachments";

  /** Attributes the `trigger` snippet spreads on its button (`{...props}`). */
  export interface PopoverTriggerProps {
    readonly "aria-haspopup": "dialog" | "menu";
    readonly "aria-expanded": boolean;
    readonly "aria-controls": string;
    readonly onclick: (event: MouseEvent) => void;
    readonly onkeydown?: ((event: KeyboardEvent) => void) | undefined;
    readonly [key: symbol]: Attachment<HTMLElement>;
  }
</script>

<script lang="ts">
  import { tick, untrack, type Snippet } from "svelte";
  import { createAttachmentKey } from "svelte/attachments";
  import type { ClassValue } from "svelte/elements";
  import { autoPosition, focusables, type Placement } from "./floating.ts";

  /**
   * Anchored, non-modal popover in the top layer (Popover API, `popover="manual"`), positioned by
   * `floating.ts` (flips and shifts to stay on screen). Escape, a click outside and focus leaving it
   * close it. On open, focus goes to the first `[data-autofocus]` inside, else the first focusable
   * element, else the panel; on close it returns to the trigger. With `sheet` it is a bottom sheet on
   * phones. Content renders only while open.
   *
   *   <Popover bind:open label="Reasoning effort" placement="top-start">
   *     {#snippet trigger(props)}<button type="button" {...props}>Effort</button>{/snippet}
   *     …content…
   *   </Popover>
   *
   * Nest popovers (submenus) inside the content: a click in a child counts as inside the parent.
   */
  let {
    open = $bindable(false),
    label,
    placement = "bottom-start",
    offset = 6,
    role = "dialog",
    anchor: anchorElement,
    sheet = false,
    focusOnOpen = true,
    initialFocus,
    triggerKeydown,
    panelKeydown,
    onclose,
    class: className,
    trigger,
    children,
  }: {
    open?: boolean;
    /** Accessible name of the panel. */
    label: string;
    placement?: Placement;
    offset?: number;
    /** "none": the content brings its own role (a combobox's listbox). */
    role?: "dialog" | "menu" | "none";
    /** Anchor when there is no `trigger` snippet (a combobox's input). */
    anchor?: HTMLElement | undefined;
    /** Bottom sheet below `sm` (pickers with long lists). */
    sheet?: boolean;
    focusOnOpen?: boolean;
    /** Custom first focus (menus focus their first item); return false to fall back to the default. */
    initialFocus?: ((panel: HTMLElement) => boolean | void) | undefined;
    /** Extra key handling on the trigger (menus open on ArrowDown). */
    triggerKeydown?: ((event: KeyboardEvent) => void) | undefined;
    /** Key handling inside the panel, before Escape closes it (menu navigation). */
    panelKeydown?: ((event: KeyboardEvent) => void) | undefined;
    onclose?: (() => void) | undefined;
    class?: ClassValue;
    trigger?: Snippet<[PopoverTriggerProps]>;
    children: Snippet;
  } = $props();

  const id = $props.id();
  let panel = $state<HTMLElement>();
  let anchor = $state<HTMLElement>();
  let narrow = $state(false);
  let focusInside = false;

  const anchorKey = createAttachmentKey();
  const triggerProps = $derived<PopoverTriggerProps>({
    "aria-haspopup": role === "menu" ? "menu" : "dialog",
    "aria-expanded": open,
    "aria-controls": id,
    onclick: () => (open = !open),
    onkeydown: triggerKeydown,
    [anchorKey]: (node: HTMLElement) => {
      anchor = node;
      return () => {
        if (anchor === node) anchor = undefined;
      };
    },
  });

  $effect(() => {
    if (!sheet) return;
    const query = matchMedia("(max-width: 39.999rem)");
    const sync = () => (narrow = query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  });

  // Show and focus when opened; hide and return focus to the trigger when closed.
  $effect(() => {
    if (!panel) return;
    if (!open) {
      if (panel.matches(":popover-open")) {
        // Content unmounts before this runs, so "focus was inside" is tracked by focusin/focusout.
        const hadFocus = focusInside || panel.contains(document.activeElement);
        focusInside = false;
        panel.hidePopover();
        if (hadFocus && (document.activeElement === document.body || panel.contains(document.activeElement))) {
          untrack(() => anchorElement ?? anchor)?.focus({ preventScroll: true });
        }
        untrack(() => onclose)?.();
      }
      return;
    }
    if (!panel.matches(":popover-open")) panel.showPopover();
    const target = panel;
    untrack(() => {
      if (!focusOnOpen) return;
      void tick().then(() => {
        if (!open || initialFocus?.(target) === true) return;
        const first = target.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(target)[0] ?? target;
        first.focus({ preventScroll: true });
      });
    });
  });

  // Follow the anchor while open (a sheet sits at the bottom instead).
  $effect(() => {
    const target = anchorElement ?? anchor;
    if (!open || !panel || narrow || !target) return;
    return autoPosition(target, panel, { placement, offset });
  });

  // Light dismiss: pointer down outside the panel and its trigger.
  $effect(() => {
    if (!open) return;
    const onpointerdown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!panel || !target) return;
      if ((anchorElement ?? anchor)?.contains(target)) return;
      if (target === panel && narrow) {
        // The sheet's backdrop belongs to the panel element: close when the press is outside its box.
        const box = panel.getBoundingClientRect();
        if (event.clientY < box.top) open = false;
        return;
      }
      if (!panel.contains(target)) open = false;
    };
    document.addEventListener("pointerdown", onpointerdown, true);
    return () => document.removeEventListener("pointerdown", onpointerdown, true);
  });

  function onkeydown(event: KeyboardEvent) {
    panelKeydown?.(event);
    if (event.key === "Escape" && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      open = false;
    }
  }
  function onfocusout(event: FocusEvent) {
    const next = event.relatedTarget as Node | null;
    if (next && panel && !panel.contains(next)) {
      focusInside = false;
      if (!(anchorElement ?? anchor)?.contains(next)) open = false;
    }
  }
</script>

{@render trigger?.(triggerProps)}

<div
  bind:this={panel}
  {id}
  popover="manual"
  role={role === "none" ? undefined : role}
  aria-label={role === "none" ? undefined : label}
  tabindex="-1"
  data-sheet={narrow || undefined}
  data-menu-panel={role === "menu" || undefined}
  {onkeydown}
  {onfocusout}
  onfocusin={() => (focusInside = true)}
  class={[
    "fixed inset-auto top-(--float-y) left-(--float-x) m-0 max-h-[min(var(--float-available-height,32rem),32rem)] overflow-y-auto overscroll-contain rounded-xl border-0 bg-white p-0 text-zinc-950 shadow-lg ring-1 ring-zinc-950/10 outline-none dark:bg-zinc-900 dark:text-white dark:shadow-none dark:ring-white/10",
    "data-sheet:top-auto data-sheet:bottom-0 data-sheet:left-0 data-sheet:max-h-[85dvh] data-sheet:w-full data-sheet:max-w-none data-sheet:rounded-b-none data-sheet:pb-[env(safe-area-inset-bottom)] data-sheet:backdrop:bg-zinc-950/40 dark:data-sheet:backdrop:bg-black/60",
    className,
  ]}
>
  {#if open}{@render children()}{/if}
</div>
