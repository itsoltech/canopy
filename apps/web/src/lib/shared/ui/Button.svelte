<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import { buttonClasses, defaultButtonSize, type ButtonSize, type ButtonVariant } from "./button.ts";
  import { useDensity } from "./density.ts";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import Spinner from "./Spinner.svelte";
  import TouchTarget from "./TouchTarget.svelte";

  type Props = Omit<HTMLButtonAttributes, "class" | "children"> & {
    variant?: ButtonVariant;
    /** Default: `md`, `sm` in an overlay (docs/ui-scale.md). */
    size?: ButtonSize;
    /** Leading icon; replaced by a spinner while `loading`. */
    icon?: IconName;
    loading?: boolean;
    class?: ClassValue;
    children: Snippet;
  };

  let {
    variant = "secondary",
    size: explicitSize,
    icon,
    loading = false,
    type = "button",
    disabled,
    class: className,
    children,
    ...rest
  }: Props = $props();

  const density = useDensity();
  const size = $derived(explicitSize ?? defaultButtonSize(density));
</script>

<button
  {type}
  class={[buttonClasses(variant, size, Boolean(icon || loading)), className]}
  disabled={disabled || loading}
  aria-busy={loading || undefined}
  {...rest}
>
  {#if loading}<Spinner />{:else if icon}<Icon
      name={icon}
      tone={variant === "primary" || variant === "danger" ? "inherit" : "muted"}
    />{/if}
  {@render children()}
  {#if size === "sm"}<TouchTarget />{/if}
</button>
