<script lang="ts">
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import { defaultButtonSize, iconButtonClasses, type ButtonSize, type ButtonVariant } from "./button.ts";
  import { useDensity } from "./density.ts";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import Spinner from "./Spinner.svelte";
  import { tooltip, type TooltipOptions } from "./tooltip.ts";
  import TouchTarget from "./TouchTarget.svelte";

  /** Icon-only button. `label` is required: it is the accessible name and the tooltip. Spread popover trigger props on it to open a menu. */
  type Props = Omit<HTMLButtonAttributes, "class" | "children"> & {
    icon: IconName;
    label: string;
    variant?: ButtonVariant;
    /** Default: `md`, `sm` in an overlay (docs/ui-scale.md). */
    size?: ButtonSize;
    /** Replaces the icon with a spinner and disables the button (an action in progress). */
    loading?: boolean;
    /** Icon colour (`text-*`), e.g. an amber star. */
    iconClass?: ClassValue;
    /** Tooltip placement, shortcut hint, … */
    tooltipOptions?: TooltipOptions;
    /** Override the tooltip; empty when an enclosing element supplies a disabled reason. */
    tooltipText?: string;
    "aria-description"?: string | undefined;
    class?: ClassValue;
  };

  let {
    icon,
    label,
    variant = "ghost",
    size: explicitSize,
    type = "button",
    loading = false,
    disabled,
    iconClass,
    tooltipOptions,
    tooltipText,
    class: className,
    ...rest
  }: Props = $props();

  const density = useDensity();
  const size = $derived(explicitSize ?? defaultButtonSize(density));
</script>

<button
  {type}
  class={[iconButtonClasses(variant, size, density), className]}
  aria-label={label}
  disabled={disabled || loading}
  aria-busy={loading || undefined}
  {...rest}
  {@attach tooltip(tooltipText ?? label, tooltipOptions)}
>
  {#if loading}<Spinner />{:else}<Icon
      name={icon}
      tone={variant === "primary" || variant === "danger" ? "inherit" : "muted"}
      class={iconClass}
    />{/if}
  <TouchTarget />
</button>
