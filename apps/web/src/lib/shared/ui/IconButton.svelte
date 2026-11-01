<script lang="ts">
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import { iconButtonClasses, type ButtonSize, type ButtonVariant } from "./button.ts";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import { tooltip } from "./tooltip.ts";
  import TouchTarget from "./TouchTarget.svelte";

  /** Icon-only button. `label` is required: it is the accessible name and the tooltip. Spread popover trigger props on it to open a menu. */
  type Props = Omit<HTMLButtonAttributes, "class" | "children"> & {
    icon: IconName;
    label: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** Icon colour (`fill-*`), e.g. a filled star. */
    iconClass?: ClassValue;
    class?: ClassValue;
  };

  let { icon, label, variant = "ghost", size = "md", type = "button", iconClass, class: className, ...rest }: Props = $props();
</script>

<button {type} class={[iconButtonClasses(variant, size), className]} aria-label={label} {...rest} {@attach tooltip(label)}>
  <Icon name={icon} class={iconClass} />
  <TouchTarget />
</button>
