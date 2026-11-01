<script lang="ts">
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import { iconButtonClasses, type ButtonSize, type ButtonVariant } from "./button.ts";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import TouchTarget from "./TouchTarget.svelte";

  /** Icon-only button. `label` is required: it is the accessible name and the tooltip. */
  type Props = Omit<HTMLButtonAttributes, "class" | "children"> & {
    icon: IconName;
    label: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    class?: ClassValue;
  };

  let { icon, label, variant = "ghost", size = "md", type = "button", class: className, ...rest }: Props = $props();
</script>

<button {type} class={[iconButtonClasses(variant, size), className]} aria-label={label} title={label} {...rest}>
  <Icon name={icon} />
  <TouchTarget />
</button>
