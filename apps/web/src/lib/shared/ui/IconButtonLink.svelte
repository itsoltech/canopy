<script lang="ts">
  import type { ClassValue, HTMLAnchorAttributes } from "svelte/elements";
  import { defaultButtonSize, iconButtonClasses, type ButtonSize, type ButtonVariant } from "./button.ts";
  import { useDensity } from "./density.ts";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import { tooltip } from "./tooltip.ts";
  import TouchTarget from "./TouchTarget.svelte";

  /** Icon-only link that looks like an `IconButton` (navigation, not an action). `label` names it and is its tooltip. */
  type Props = Omit<HTMLAnchorAttributes, "class" | "children"> & {
    href: string;
    icon: IconName;
    label: string;
    /** An empty string suppresses the tooltip while preserving the accessible name. */
    tooltipText?: string | undefined;
    variant?: ButtonVariant;
    /** Default: `md`, `sm` in an overlay (docs/ui-scale.md). */
    size?: ButtonSize;
    /** Icon colour (`text-*`). */
    iconClass?: ClassValue;
    class?: ClassValue;
  };

  let {
    icon,
    label,
    tooltipText,
    variant = "ghost",
    size: explicitSize,
    iconClass,
    class: className,
    ...rest
  }: Props = $props();

  const density = useDensity();
  const size = $derived(explicitSize ?? defaultButtonSize(density));
</script>

<a
  class={[iconButtonClasses(variant, size, density), "desktop:cursor-default", className]}
  aria-label={label}
  {...rest}
  {@attach tooltip(tooltipText ?? label)}
>
  <Icon name={icon} tone={variant === "primary" || variant === "danger" ? "inherit" : "muted"} class={iconClass} />
  <TouchTarget />
</a>
