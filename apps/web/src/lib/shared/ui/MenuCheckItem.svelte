<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue } from "svelte/elements";
  import Icon from "./Icon.svelte";
  import { hoverFocus, menuGlyphClasses, menuRowClasses, useMenu } from "./menu.ts";
  import MenuItemText from "./MenuItemText.svelte";
  import TouchTarget from "./TouchTarget.svelte";

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

  const onpointermove = hoverFocus(() => (menu.openSub = undefined));
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
  <MenuItemText {description}>{@render children()}</MenuItemText>
  <span class={menuGlyphClasses}
    ><Icon name="check" class={["text-brand-600 dark:text-brand-400", !checked && "invisible"]} /></span
  >
  <TouchTarget />
</button>
