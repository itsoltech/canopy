<script lang="ts">
  import type { Snippet } from "svelte";
  import type { ClassValue, HTMLButtonAttributes } from "svelte/elements";
  import { buttonClasses, type ButtonSize, type ButtonVariant } from "./button.ts";
  import Icon from "./Icon.svelte";
  import type { IconName } from "./icons.ts";
  import Spinner from "./Spinner.svelte";
  import TouchTarget from "./TouchTarget.svelte";

  type Props = Omit<HTMLButtonAttributes, "class" | "children"> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** Leading icon; replaced by a spinner while `loading`. */
    icon?: IconName;
    loading?: boolean;
    class?: ClassValue;
    children: Snippet;
  };

  let { variant = "secondary", size = "md", icon, loading = false, type = "button", disabled, class: className, children, ...rest }: Props = $props();
</script>

<button {type} class={[buttonClasses(variant, size, Boolean(icon || loading)), className]} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
  {#if loading}<Spinner />{:else if icon}<Icon name={icon} />{/if}
  {@render children()}
  {#if size === "sm"}<TouchTarget />{/if}
</button>
