<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue, HTMLAnchorAttributes } from "svelte/elements";
  import { buttonClasses, type ButtonSize, type ButtonVariant } from "./button.ts";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";

  /** A link that looks like a button (navigation, not an action). */
  type Props = Omit<HTMLAnchorAttributes, "class" | "children"> & {
    href: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    icon?: IconName;
    class?: ClassValue;
    children: Snippet;
  };

  let { variant = "secondary", size = "md", icon, class: className, children, ...rest }: Props = $props();
</script>

<a class={[buttonClasses(variant, size, Boolean(icon)), className]} {...rest}>
  {#if icon}<Icon name={icon} tone={variant === "primary" || variant === "danger" ? "inherit" : "muted"} />{/if}
  {@render children()}
</a>
