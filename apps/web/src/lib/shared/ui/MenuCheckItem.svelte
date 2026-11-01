<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import { useMenu } from "./menu.ts";
  import { menuRowClasses } from "./MenuItem.svelte";

  /**
   * A choice in a `DropdownMenu` with a check mark: `type="radio"` (one of a group, closes the menu)
   * or `"checkbox"` (a toggle, keeps it open). The state is yours: update it in `onselect`.
   *
   *   <MenuCheckItem type="radio" checked={mode === m} description={m.hint} onselect={() => (mode = m)}>{m.label}</MenuCheckItem>
   */
  let {
    type = "radio",
    checked,
    description,
    disabled = false,
    keepOpen = type === "checkbox",
    onselect,
    class: className,
    children,
  }: {
    type?: "radio" | "checkbox";
    checked: boolean;
    description?: string | undefined;
    disabled?: boolean;
    keepOpen?: boolean;
    onselect: () => void;
    class?: ClassValue;
    children: Snippet;
  } = $props();

  const menu = useMenu();
  function choose() {
    if (disabled) return;
    onselect();
    if (!keepOpen) menu.closeAll();
  }
  function onpointermove(event: PointerEvent) {
    if (event.pointerType !== "mouse") return;
    menu.openSub = undefined;
    const item = event.currentTarget as HTMLElement;
    if (document.activeElement !== item) item.focus({ preventScroll: true });
  }
</script>

<button
  type="button"
  role={type === "radio" ? "menuitemradio" : "menuitemcheckbox"}
  aria-checked={checked}
  aria-disabled={disabled || undefined}
  tabindex="-1"
  data-menu-item
  class={[menuRowClasses, className]}
  onclick={choose}
  {onpointermove}
>
  <span class="grid min-w-0 flex-1">
    <span class="truncate">{@render children()}</span>
    {#if description}<span class="text-sm/5 text-zinc-500 sm:text-xs/4 dark:text-zinc-400">{description}</span>{/if}
  </span>
  <Icon name="check" class={["h-lh fill-brand-600 dark:fill-brand-400", !checked && "invisible"]} />
</button>
