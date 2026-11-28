<script lang="ts">
  import type { ClassValue } from "svelte/elements";
  import Icon from "#lib/shared/ui/Icon.svelte";
  import type { IconName } from "#lib/shared/ui/icons.ts";
  import Spinner from "#lib/shared/ui/Spinner.svelte";
  import { tooltip } from "#lib/shared/ui/tooltip.ts";
  import TouchTarget from "#lib/shared/ui/TouchTarget.svelte";

  let {
    label,
    ariaLabel,
    hint,
    hotkey,
    icon,
    split = false,
    sending = false,
    disabled = false,
    onclick,
    class: className,
  }: {
    label: string;
    ariaLabel?: string;
    hint?: string;
    hotkey?: string | undefined;
    icon: IconName;
    split?: boolean;
    sending?: boolean;
    disabled?: boolean;
    onclick?: (() => void) | undefined;
    class?: ClassValue;
  } = $props();
</script>

<button
  type={onclick ? "button" : "submit"}
  class={[
    "relative flex h-(--button-height) shrink-0 items-center gap-1.5 text-sm/5 font-medium focus-ring [--button-height:--spacing(9)] not-disabled:hover:bg-action-hover disabled:opacity-60 sm:text-[0.8125rem]/5 sm:[--button-height:var(--control-chrome)]",
    split ? "rounded-l-full pr-2.5 pl-3" : "optical-alignment rounded-full bg-action text-on-accent",
    className,
  ]}
  aria-label={ariaLabel}
  {@attach hint ? tooltip(hint, { hotkey }) : undefined}
  disabled={disabled || sending}
  {onclick}
>
  {#if sending}<Spinner />{:else}<Icon name={icon} tone="inherit" />{/if}
  <span class={["label", split && "@max-[24rem]/composer:hidden"]}>{label}</span>
  <TouchTarget />
</button>

<style>
  .optical-alignment {
    --radius: calc(var(--button-height) / 2);
    padding-inline-start: calc(var(--radius) - var(--icon-standard) / 2);
    /* A semicircle removes an average width of r × (1 − π/4) from the text end. */
    padding-inline-end: calc(2.5 * var(--spacing) + var(--radius) * (1 - pi / 4));
  }

  .optical-alignment > .label {
    text-box: trim-both cap alphabetic;
  }
</style>
